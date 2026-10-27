import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import {
  getDiscoveryRunForDate,
  discoveryStageTokenMetrics,
} from '../src/lib/discovery-dashboard.js';

const base = {
  run_type: 'regular',
  status: 'completed',
  end_reason: 'candidates_found',
  window_end_date: '2026-10-19',
  finished_at: '2026-10-20T05:00:00Z',
  updated_at: '2026-10-20T05:00:00Z',
  execution_state: {
    d2: { status: 'completed', model: 'd2-model' },
    d3: {
      status: 'completed',
      model: 'test',
      errorSummary: null as string | null,
      elapsedMs: 1200,
      usage: { inputTokens: 100, outputTokens: 20 },
    },
    d4: { status: 'completed', model: 'd4-model' },
    d5: {
      status: 'completed',
      completedAt: '2026-10-20T05:00:00Z' as string | null,
      errorSummary: null as string | null,
    },
  },
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
    assert.ok(!sql.includes('and status in'));
    const eligible = rows.filter((row) => row.window_end_date === parameters[0]);
    if (sql.includes("execution_state->'d5' as d5")) {
      assert.match(sql, /completedAt/);
      assert.match(sql, /updated_at, started_at/);
      assert.match(sql, /order by executed_at desc nulls last, id desc limit 1/);
      const latest = eligible
        .filter((row) => row.execution_state.d5)
        .sort(
          (a, b) =>
            Date.parse(b.execution_state.d5.completedAt || b.updated_at) -
              Date.parse(a.execution_state.d5.completedAt || a.updated_at) ||
            b.id.localeCompare(a.id),
        )[0];
      return {
        rows: latest
          ? [
              {
                ...latest,
                d5: latest.execution_state.d5,
                executed_at: latest.execution_state.d5.completedAt || latest.updated_at,
              },
            ]
          : [],
      };
    }
    assert.match(sql, /and run_type = 'regular'/);
    assert.ok(sql.includes('order by r.started_at desc nulls last, r.id desc limit 1'));
    const regular = eligible.filter((row) => row.run_type === 'regular');
    const latest = regular.sort(
      (a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id.localeCompare(a.id),
    )[0];
    return { rows: latest ? [{ ...latest, run_count: regular.length }] : [] };
  },
} as unknown as Pick<Pool, 'query'>;
for (const tz of ['UTC', 'Asia/Shanghai']) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    const run = (await getDiscoveryRunForDate(db, '2026-10-19'))?.regularRun;
    assert.equal(run?.id, 'latest-b');
    assert.equal(run?.runCount, 3);
    assert.equal(run?.candidateCount, 3);
    assert.equal(run?.reviewCount, 2);
    assert.equal(run?.durationMs, 3_600_000);
    assert.equal(run?.stages.d3?.model, 'test');
    assert.equal((await getDiscoveryRunForDate(db, '2026-10-20'))?.regularRun?.id, 'other-date');
    assert.equal(await getDiscoveryRunForDate(db, '2026-10-21'), null);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
