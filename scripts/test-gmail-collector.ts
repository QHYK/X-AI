import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { collectGmailNewsletters } from '../src/collectors/gmail/collector.js';
import { processStoredEmail, saveFetchedEmail } from '../src/collectors/gmail/email-store.js';
import { newsletterStore } from './fixtures/newsletter-store.js';
import { GMAIL_BASELINE } from './fixtures/gmail-baseline.js';
import { parseGmailOptions } from './collect-gmail.js';
const store = newsletterStore(),
  options = { query: 'label:news-letter newer_than:3d', limit: 20, now: new Date() };
const samples = new Map<string, Awaited<ReturnType<typeof JSON.parse>>>();
for (const [, id] of GMAIL_BASELINE)
  samples.set(id, JSON.parse(await readFile(`runtime/spikes/gmail/raw/${id}.json`, 'utf8')));
options.now = new Date(
  Math.max(...[...samples.values()].map((s) => Number(s.internalDate))) + 1000,
);
const reader = {
  list: async () => ({ messages: [...samples.keys()].map((id) => ({ id })) }),
  get: async (id: string) => samples.get(id),
};
const [first, concurrent] = await Promise.all([
  collectGmailNewsletters(store.pool, reader, options),
  collectGmailNewsletters(store.pool, reader, options),
]);
assert.equal(first.inserted + concurrent.inserted, 39);
assert.equal(store.emails.size, 7);
assert.equal(store.raws.length, 39);
assert.equal((await collectGmailNewsletters(store.pool, reader, options)).inserted, 0);
const distribution: Record<string, number> = {};
for (const r of store.raws) {
  const type = (r.metadata.newsletter as { content_type: string }).content_type;
  distribution[type] = (distribution[type] ?? 0) + 1;
}
assert.deepEqual(distribution, { standalone_content: 28, non_content: 1, external_reference: 10 });
assert.equal(store.raws.filter((r) => r.url === null).length, 10);
// Persist first, then fail independently. Malformed/unknown/zero-unit mail remains inspectable.
const base = structuredClone(samples.values().next().value!);
const unknown = {
  ...base,
  id: 'unknown',
  payload: {
    mimeType: 'text/html',
    headers: [{ name: 'From', value: 'Unknown <x@example.org>' }],
    body: { data: Buffer.from('<p>Unsupported source</p>').toString('base64url') },
  },
};
const bad = { ...base, id: 'badmime', payload: { mimeType: 'text/html', body: { data: '%%%' } } };
const zero = {
  ...base,
  id: 'zero',
  payload: {
    mimeType: 'text/html',
    headers: base.payload.headers.filter(
      (h: { name: string }) => h.name.toLowerCase() !== 'content-type',
    ),
    body: { data: Buffer.from('<p>Unrecognized new template</p>').toString('base64url') },
  },
};
const invalid = { id: 'invalid_mime', internalDate: base.internalDate, payload: null };
for (const raw of [unknown, bad, zero, invalid]) {
  const report = await collectGmailNewsletters(
    store.pool,
    { list: async () => ({ messages: [{ id: raw.id }] }), get: async () => raw },
    options,
  );
  assert.equal(report.savedEmails, 1);
  assert.ok(store.emails.has(raw.id));
  assert.equal(store.emails.get(raw.id)!.parse_status, 'unsupported');
  assert.ok(store.emails.get(raw.id)!.error_message);
  if (raw === unknown || raw === zero) {
    assert.equal(
      report.warnings.filter((w) => w.gmail_message_id === raw.id).length,
      1,
      JSON.stringify({ id: raw.id, warnings: report.warnings, failures: report.failures }),
    );
    assert.equal(report.failures.filter((f) => f.id === raw.id).length, 0);
  } else {
    assert.equal(report.warnings.filter((w) => w.gmail_message_id === raw.id).length, 0);
    assert.ok(
      report.failures.some((f) => f.id === raw.id),
      'MIME failure must not be demoted',
    );
  }
}
const noRaw = store.raws.length;
// Reparse stored data, without Gmail. A repaired MIME/parser output is enough to resume.
store.emails.get('zero')!.raw_message = { ...base, id: 'zero' };
assert.equal((await processStoredEmail(store.pool, 'zero')).status, 'success');
assert.ok(store.raws.length > noRaw);
const id = GMAIL_BASELINE[0][1],
  e = store.emails.get(id)!;
