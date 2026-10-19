import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { GET, PATCH, POST } from '../src/app/api/admin/review/in-depth/route.js';
import {
  displayInDepthFields,
  toPublicInDepthRead,
  getInDepthReviewItem,
  listInDepthReviewItems,
  listPublishedInDepthReads,
  parseInDepthReviewUpdate,
  updateInDepthReviewItem,
  type InDepthReviewItem,
} from '../src/lib/in-depth-reads.js';

const firstId = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const thirdId = '00000000-0000-4000-8000-000000000003';

function item(id: string, reviewStatus: InDepthReviewItem['reviewStatus']): InDepthReviewItem {
  return {
    id,
    candidateId: id,
    runId: '00000000-0000-4000-8000-000000000099',
    reviewStatus,
    editorialNotes: null,
    editorialOverrides: null,
    reviewedAt: null,
    createdAt: '2026-10-18T10:00:00Z',
    candidateCreatedAt: '2026-10-18T09:00:00Z',
    discoveryPath: 'topic',
    url: 'https://example.com/work',
    originalTitle: 'Original title',
    titleZh: 'AI title',
    author: 'AI author',
    publication: 'Example',
    contentType: 'article',
    estimatedDurationMinutes: 12,
    summary: 'AI summary',
    whyWorthReading: 'AI reason',
    evidence: { agentEvidence: 'A real argument' },
    evaluation: { decision: 'qualified' },
    extraInfo: { diagnostic: 'Original Agent metadata' },
  };
}