for (const status of ['completed', 'failed', 'blocked', 'running']) {
  rows = [{ ...base, status, id: status, started_at: '2026-10-20T04:00:00Z' }];
  assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.regularRun?.status, status);
}
const blockedDb = {
  async query(sql: string) {
    if (sql.includes("execution_state->'d5' as d5")) return { rows: [] };
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
assert.equal((await getDiscoveryRunForDate(blockedDb, '2026-10-19'))?.regularRun?.durationMs, null);
// Each retry belongs to its own Run; failed retries must not erase Regular diagnostics.
const regular = {
  ...base,
  id: 'regular',
  started_at: '2026-10-20T04:00:00Z',
  status: 'failed',
  execution_state: {
    ...base.execution_state,
    d3: {
      ...base.execution_state.d3,
      status: 'failed',
      model: 'regular-model',
      errorSummary: 'D3 schema error',
    },
  },
};
const open = {
  ...base,
  id: 'open-1',
  run_type: 'open',
  started_at: '2026-10-20T06:00:00Z',
  candidate_count: '99',
  execution_state: {
    ...base.execution_state,
    d5: {
      status: 'failed',
      completedAt: '2026-10-20T06:01:00Z' as string | null,
      errorSummary: 'D5 failure',
    },
  },
};
rows = [regular];
assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.d5?.runId, 'regular');
rows = [regular, open];
let dashboard = await getDiscoveryRunForDate(db, '2026-10-19');
assert.equal(dashboard?.regularRun?.id, 'regular');
assert.equal(dashboard?.regularRun?.runCount, 1);
assert.equal(dashboard?.regularRun?.candidateCount, 3);
assert.equal(dashboard?.regularRun?.stages.d3?.errorSummary, 'D3 schema error');
assert.equal(dashboard?.regularRun?.stages.d3?.model, 'regular-model');
assert.equal(dashboard?.regularRun?.stages.d3?.status, 'failed');
assert.equal(dashboard?.regularRun?.stages.d3?.elapsedMs, 1200);
assert.equal(dashboard?.regularRun?.stages.d3?.usage?.inputTokens, 100);
assert.equal(dashboard?.regularRun?.stages.d2?.model, 'd2-model');
assert.equal(dashboard?.regularRun?.stages.d4?.model, 'd4-model');
assert.equal(dashboard?.d5?.runId, 'open-1');
assert.equal(dashboard?.d5?.state.errorSummary, 'D5 failure');
const retry = {
  ...open,
  id: 'open-2',
  started_at: '2026-10-20T07:00:00Z',
  execution_state: {
    ...open.execution_state,
    d5: { ...open.execution_state.d5, completedAt: '2026-10-20T07:01:00Z' },
  },
};
rows.push(retry);
assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.d5?.runId, 'open-2');
rows.push({
  ...regular,
  id: 'regular-new',
  started_at: '2026-10-20T08:00:00Z',
  execution_state: {
    ...regular.execution_state,
    d5: { ...regular.execution_state.d5, completedAt: '2026-10-20T09:00:00Z' },
  },
});
dashboard = await getDiscoveryRunForDate(db, '2026-10-19');
assert.equal(dashboard?.regularRun?.id, 'regular-new');
assert.equal(dashboard?.regularRun?.runCount, 2);
assert.equal(dashboard?.d5?.runId, 'regular-new');
// Actual stage execution, not Run start, wins (e.g. an older Run resumed later).
rows = [regular, { ...retry, started_at: '2026-10-18T01:00:00Z' }];
assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.d5?.runId, 'open-2');
rows = [open];
dashboard = await getDiscoveryRunForDate(db, '2026-10-19');
assert.equal(dashboard?.regularRun, null);
assert.equal(dashboard?.d5?.runType, 'open');
// Running D5 has no completedAt: its persisted execution update orders it.
rows = [
  regular,
  {
    ...open,
    updated_at: '2026-10-20T10:00:00Z',
    execution_state: {
      ...open.execution_state,
      d5: { status: 'running', completedAt: null, errorSummary: null },
    },
  },
];
assert.equal((await getDiscoveryRunForDate(db, '2026-10-19'))?.d5?.state.status, 'running');
const page = await readFile(
  new URL('../src/app/(admin)/dashboard/page.tsx', import.meta.url),
  'utf8',
);
assert.match(page, /getDiscoveryRunForDate\(pool, data.detailDate\)/);
assert.match(page, /\{discovery \?\s*\(?\s*<DiscoveryRunCard/);
assert.match(page, /stage === 'd5' \? run\.d5\?\.state : regular\?\.stages\[stage\]/);
assert.match(page, /'Open Run ID' : 'Regular Run ID'/);
await assert.rejects(getDiscoveryRunForDate(db, '2026-02-30'));
console.log(
  'Discovery Dashboard business date, timezones, date switching, statuses, latest/count and empty-state tests passed.',
);

for (const cached of [0, 25, null]) {
  const metrics = discoveryStageTokenMetrics({
    requests: 2,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: cached,
    usageComplete: cached !== null,
  });
  assert.equal(metrics.totalTokens, 120);
  assert.equal(metrics.cachedInputTokens, cached);
  assert.equal(metrics.cacheHitRate, cached === null ? null : cached / 100);
}
assert.equal(discoveryStageTokenMetrics(undefined).cachedInputTokens, null);
assert.equal(
  discoveryStageTokenMetrics({
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    usageComplete: true,
  }).cacheHitRate,
  null,
);
assert.match(page, /label="Total tokens"/);
assert.match(page, /label="Cached input tokens"/);
assert.match(page, /mode="d2"/);
console.log(
  'Discovery Card token totals, explicit zero, missing cache, percentages and zero denominator passed.',
);

const retryDb = {
  query: async (sql: string) => ({
    rows: sql.includes("execution_state->'d5' as d5")
      ? []
      : [
          {
            ...base,
            id: 'retry-d2',
            started_at: '2026-10-26T00:00:00Z',
            status: 'failed',
            run_count: 1,
            candidate_count: 0,
            execution_state: { d2: { status: 'failed' } },
            window_start_date: '2026-10-18',
            window_end_date: '2026-10-19',
            input_content_ids: { event: [], digest: [], longForm: [] },
            selection_output: null,
            config_snapshot: {
              promptVersions: {
                'discovery.d2.topic_selection': '00000000-0000-4000-8000-000000000001',
              },
            },
          },
        ],
  }),
} as unknown as Pool;
assert.equal(
  (await getDiscoveryRunForDate(retryDb, '2026-10-19'))?.regularRun?.d2RetryAvailable,
  true,
);