e.parser_version = 999;
assert.equal(
  (await processStoredEmail(store.pool, id)).inserted,
  0,
  'Version number alone is not a conflict',
);
const originalRaw = structuredClone(store.raws),
  originalEmail = structuredClone(e.raw_message);
store.emails.get(id)!.parse_status = 'unsupported';
store.emails.get(id)!.imported_at = null;
store.emails.get(id)!.raw_message = {
  ...base,
  id,
  payload: {
    mimeType: 'text/html',
    headers: base.payload.headers,
    body: { data: Buffer.from('<p>Unknown template now</p>').toString('base64url') },
  },
};
const checked = await processStoredEmail(store.pool, id);
assert.equal(
  checked.status,
  'conflict',
  JSON.stringify({ checked, expectedState: store.emails.get(id)?.parse_status }),
);
assert.deepEqual(store.raws, originalRaw);
store.emails.get(id)!.raw_message = originalEmail;
store.emails.get(id)!.parse_status = 'unsupported';
store.raws[0].title += ' manually changed';
assert.equal((await processStoredEmail(store.pool, id)).status, 'conflict');
assert.equal(store.raws.length, originalRaw.length);
const failMail = { ...base, id: 'write_failure' };
await saveFetchedEmail(store.pool, failMail.id, failMail);
store.setFailRaw(true);
const before = store.raws.length;
assert.equal((await processStoredEmail(store.pool, failMail.id)).status, 'failed');
assert.equal(store.raws.length, before);
assert.deepEqual(store.emails.get(failMail.id)!.module_mapping, []);
assert.equal(store.emails.get(failMail.id)!.error_stage, 'persist');
store.setFailRaw(false);
assert.equal((await processStoredEmail(store.pool, failMail.id)).status, 'success');
const q = store.queries;
await collectGmailNewsletters(store.pool, reader, { ...options, dryRun: true });
assert.equal(store.queries, q, 'Dry-run performs zero database queries/writes');
const saved = structuredClone(store.emails.get(id)!.raw_message);
await saveFetchedEmail(store.pool, id, { ...base, id });
assert.deepEqual(store.emails.get(id)!.raw_message, saved, 'Original fetch is immutable');
assert.equal(parseGmailOptions([]).limit, 20);
for (const args of [
  ['--query', ''],
  ['--limit', '0'],
])
  assert.throws(() => parseGmailOptions(args));