const rows = [item(firstId, 'pending'), item(secondId, 'approved'), item(thirdId, 'rejected')];
const queries: string[] = [];
const db = {
  async query(sql: string, params: unknown[] = []) {
    queries.push(sql);
    if (sql === 'select name, url from sources order by name')
      return { rows: [{ name: 'Example configured', url: 'https://example.com/rss' }] };
    if (sql.startsWith('update in_depth_candidates')) {
      const row = rows.find((candidate) => candidate.id === params[0]);
      if (!row) return { rows: [] };
      if (sql.includes('set review_status')) {
        row.reviewStatus = params[1] as InDepthReviewItem['reviewStatus'];
        row.reviewedAt = row.reviewStatus === 'pending' ? null : new Date().toISOString();
      } else if (sql.includes('set editorial_notes')) {
        row.editorialNotes = params[1] as string | null;
      } else if (sql.includes('set editorial_summary')) {
        assert.ok(sql.includes('editorial_why_worth_reading = $3'));
        assert.ok(sql.includes('editorial_extra_info = $4'));
        assert.ok(!sql.includes('editorial_overrides'));
        row.editorialOverrides = {
          summary: params[1],
          whyWorthReading: params[2],
          extra_info: params[3],
        };
      } else throw new Error('Unexpected write');
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('where idc.id = $1::uuid')) {
      return { rows: rows.filter((candidate) => candidate.id === params[0]) };
    }
    if (sql.includes("where idc.review_status = 'approved'")) {
      return { rows: rows.filter((candidate) => candidate.reviewStatus === 'approved') };
    }
    if (sql.includes('where idc.review_status = $1')) {
      return { rows: rows.filter((candidate) => candidate.reviewStatus === params[0]) };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
} as unknown as Pick<Pool, 'query'>;

assert.deepEqual(
  (await listInDepthReviewItems(db)).map((entry) => entry.id),
  [firstId],
);
assert.ok(queries[0]?.includes('order by dc.created_at desc'));
for (const column of ['editorial_summary', 'editorial_why_worth_reading', 'editorial_extra_info'])
  assert.ok(queries[0]?.includes(`idc.${column}`));
assert.ok(!queries[0]?.includes('idc.editorial_overrides'));
assert.deepEqual(
  (await listInDepthReviewItems(db, 'approved')).map((entry) => entry.id),
  [secondId],
);
assert.deepEqual(
  (await listInDepthReviewItems(db, 'rejected')).map((entry) => entry.id),
  [thirdId],
);
assert.deepEqual(
  (await listPublishedInDepthReads(db)).map((entry) => entry.id),
  [secondId],
);
assert.ok(queries.some((sql) => sql.includes("where idc.review_status = 'approved'")));

// Each control writes only its own fields, including after approval.
await updateInDepthReviewItem(db, {
  id: firstId,
  action: 'notes',
  editorialNotes: 'Checked original',
});
await updateInDepthReviewItem(db, {
  id: firstId,
  action: 'editorial',
  extra_info: '面向读者的具体评估',
  summary: '## 讲了什么\n中文概要',
  whyWorthReading: '中文阅读价值',
});
assert.equal(rows[0]!.reviewStatus, 'pending');
assert.equal(rows[0]!.editorialNotes, 'Checked original');
assert.equal(
  (await listPublishedInDepthReads(db)).some((row) => row.id === firstId),
  false,
);
const editorialBeforeApproval = { ...rows[0]!.editorialOverrides };
const approved = await updateInDepthReviewItem(db, {
  id: firstId,
  action: 'review',
  reviewStatus: 'approved',
});
assert.equal(approved?.reviewStatus, 'approved');
assert.ok(approved?.reviewedAt);
assert.deepEqual(approved?.editorialOverrides, editorialBeforeApproval);
assert.equal(approved?.editorialNotes, 'Checked original');
await updateInDepthReviewItem(db, {
  id: firstId,
  action: 'editorial',
  extra_info: '面向读者的具体评估',
  summary: '更新的 Markdown',
  whyWorthReading: '新理由',
});
assert.equal(rows[0]!.reviewStatus, 'approved');
const publicRow = (await listPublishedInDepthReads(db)).find((row) => row.id === firstId)!;
assert.equal(displayInDepthFields(publicRow).summary, '更新的 Markdown');
const publicPayload = toPublicInDepthRead(publicRow);
assert.equal(publicPayload.summary, '更新的 Markdown');
assert.equal(publicPayload.extra_info, '面向读者的具体评估');
assert.deepEqual(rows[0]!.extraInfo, { diagnostic: 'Original Agent metadata' });
assert.equal(toPublicInDepthRead({ ...publicRow, editorialOverrides: null }).extra_info, '');
for (const field of [
  'editorialNotes',
  'editorialOverrides',
  'evidence',
  'evaluation',
  'extraInfo',
  'reviewStatus',
])
  assert.equal(field in publicPayload, false);
assert.equal(displayInDepthFields(publicRow).title, 'AI title');
assert.equal(rows[0]!.summary, 'AI summary');
const savedEditorial = { ...rows[0]!.editorialOverrides };
await updateInDepthReviewItem(db, { id: firstId, action: 'notes', editorialNotes: 'Only notes' });
assert.deepEqual(rows[0]!.editorialOverrides, savedEditorial);
assert.equal(rows[0]!.reviewStatus, 'approved');
await updateInDepthReviewItem(db, { id: firstId, action: 'review', reviewStatus: 'rejected' });
assert.deepEqual(rows[0]!.editorialOverrides, savedEditorial);
assert.equal(
  (await listPublishedInDepthReads(db)).some((row) => row.id === firstId),
  false,
);
for (const input of [
  { id: firstId, action: 'review', reviewStatus: 'published' },
  { id: firstId, action: 'review', reviewStatus: 'approved', editorialNotes: 'Overwrite' },
  { id: firstId, action: 'notes', editorialNotes: 'Notes', summary: 'Overwrite' },
  {
    id: firstId,
    action: 'editorial',
    extra_info: '面向读者的具体评估',
    summary: 'Summary',
    whyWorthReading: 'Reason',
    reviewStatus: 'approved',
  },
  { id: firstId, reviewStatus: 'approved', editorialOverrides: {} },
])
  assert.throws(() => parseInDepthReviewUpdate(input));
assert.equal(displayInDepthFields({ ...rows[0]!, editorialOverrides: null }).summary, 'AI summary');

const apiPath = 'https://example.test/ai/api/admin/review/in-depth';
assert.equal((await GET(new Request(`${apiPath}?id=${firstId}`))).status, 401);
assert.equal((await PATCH(new Request(apiPath, { method: 'PATCH' }))).status, 401);
assert.equal((await POST(new Request(apiPath, { method: 'POST' }))).status, 401);

console.log('In-depth Review mock tests passed.');

rows[0]!.publication = 'Unknown';
rows[0]!.evidence = { fetch: { metadata: { publication: 'Fetched publisher' } } };
assert.equal((await getInDepthReviewItem(db, firstId))?.publication, 'Fetched publisher');
rows[0]!.evidence = null;
assert.equal((await getInDepthReviewItem(db, firstId))?.publication, 'Example configured');
rows[0]!.url = 'https://www.legacy.test/article';
assert.equal((await getInDepthReviewItem(db, firstId))?.publication, 'legacy.test');
rows[0]!.reviewStatus = 'approved';
const legacyPublic = (await listPublishedInDepthReads(db)).find((row) => row.id === firstId)!;
assert.equal(legacyPublic.publication, 'legacy.test');
assert.equal('evidence' in legacyPublic, false);
assert.equal('dailySource' in legacyPublic, false);
assert.equal(rows[0]!.publication, 'Unknown', 'Read-time fallback must not modify stored rows.');
