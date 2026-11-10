import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { createReviewServer } from './review-server.js';
const root = await realpath(await mkdtemp(join(tmpdir(), 'parser-ui-')));
let browser: JSDOM | undefined;
const { server, store } = await createReviewServer(root);
try {
  await mkdir(join(root, 'parsed'));
  for (let i = 1; i <= 7; i++)
    await writeFile(
      join(root, 'parsed', `mail${i}.json`),
      JSON.stringify({
        gmailMessageId: `mail${i}`,
        from: [{ name: 'Superhuman' }],
        subject: `Sample ${i}`,
        receivedAt: `2026-11-0${i}T10:00:00Z`,
        html:
          '<h5>TUTORIAL</h5><h2>Test workflow guide</h2><p>' +
          'Synthetic instruction with enough detail for testing. '.repeat(5) +
          '<a href="https://example.test/linked-article">Full original reference</a>' +
          '</p><h5>PROMPT STATION</h5><h5>IMAGE</h5>',
      }),
    );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;
  const page = await (await fetch(origin)).text();
  browser = new JSDOM(page, { url: origin, runScripts: 'outside-only' });
  const win = browser.window;
  let refuseSave = false;
  win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (refuseSave && init?.method === 'PUT')
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'Synthetic save conflict' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const url = new URL(String(input), origin);
    assert.equal(url.origin, origin);
    return fetch(url, { ...init, headers: { ...init?.headers, Origin: origin } });
  };
  win.confirm = () => true;
  Object.assign(win, { exports: {} });
  win.eval(
    ts.transpileModule(await readFile(new URL('./review-client.ts', import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
  );
  async function wait(check: () => boolean) {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('UI wait timeout');
  }
  const $ = (id: string) => win.document.getElementById(id)!;
  await wait(() => !!$('progress').textContent);
  const select = $('message') as HTMLSelectElement;
  assert.equal(select.options.length, 5);
  assert.equal(select.value, 'mail7');
  assert.equal($('units').querySelectorAll('button').length, 1, 'Source selections auto-loaded');
  let locateClicks = 0;
  $('locate').addEventListener('click', () => locateClicks++);
  $('units').querySelector('button')!.click();
  assert.equal(
    locateClicks,
    1,
    'Selecting a content unit also triggers the existing locate action',
  );
  assert.equal(win.document.getElementById('selected-only'), null);
  assert.doesNotMatch($('units').textContent!, /OBSOLETE HEURISTIC SPLIT/);
  assert.equal('candidates' in (await store.detail('mail7')), false);
  assert.match($('notice').textContent!, /已默认载入来源预选/);
  const all = $('all-history') as HTMLInputElement;
  all.checked = true;
  all.dispatchEvent(new win.Event('change'));
  assert.equal(select.options.length, 7);
  select.value = 'mail1';
  select.dispatchEvent(new win.Event('change'));
  await wait(() => $('metadata').textContent!.includes('mail1'));
  const linkPicker = Array.from($('editor').querySelectorAll('label'))
    .find((l) => l.firstChild?.textContent?.startsWith('区域内链接'))!
    .querySelector('select')!;
  assert.equal(linkPicker.options.length, 2);
  linkPicker.value = 'https://example.test/linked-article';
  linkPicker.dispatchEvent(new win.Event('change'));
  const titleField = Array.from($('editor').querySelectorAll('label'))
    .find((e) => e.firstChild?.textContent === '人工 Title')!
    .querySelector('textarea,input') as HTMLInputElement;
  titleField.value = 'Human edited title';
  titleField.dispatchEvent(new win.Event('input'));

  refuseSave = true;
  ($('save') as HTMLButtonElement).click();
  await wait(() => $('save-status').textContent === 'Synthetic save conflict');
  assert.equal(titleField.value, 'Human edited title', 'Failed saves retain the edited text');
  refuseSave = false;
  ($('save') as HTMLButtonElement).click();
  await wait(() => $('save-status').textContent === '已保存');
  assert.equal(
    (await store.detail('mail1')).annotations!.added_units[0].corrections.title,
    'Human edited title',
  );
  assert.equal((await store.detail('mail1')).guidance.units[0].title, 'Sample 1');
  assert.equal(
    (await store.detail('mail1')).annotations!.added_units[0].corrections.original_url,
    'https://example.test/linked-article',
  );
  select.value = 'mail7';
  select.dispatchEvent(new win.Event('change'));
  await wait(() => $('metadata').textContent!.includes('mail7'));
  select.value = 'mail1';
  select.dispatchEvent(new win.Event('change'));
  await wait(() => $('metadata').textContent!.includes('mail1'));
  assert.match($('units').textContent!, /Human edited title/);
  console.log(
    'PASS source-only UI automatic loading, latest five/all history, old/new switching, save/reload, human/parser separation',
  );
} finally {
  browser?.window.close();
  await new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });
  await rm(root, { recursive: true, force: true });
}
