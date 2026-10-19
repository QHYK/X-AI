import assert from 'node:assert/strict';
import { decodeInDepthCursor, encodeInDepthCursor } from '../src/lib/in-depth-pagination.js';
import { getPublishedInDepthPage } from '../src/lib/in-depth-reads.js';
import type { Pool } from 'pg';
import { GET } from '../src/app/api/in-depth/route.js';

const createdAt = '2026-10-19T10:00:00.123456Z';
const rows = Array.from({ length: 23 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(100 - i).padStart(12, '0')}`,
  cursorId: `00000000-0000-4000-8000-${String(100 - i).padStart(12, '0')}`,
  cursorCreatedAt: createdAt,
  reviewStatus: i === 22 ? 'pending' : 'approved',
  url: 'https://example.test/work',
  publication: 'Publisher',
  evidence: {},
  evaluation: {},
  editorialOverrides: { summary: 'Editorial' },
  summary: 'Agent',
  whyWorthReading: 'Reason',
}));
const db = {
  async query(sql: string, params: unknown[]) {
    if (sql === 'select name, url from sources order by name') return { rows: [] };
    assert.ok(sql.includes("where idc.review_status = 'approved'"));
    assert.ok(sql.includes('order by dc.created_at desc, dc.id desc limit $3'));
    assert.ok(sql.includes('(dc.created_at, dc.id) < ($1::timestamptz, $2::uuid)'));
    assert.ok(sql.includes('HH24:MI:SS.US')); // no JavaScript millisecond truncation
    assert.equal(params[2], 11);
    return {
      rows: rows
        .filter(
          (row) =>
            row.reviewStatus === 'approved' && (!params[0] || row.cursorId < String(params[1])),
        )
        .slice(0, Number(params[2])),
    };
  },
} as unknown as Pick<Pool, 'query'>;
for (const tz of ['UTC', 'Asia/Shanghai']) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const first = await getPublishedInDepthPage(db);
    assert.equal(first.items.length, 10);
    assert.equal(first.hasMore, true);
    const cursor = decodeInDepthCursor(first.nextCursor);
    assert.equal(cursor?.createdAt, createdAt);
    const second = await getPublishedInDepthPage(db, cursor);
    const third = await getPublishedInDepthPage(db, decodeInDepthCursor(second.nextCursor));
    assert.equal(second.items.length, 10);
    assert.equal(third.items.length, 2);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextCursor, null);
    assert.equal(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.id)).size,
      22,
    );
    assert.equal('cursorId' in first.items[0]!, false);
    assert.equal('evidence' in first.items[0]!, false);
    assert.equal(first.items[0]!.agent.summary, 'Agent');
    assert.equal(first.items[0]!.editorial.summary, 'Editorial');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
for (const invalid of [
  '',
  '%%',
  'a'.repeat(513),
  Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ id: 'bad', createdAt })).toString('base64url'),
])
  assert.throws(() => decodeInDepthCursor(invalid), /Invalid In-depth cursor/);
assert.equal(decodeInDepthCursor(null), null);
assert.equal(
  (await GET(new Request('http://example.test/ai/api/in-depth?cursor=invalid'))).status,
  400,
);
assert.deepEqual(decodeInDepthCursor(encodeInDepthCursor({ id: rows[0]!.cursorId, createdAt })), {
  id: rows[0]!.cursorId,
  createdAt,
});
console.log(
  'In-depth SQL pagination: first/next/end pages, stable ties, UTC microseconds, approval, allowlist and invalid cursors passed.',
);
