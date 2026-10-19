import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { GET, PATCH } from '../src/app/api/admin/review/in-depth/route.js';
import {
  displayInDepthFields,
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
    extraInfo: {},
  };
}

const rows = [item(firstId, 'pending'), item(secondId, 'approved'), item(thirdId, 'rejected')];
const queries: string[] = [];
const db = {
  async query(sql: string, params: unknown[] = []) {
    queries.push(sql);
    if (sql.startsWith('update in_depth_candidates')) {
      const row = rows.find((candidate) => candidate.id === params[0]);
      if (!row) return { rows: [] };
      row.reviewStatus = params[1] as InDepthReviewItem['reviewStatus'];
      row.editorialNotes = params[2] as string | null;
      row.editorialOverrides = params[3]
        ? (JSON.parse(params[3] as string) as Record<string, unknown>)
        : null;
      row.reviewedAt = row.reviewStatus === 'pending' ? null : new Date().toISOString();
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

const approved = await updateInDepthReviewItem(db, {
  id: firstId,
  reviewStatus: 'approved',
  editorialNotes: 'Checked original',
  editorialOverrides: {
    title: 'Edited title',
    author: 'Edited author',
    summary: 'Edited summary',
    whyWorthReading: 'Edited reason',
  },
});
assert.equal(approved?.reviewStatus, 'approved');
assert.equal(approved?.editorialNotes, 'Checked original');
assert.ok(approved?.reviewedAt);
assert.equal(rows.length, 3, 'Saving a review updates one row instead of inserting another.');
assert.equal(rows[0]?.originalTitle, 'Original title', 'Editorial changes preserve Agent output.');
assert.deepEqual(displayInDepthFields(rows[0]!), {
  title: 'Edited title',
  author: 'Edited author',
  summary: 'Edited summary',
  whyWorthReading: 'Edited reason',
});
assert.deepEqual(
  (await listPublishedInDepthReads(db)).map((entry) => entry.id),
  [firstId, secondId],
);

await updateInDepthReviewItem(db, {
  id: firstId,
  reviewStatus: 'approved',
  editorialNotes: 'Checked original',
  editorialOverrides: { title: 'Edited title' },
});
assert.equal(rows.length, 3, 'Repeated approval stays on the same review row.');

await updateInDepthReviewItem(db, {
  id: firstId,
  reviewStatus: 'rejected',
  editorialNotes: 'Withdrawn',
  editorialOverrides: {},
});
assert.deepEqual(
  (await listPublishedInDepthReads(db)).map((entry) => entry.id),
  [secondId],
);
assert.equal((await getInDepthReviewItem(db, firstId))?.reviewStatus, 'rejected');
assert.equal((await listInDepthReviewItems(db, 'pending')).length, 0);
assert.equal(displayInDepthFields(rows[0]!).title, 'AI title');

assert.throws(() => parseInDepthReviewUpdate({ id: firstId, reviewStatus: 'published' }));
assert.throws(() =>
  parseInDepthReviewUpdate({
    id: firstId,
    reviewStatus: 'approved',
    editorialNotes: null,
    editorialOverrides: { title: 'Edited', rawCandidateTitle: 'Overwritten' },
  }),
);

const apiPath = 'https://example.test/ai/api/admin/review/in-depth';
assert.equal((await GET(new Request(`${apiPath}?id=${firstId}`))).status, 401);
assert.equal((await PATCH(new Request(apiPath, { method: 'PATCH' }))).status, 401);

console.log('In-depth Review mock tests passed.');
