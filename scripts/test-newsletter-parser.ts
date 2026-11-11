import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { newsletterStore } from './fixtures/newsletter-store.js';
import { GMAIL_BASELINE } from './fixtures/gmail-baseline.js';
import { saveFetchedEmail, processStoredEmail } from '../src/collectors/gmail/email-store.js';
import { serveNewsletterParser } from '../src/lib/newsletter-parser.js';
import {
  exportNewsletterAnnotation,
  importNewsletterAnnotation,
  defaultNewsletterReview,
  readNewsletterEmailReview,
} from '../src/lib/newsletter-review-contracts.js';
const store = newsletterStore();
const deps = { authenticate: async () => null, database: () => store.pool };
const request = (q = '') => new Request('http://localhost:3000/ai/api/admin/newsletter-parser' + q);
for (const [source, id, count] of GMAIL_BASELINE) {
  const raw = JSON.parse(await readFile(`runtime/spikes/gmail/raw/${id}.json`, 'utf8'));
  await saveFetchedEmail(store.pool, id, raw);
  await processStoredEmail(store.pool, id);
  const response = await serveNewsletterParser(request(`?id=${id}`), deps);
  assert.equal(response.status, 200);
  const d = await response.json();
  assert.equal(d.source, source);
  assert.equal(d.units.length, count);
  if (source === 'Superhuman') assert.equal(d.template, 'superhuman:daily_h5');
  assert.equal(d.differsFromImported, false);
  assert.ok(!('raw_message' in d));
  assert.ok(!('payload' in d));
  const dom = new JSDOM(d.html);
  assert.equal(
    dom.window.document.querySelectorAll('script,iframe,form,img,[href],[src],[srcset],[onclick]')
      .length,
    0,
  );
  dom.window.close();
  const units = defaultNewsletterReview(d.units);
  units[0].status = 'accepted';
  const file = exportNewsletterAnnotation(d, units);
  assert.equal(file.schema_version, 1);
  assert.equal(file.added_units[0].manual_id, units[0].id);
  assert.ok(file.added_units[0].boundary_references?.start.node_path);
  assert.deepEqual(importNewsletterAnnotation(d, file), units);
  assert.throws(() => importNewsletterAnnotation({ ...d, html_sha256: 'bad' }, file), /不匹配/);
}
assert.equal(store.raws.length, 39);
assert.equal((await serveNewsletterParser(request('?id=../secret'), deps)).status, 400);
assert.equal((await serveNewsletterParser(request('?status=invalid'), deps)).status, 400);
assert.equal((await serveNewsletterParser(request('?id=missing'), deps)).status, 404);
let created = false;
assert.equal(
  (
    await serveNewsletterParser(request(), {
      authenticate: async () => Response.json({}, { status: 401 }),
      database: () => {
        created = true;
        return store.pool;
      },
    })
  ).status,
  401,
);
assert.equal(created, false);
const id = GMAIL_BASELINE[0][1];
store.emails.get(id)!.parse_status = 'conflict';
store.raws[0].title = 'Changed downstream';
const conflict = await (await serveNewsletterParser(request(`?id=${id}`), deps)).json();
assert.equal(conflict.units.length, 4, 'Preview remains available during conflict');
assert.equal(conflict.differsFromImported, true);
const list = await (await serveNewsletterParser(request('?status=conflict'), deps)).json();
assert.equal(list.items.length, 1);
assert.equal(list.items[0].status, 'conflict');
assert.ok(!('raw_message' in list.items[0]));
const route = await readFile('src/app/api/admin/newsletter-parser/route.ts', 'utf8');
assert.match(route, /adminApiError/);
assert.ok(!/export async function (POST|PUT|DELETE|PATCH)/.test(route));
assert.ok(!route.includes('adminGmailReader'));
console.log(
  'PASS database-only Admin API, seven-source/39-unit parity, status filters, immutable Raw, conflict-independent preview, HTML isolation, protected API and Spike-v1 annotation roundtrip.',
);

