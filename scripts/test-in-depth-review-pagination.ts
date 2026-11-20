import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { getInDepthReviewPage } from '../src/lib/in-depth-reads.js';
import {
  decodeInDepthReviewCursor,
  encodeInDepthReviewCursor,
  encodeInDepthCursor,
} from '../src/lib/in-depth-pagination.js';
const stamp = '2026-11-20T10:00:00.123456Z';
const rows = Array.from({ length: 45 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(100 - i).padStart(12, '0')}`,
  candidateId: `00000000-0000-4000-8000-${String(200 - i).padStart(12, '0')}`,
  candidateCreatedAt: i === 0 ? '2026-11-20T10:00:00.123457Z' : stamp,
  reviewStatus: 'pending',
  publication: 'Publisher',
  url: 'https://example.test/work',
  evidence: null,
}));
const db = {
  async query(sql: string, p: unknown[] = []) {
    if (sql === 'select name, url from sources order by name') return { rows: [] };
    assert.match(sql, /order by dc.created_at desc, dc.id desc limit \$4/);
    assert.match(sql, /\(dc.created_at, dc.id\) < \(\$2::timestamptz, \$3::uuid\)/);
    assert.match(sql, /HH24:MI:SS.US/);
    assert.equal(p[3], 21);
    return {
      rows: rows
        .filter(
          (r) =>
            r.reviewStatus === p[0] &&
            (!p[1] ||
              r.candidateCreatedAt < String(p[1]) ||
              (r.candidateCreatedAt === p[1] && r.candidateId < String(p[2]))),
        )
        .slice(0, Number(p[3])),
    };
  },
} as unknown as Pick<Pool, 'query'>;
const first = await getInDepthReviewPage(db);
assert.equal(first.items.length, 20);
const cursor = decodeInDepthReviewCursor(first.nextCursor)!;
assert.equal(cursor.createdAt, stamp);
assert.equal(cursor.id, rows[19].candidateId);
rows[0].reviewStatus = 'approved'; // status changes above the cursor must not skip a record
const second = await getInDepthReviewPage(db, 'pending', cursor);
assert.equal(second.items.length, 20);
assert.equal(second.items[0].id, rows[20].id);
const last = await getInDepthReviewPage(
  db,
  'pending',
  decodeInDepthReviewCursor(second.nextCursor),
);
assert.equal(last.items.length, 5);
assert.equal(last.nextCursor, null);
assert.equal(new Set([...first.items, ...second.items, ...last.items].map((r) => r.id)).size, 45);
assert.equal((await getInDepthReviewPage(db, 'rejected')).items.length, 0);
assert.equal(decodeInDepthReviewCursor(null), null);
assert.deepEqual(decodeInDepthReviewCursor(encodeInDepthReviewCursor(cursor)), cursor);
assert.throws(() => decodeInDepthReviewCursor(encodeInDepthCursor(cursor)));
assert.throws(() => decodeInDepthReviewCursor('review1.invalid'));
console.log(
  'Review pages: 20/20/5, microsecond/tied-time cursor, status mutations, empty status and invalid/public cursor rejection passed.',
);