// Rolling window is based on received_at, including the exact lower boundary.
const windowStore = newsletterStore();
const now = new Date('2026-11-10T12:00:00Z');
const within = (id: string, received: number) => ({ ...base, id, internalDate: String(received) });
const cases = [
  within('boundary', now.getTime() - 72 * 3600000),
  within('too_old', now.getTime() - 72 * 3600000 - 1),
  within('future', now.getTime() + 1),
  within('retry_current', now.getTime() - 1000),
];
for (const raw of cases) await saveFetchedEmail(windowStore.pool, raw.id, raw);
windowStore.emails.get('retry_current')!.parse_status = 'unsupported';
// collected_at is recent for all records and must not rescue too_old.
let usedQuery = '';
const emptyReader = {
  list: async (q: string) => {
    usedQuery = q;
    return { messages: [] };
  },
  get: async () => {
    throw new Error('No Gmail details expected');
  },
};
const run = () => collectGmailNewsletters(windowStore.pool, emptyReader, { ...options, now });
const resumed = await run();
assert.equal(windowStore.emails.get('boundary')!.parse_status, 'success');
assert.equal(windowStore.emails.get('retry_current')!.parse_status, 'success');
assert.equal(windowStore.emails.get('too_old')!.parse_status, 'collected');
assert.equal(windowStore.emails.get('future')!.parse_status, 'collected');
assert.equal(resumed.retried, 2);
assert.match(usedQuery, /after:\d+ before:\d+/);
assert.equal((await run()).retried, 0);
assert.equal(
  (await processStoredEmail(windowStore.pool, 'too_old')).status,
  'success',
  'Explicit Message ID processes older failures',
);
const conflictId = 'paused';
await saveFetchedEmail(windowStore.pool, conflictId, within(conflictId, now.getTime() - 1000));
windowStore.emails.get(conflictId)!.parse_status = 'conflict';
assert.equal((await run()).retried, 0);
assert.equal((await processStoredEmail(windowStore.pool, conflictId)).status, 'conflict');
const failedId = 'retry_failed';
await saveFetchedEmail(windowStore.pool, failedId, within(failedId, now.getTime() - 1000));
windowStore.emails.get(failedId)!.parse_status = 'failed';
assert.equal((await run()).inserted > 0, true);
// Existing rule explicitly allows subscription ads to have zero units.
const ad = {
  ...within('allowed_ad', now.getTime() - 1000),
  payload: {
    mimeType: 'text/html',
    headers: [{ name: 'From', value: 'The Information <hello@theinformation.com>' }],
    body: { data: Buffer.from('<h2>Annual Subscription</h2><p>Offer</p>').toString('base64url') },
  },
};
await saveFetchedEmail(windowStore.pool, ad.id, ad);
await run();
assert.equal(windowStore.emails.get(ad.id)!.parse_status, 'skipped');
assert.equal(windowStore.emails.get(ad.id)!.module_mapping.length, 0);
assert.equal((await run()).retried, 0);
// A later module failure and a success-marker failure both roll back every Raw insert.
for (const failure of ['second_module', 'success_marker']) {
  const id = `atomic_${failure}`;
  await saveFetchedEmail(windowStore.pool, id, within(id, now.getTime() - 1000));
  const before = windowStore.raws.length;
  if (failure === 'second_module') windowStore.failAfter(1);
  else windowStore.failSuccess(true);
  assert.equal((await processStoredEmail(windowStore.pool, id)).status, 'failed');
  assert.equal(windowStore.raws.length, before);
  assert.deepEqual(windowStore.emails.get(id)!.module_mapping, []);
  assert.equal(windowStore.emails.get(id)!.imported_at, null);
  windowStore.failAfter(null);
  windowStore.failSuccess(false);
  assert.equal((await processStoredEmail(windowStore.pool, id)).status, 'success');
}
const labelled = await collectGmailNewsletters(
  windowStore.pool,
  { ...emptyReader, labels: async () => [{ id: 'label-id', name: 'News Letter' }] },
  { ...options, now, dryRun: true },
);
assert.match(labelled.query, /label:"News Letter"/);
// Enforce the source boundary on actual Import/Export AST nodes, not comments or sample filesystem paths.
async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (e.isDirectory()) result.push(...(await files(root + '/' + e.name)));
    else if (/\.tsx?$/.test(e.name)) result.push(root + '/' + e.name);
  }
  return result;
}
for (const file of [...(await files('src')), ...(await files('scripts'))]) {
  const ast = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function walk(n: ts.Node) {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      const v = n.moduleSpecifier.text;
      if (v.startsWith('.'))
        assert.ok(!resolve(file, '..', v).includes('/spikes/'), `${file} imports Spike ${v}`);
    }
    if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      const v = n.arguments[0].text;
      if (v.startsWith('.')) assert.ok(!resolve(file, '..', v).includes('/spikes/'));
    }
    ts.forEachChild(n, walk);
  }
  walk(ast);
}
console.log(
  'PASS durable-first collection, seven-mail/39-unit regression, Mock concurrency/idempotence, unsupported/conflict separation, offline reparse, failed-Raw rollback, immutable original MIME and zero-query dry-run.',
);
