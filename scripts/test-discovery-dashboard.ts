import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { getDiscoveryRunForDate } from '../src/lib/discovery-dashboard.js';

const base = {
  run_type: 'regular',
  status: 'completed',
  end_reason: 'candidates_found',
  window_end_date: '2026-10-19',
  finished_at: '2026-10-20T05:00:00Z',
  execution_state: { d3: { status: 'completed', model: 'test' } },
  candidate_count: '3',
  review_count: '2',
};
let rows = [
  { ...base, id: 'first', started_at: '2026-10-18T16:00:00Z' },
  { ...base, id: 'latest-a', started_at: '2026-10-20T04:00:00Z' },
  { ...base, id: 'latest-b', started_at: '2026-10-20T04:00:00Z' },
  { ...base, id: 'other-date', window_end_date: '2026-10-20', started_at: '2026-10-21T00:00:00Z' },
];
const db = {
  async query(sql: string, parameters: string[]) {
    assert.ok(sql.includes('where window_end_date = $1::date'));
    assert.ok(sql.includes('order by r.started_at desc nulls last, r.id desc limit 1'));
    assert.ok(
      !sql.includes('timestamptz') && !sql.includes('status =') && !sql.includes('end_reason ='),
    );
    const eligible = rows.filter((row) => row.window_end_date === parameters[0]);
    const latest = eligible.sort(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id),
    )[0];
    return { rows: latest ? [{ ...latest, run_count: eligible.length }] : [] };
  },
} as unknown as Pick<Pool, 'query'>;
for (const tz of ['UTC', 'Asia/Shanghai']) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const run = await getDiscoveryRunForDate(db, '2026-10-19');
    assert.equal(run?.id, 'latest-b');
    assert.equal(run?.runCount, 3);
    assert.equal(run?.candidateCount, 3);
    assert.equal(run?.reviewCount, 2);
    assert.equal(run?.durationMs, 3_600_000);
    assert.equal(run?.stages.d3?.model, 'test');
    assert.equal((await getDiscoveryRunForDate(db, '2026-10-20'))?.id, 'other-date');
    assert.equal(await getDiscoveryRunForDate(db, '2026-10-21'), null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
for (const status of ['completed', 'failed', 'blocked', 'running']) {
  rows = [{ ...base, status, id: status, started_at: '2026-10-20T04:00:00Z' }];
  assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.status, status);
}
const blockedDb = {
  async query() {
    return {
      rows: [
        {
          ...base,
          status: 'blocked',
          id: 'blocked',
          started_at: null,
          finished_at: null,
          run_count: 1,
        },
      ],
    };
  },
} as unknown as Pick<Pool, 'query'>;
assert.equal((await getDiscoveryRunForDate(blockedDb, '2026-10-19'))?.durationMs, null);
const page = await readFile(
  new URL('../src/app/(admin)/dashboard/page.tsx', import.meta.url),
  'utf8',
);
assert.match(page, /getDiscoveryRunForDate\(pool, data.detailDate\)/);
assert.match(page, /\{discovery \?\s*\(?\s*<DiscoveryRunCard/);
await assert.rejects(getDiscoveryRunForDate(db, '2026-02-30'));
console.log(
  'Discovery Dashboard business date, timezones, date switching, statuses, latest/count and empty-state tests passed.',
);