// Unsupported and MIME failures remain readable from the saved collection table.
const raw = structuredClone(store.emails.get(id)!.raw_message);
for (const status of ['unsupported', 'failed'] as const) {
  const key = `saved_${status}`;
  await saveFetchedEmail(store.pool, key, { ...raw, id: key });
  store.emails.get(key)!.parse_status = status;
  store.emails.get(key)!.error_stage = status === 'failed' ? 'persist' : 'parse';
  store.emails.get(key)!.error_message = 'Recorded failure';
  if (status === 'unsupported')
    store.emails.get(key)!.raw_message.payload = {
      mimeType: 'text/html',
      body: {
        data: Buffer.from('<p>Inspect this unsupported newsletter</p>').toString('base64url'),
      },
    };
  const d = await (await serveNewsletterParser(request(`?id=${key}`), deps)).json();
  assert.equal(d.status, status);
  assert.match(d.error, /Recorded failure/);
  assert.ok(!('raw_message' in d));
  if (status === 'unsupported') assert.ok(d.html.includes('Inspect this unsupported newsletter'));
}
const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
assert.equal(journal.entries.at(-1).tag, '0029_newsletter_emails');
const sql = await readFile('drizzle/0029_newsletter_emails.sql', 'utf8');
assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
assert.match(sql, /raw_message.*jsonb NOT NULL/);
assert.ok(!sql.includes('newsletter_reviews'));
console.log(
  'PASS unsupported/failed persisted-mail inspection and single incremental migration manifest.',
);

const capped = newsletterStore();
for (const source of ['Source A', 'Source B'])
  for (let day = 1; day <= 8; day++) {
    const id = `${source.replace(' ', '_')}_${day}`;
    await saveFetchedEmail(capped.pool, id, {
      ...raw,
      id,
      internalDate: String(Date.UTC(2026, 10, day)),
    });
    capped.emails.get(id)!.source_name = source;
    capped.emails.get(id)!.parse_status = day % 2 ? 'unsupported' : 'success';
  }
const cappedDeps = { ...deps, database: () => capped.pool };
const all = await (await serveNewsletterParser(request(), cappedDeps)).json();
assert.equal(all.items.length, 10);
assert.equal(all.perSourceLimit, 5);
for (const source of ['Source A', 'Source B'])
  assert.deepEqual(
    all.items
      .filter((m: { source: string }) => m.source === source)
      .map((m: { id: string }) => m.id.split('_').at(-1)),
    ['8', '7', '6', '5', '4'],
  );
const filtered = await (
  await serveNewsletterParser(request('?source=Source%20A&status=unsupported'), cappedDeps)
).json();
assert.equal(filtered.items.length, 4);
assert.ok(
  filtered.items.every(
    (m: { source: string; status: string }) =>
      m.source === 'Source A' && m.status === 'unsupported',
  ),
);
console.log(
  'PASS newest five per source, independent source caps, received_at ordering and status-before-limit filtering.',
);

const reviewDetails = await (
  await serveNewsletterParser(request(`?id=${GMAIL_BASELINE[0][1]}`), deps)
).json();
const skipped = exportNewsletterAnnotation(
  reviewDetails,
  defaultNewsletterReview(reviewDetails.units),
  { skip: true, notes: '广告邮件，无需正文模块' },
);
assert.deepEqual(readNewsletterEmailReview(skipped), {
  skip: true,
  notes: '广告邮件，无需正文模块',
});
assert.deepEqual(readNewsletterEmailReview({ schema_version: 1 }), { skip: false, notes: '' });
assert.throws(() => readNewsletterEmailReview({ email_review: { skip: 'yes', notes: '' } }));
assert.equal(importNewsletterAnnotation(reviewDetails, skipped).length, reviewDetails.units.length);
console.log(
  'PASS optional mail Skip annotations, reason export/import and backward-compatible v1 defaults.',
);
