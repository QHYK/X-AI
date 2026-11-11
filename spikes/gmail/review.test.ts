import assert from 'node:assert/strict';
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { JSDOM, requestInterceptor, VirtualConsole } from 'jsdom';
import { createPreview, digest } from '../../src/collectors/gmail/preview.js';
import { createReviewStore, type EditableUnit } from './review-data.js';
import { createReviewServer } from './review-server.js';
const html = `<html><head><style>@import url('https://never.test/css');p{background-image:url(https://never.test/image);color:navy}</style></head><body><script>window.pwned=1</script><p hidden>Hidden</p><h5>TUTORIAL</h5><h2>A synthetic workflow guide</h2><table><tr><td><p>${'Original synthetic evidence and instructions. '.repeat(6)}</p><p>A second original paragraph.</p><img src="https://never.test/pixel" onerror="window.pwned=2"></td></tr></table><h5>PROMPT STATION</h5><form action="https://never.test/post"><input></form><iframe src="https://never.test/frame"></iframe></body></html>`;
const preview = createPreview(html);
assert.deepEqual(preview, createPreview(html));
assert.equal(preview.html_sha256, digest(html));
assert.ok(preview.blocks.every((b) => b.start_offset !== null && b.end_offset !== null));
assert.match(preview.html, /script-src 'none'/);
let remote = 0;
const safe = new JSDOM(preview.html, {
  runScripts: 'dangerously',
  resources: {
    interceptors: [
      requestInterceptor(() => {
        remote++;
        return new Response('', { status: 403 });
      }),
    ],
  },
  virtualConsole: new VirtualConsole(),
});
assert.equal(safe.window.pwned, undefined);
assert.equal(
  safe.window.document.querySelectorAll('script,img,iframe,form,input,[href],[src],[onclick]')
    .length,
  0,
);
assert.doesNotMatch(preview.html, /url\s*\(|@import/);
assert.equal(safe.window.document.querySelector('table')?.tagName, 'TABLE');
safe.window.close();
assert.equal(remote, 0);
console.log(
  'PASS sandbox preview, zero remote resources, stable original HTML offsets and table layout',
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'source-review-')));
let server: Awaited<ReturnType<typeof createReviewServer>>['server'] | undefined;
try {
  await mkdir(join(root, 'parsed'));
  await writeFile(
    join(root, 'parsed', 'mail1.json'),
    JSON.stringify({ gmailMessageId: 'mail1', from: [{ name: 'Superhuman' }], html }),
  );
  const store = createReviewStore(root),
    detail = await store.detail('mail1'),
    proposal = detail.guidance.units[0];
  assert.equal(detail.guidance.units.length, 1);
  assert.equal('candidates' in detail, false);
  const unit: EditableUnit = {
    manual_id: proposal.id,
    status: 'accepted',
    content_type: 'standalone_content',
    corrections: { title: proposal.title },
    boundary: proposal.boundary,
    text_evidence: '',
    notes: 'Human note',
  };
  const body = { revision: null, baseline: detail.baseline, added_units: [unit] };
  const saved = await store.save('mail1', body);
  assert.equal(saved.value!.added_units[0].source_guidance?.review_label, proposal.review_label);
  assert.ok(saved.value!.added_units[0].boundary_references);
  assert.equal('candidate_snapshot' in saved.value!, false);
  assert.equal('candidates' in saved.value!, false);
  assert.deepEqual((await store.detail('mail1')).annotations, saved.value);
  await assert.rejects(store.save('mail1', body), /其他页面保存/);
  const current = await store.detail('mail1');
  const next = { ...body, revision: current.revision };
  await assert.rejects(
    store.save('mail1', { ...next, added_units: [{ ...unit, content_type: null }] }),
    /内容类型/,
  );
  await assert.rejects(
    store.save('mail1', {
      ...next,
      added_units: [{ ...unit, boundary: null, text_evidence: 'invented evidence' }],
    }),
    /未在邮件中找到/,
  );
  await assert.rejects(
    store.save('mail1', {
      ...next,
      added_units: [{ ...unit, boundary: { start_node_id: 'n999', end_node_id: 'n999' } }],
    }),
    /边界不存在/,
  );
  const manual: EditableUnit = {
    ...unit,
    manual_id: randomUUID(),
    corrections: { title: 'Human-added content' },
    boundary: null,
    text_evidence: 'A second original paragraph.',
  };
  await store.save('mail1', { ...next, added_units: [unit, manual] });
  assert.equal((await store.detail('mail1')).annotations!.added_units.length, 2);
  assert.deepEqual(
    (await store.detail('mail1')).guidance,
    detail.guidance,
    'Human corrections do not change source selection',
  );
  assert.deepEqual(await readdir(join(root, 'annotations')), ['mail1.json']);
  await symlink(join(root, 'parsed', 'mail1.json'), join(root, 'parsed', 'bad.json'));
  await assert.rejects(store.detail('bad'), /不是允许/);
  await rm(join(root, 'parsed', 'bad.json'));
  await assert.rejects(store.detail('../secret'), /非法 Message ID/);
  // Read prior annotations without rewriting them; new saves belong to the current spike directory.
  const oldText = await readFile(join(root, 'annotations', 'mail1.json'), 'utf8');
  const migrated = createReviewStore(root, {
    annotationRoot: join(root, 'current-annotations'),
    annotationFallbackRoot: join(root, 'annotations'),
  });
  const prior = await migrated.detail('mail1');
  assert.equal(
    prior.annotations!.added_units.length,
    1,
    'Previous review contributes only source-guided units',
  );
  assert.equal(prior.revision, digest(oldText));
  await migrated.save('mail1', {
    baseline: prior.baseline,
    revision: prior.revision,
    added_units: [unit, manual],
  });
  assert.equal(await readFile(join(root, 'annotations', 'mail1.json'), 'utf8'), oldText);
  assert.ok((await migrated.detail('mail1')).annotations);
  console.log(
    'PASS source-only storage, save/reload, input validation, revision conflicts, manual additions, annotation fallback and traversal denial',
  );
  ({ server } = await createReviewServer(root));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const page = await (await fetch(origin)).text();
  assert.doesNotMatch(page, /selected-only|隐藏未审核|Parser Output/);
  const token = /name="review-token" content="([a-f0-9]+)"/.exec(page)![1];
  const headers = { 'X-Review-Token': token };
  assert.equal((await fetch(origin + '/api/messages')).status, 403);
  assert.equal(
    (
      await fetch(origin + '/api/messages', {
        headers: { ...headers, Origin: 'https://foreign.test' },
      })
    ).status,
    403,
  );
  const hostStatus = await new Promise<number>((resolve, reject) => {
    const req = request(
      origin + '/api/messages',
      { headers: { ...headers, Host: 'foreign.test' } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(origin + '/api/messages/..%2fsecret', { headers })).status, 404);
  assert.equal(
    (
      await fetch(origin + '/api/annotations/mail1', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  const writes = { ...headers, Origin: origin, 'Content-Type': 'application/json' };
  assert.equal(
    (
      await fetch(origin + '/api/annotations/mail1', {
        method: 'PUT',
        headers: writes,
        body: 'x'.repeat(2 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (await fetch(origin + '/api/annotations/mail1', { method: 'PUT', headers: writes, body: '{' }))
      .status,
    400,
  );
  const records = await (await fetch(origin + '/api/messages', { headers })).json();
  assert.equal(records[0].unit_count, 1);
  console.log(
    'PASS loopback/Host/Origin/token protection, body limits, safe file paths and source-only UI',
  );
} finally {
  if (server)
    await new Promise<void>((r) => {
      server!.closeAllConnections();
      server!.close(() => r());
    });
  await rm(root, { recursive: true, force: true });
}
