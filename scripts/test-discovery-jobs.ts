import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import {
  submitDiscoveryJob,
  processNextDiscoveryJob,
  withDiscoveryExecutionLock,
} from '../src/discovery/background-jobs.js';
import { discoveryDatesForEndDate } from '../src/lib/discovery-window.js';
import { discoveryRunCacheMetrics } from '../src/lib/discovery-dashboard.js';
import { POST, GET } from '../src/app/api/admin/discovery/route.js';
import type { DiscoveryRunRecord } from '../src/discovery/run-service.js';

const runs: DiscoveryRunRecord[] = [];
let sequence = 0,
  locked = false;
const events: string[] = [];
let resolveGate = () => {};
let gatePromise = Promise.resolve();
const pool = {
  async connect() {
    const connection = new EventEmitter();
    let releaseGate: (() => void) | undefined;
    return Object.assign(connection, {
      release() {},
      async query(sql: string, p: unknown[] = []) {
        if (sql.includes('pg_advisory_xact_lock')) {
          const prior = gatePromise;
          gatePromise = new Promise((resolve) => {
            resolveGate = resolve;
          });
          const myRelease = resolveGate;
          await prior;
          releaseGate = myRelease;
        }
        if (sql === 'commit' || sql === 'rollback') releaseGate?.();
        if (sql.includes('pg_try_advisory_lock')) {
          if (locked) return { rows: [{ locked: false }] };
          locked = true;
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) locked = false;
        return pool.query(sql, p);
      },
    });
  },
  async query(sql: string, p: unknown[] = []) {
    if (sql.includes("->>'requestId'"))
      return {
        rows: runs.filter(
          (r) => (r.configSnapshot?.dashboardJob as { requestId: string })?.requestId === p[0],
        ),
      };
    if (sql.includes("status in ('pending', 'running')") && sql.includes('select'))
      return {
        rows: runs
          .filter((r) => r.windowEndDate === p[0] && ['pending', 'running'].includes(r.status))
          .slice(0, 1),
      };
    if (sql.includes("run_type = 'regular'"))
      return {
        rows: runs.filter((r) => r.runType === 'regular' && r.windowEndDate === p[0]).slice(-1),
      };
    if (sql.includes('Executor interrupted')) {
      for (const r of runs)
        if (r.status === 'running') {
          r.status = 'failed';
          r.errorSummary = 'interrupted';
        }
      events.push('recover');
    }
    if (sql.startsWith('select id from discovery_runs') && sql.includes("status = 'pending'"))
      return { rows: runs.filter((r) => r.status === 'pending').slice(0, 1) };
    if (sql.includes('error_summary = $2')) {
      const r = runs.find((r) => r.id === p[0])!;
      r.status = 'failed';
      r.errorSummary = String(p[1]);
    }
    return { rows: [] };
  },
};
const db = pool as unknown as Pool;
function create(
  type: 'regular' | 'open',
  dates: readonly [string, string],
  config: Record<string, unknown>,
  parent: string | null = null,
) {
  const run = {
    id: `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    runType: type,
    parentRunId: parent,
    windowStartDate: dates[0],
    windowEndDate: dates[1],
    configSnapshot: config,
    status: 'pending',
    executionState: {},
    triggerSource: 'manual',
    selectionOutput: null,
  } as DiscoveryRunRecord;
  runs.push(run);
  return run;
}
const services = {
  createRegularDiscoveryRun: (async (
    _db: unknown,
    input: { dailyDates: readonly [string, string]; configSnapshot: Record<string, unknown> },
  ) => ({ run: create('regular', input.dailyDates, input.configSnapshot) })) as never,
  createOpenDiscoveryRun: (async (
    _db: unknown,
    input: { parentRunId: string; configSnapshot: Record<string, unknown> },
  ) => {
    const p = runs.find((r) => r.id === input.parentRunId)!;
    return create('open', [p.windowStartDate!, p.windowEndDate!], input.configSnapshot, p.id);
  }) as never,
  getDiscoveryRun: (async (_db: unknown, id: string) =>
    runs.find((r) => r.id === id) ?? null) as never,
};
const input = { date: '2026-10-19', mode: 'regular' as const, requestId: 'request-1' };
const first = await submitDiscoveryJob(db, input, services);
assert.deepEqual(await submitDiscoveryJob(db, input, services), first);
assert.equal(runs.length, 1);
await assert.rejects(
  submitDiscoveryJob(db, { ...input, mode: 'open' }, services),
  /another request/,
);
await assert.rejects(
  submitDiscoveryJob(db, { ...input, requestId: 'request-2' }, services),
  /已有/,
);
first.status = 'completed';
const second = await submitDiscoveryJob(db, { ...input, requestId: 'request-2' }, services);
assert.notEqual(first.id, second.id);
second.status = 'completed';
const opens = await Promise.allSettled(
  [3, 4].map((i) =>
    submitDiscoveryJob(db, { ...input, mode: 'open', requestId: `request-${i}` }, services),
  ),
);
assert.equal(opens.filter((r) => r.status === 'fulfilled').length, 1);
const open = runs.at(-1)!;
assert.equal(open.parentRunId, second.id);
assert.equal(open.windowEndDate, input.date);
open.status = 'completed';
const another = await submitDiscoveryJob(
  db,
  { ...input, mode: 'open', requestId: 'request-5' },
  services,
);
assert.notEqual(another.id, open.id);
assert.equal(open.status, 'completed');
assert.deepEqual(discoveryDatesForEndDate('2026-03-01'), ['2026-02-28', '2026-03-01']);
const interrupted = create('open', ['2026-10-18', '2026-10-19'], { dashboardJob: {} }, second.id);
interrupted.status = 'running';
assert.equal(
  await processNextDiscoveryJob(db, async (_db, options) => {
    assert.equal(options.queuedRunId, another.id);
    assert.equal(interrupted.status, 'failed');
    throw new Error('Mock worker failure');
  }),
  true,
);
assert.equal(another.status, 'failed');
assert.match(another.errorSummary!, /Mock worker/);
assert.equal(await processNextDiscoveryJob(db), false); // never auto-retry failures
const queuedAfterRestart = create('regular', ['2026-10-18', '2026-10-19'], { dashboardJob: {} });
assert.equal(
  await processNextDiscoveryJob(db, async (_pool, options) => {
    assert.equal(options.queuedRunId, queuedAfterRestart.id);
    queuedAfterRestart.status = 'completed';
    return {
      run: queuedAfterRestart,
      counts: { directLeads: 0, topicLeads: 0, candidates: 0, qualified: 0, submittedForReview: 0 },
      branchStates: { d2: null, d3: null, d4: null, d5: null },
      d5Eligible: false,
    };
  }),
  true,
);
assert.equal(queuedAfterRestart.status, 'completed');
assert.equal(first.status, 'completed', 'Historical Run remains intact.');
locked = true;
assert.equal(
  await withDiscoveryExecutionLock(db, async () => {
    throw new Error('must not execute concurrently');
  }),
  null,
);
locked = false;
const usage = {
  requests: 1,
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  usageComplete: true,
};
const state = { usage };
assert.deepEqual(discoveryRunCacheMetrics('open', { d5: state }), {
  cachedInputTokens: 40,
  cacheHitRate: 0.4,
});
assert.deepEqual(discoveryRunCacheMetrics('regular', { d2: state, d3: state, d4: state }), {
  cachedInputTokens: 120,
  cacheHitRate: 0.4,
});
assert.deepEqual(discoveryRunCacheMetrics('regular', {}), {
  cachedInputTokens: null,
  cacheHitRate: null,
});
assert.deepEqual(
  discoveryRunCacheMetrics('open', { d5: { usage: { ...usage, cachedInputTokens: 0 } } }),
  { cachedInputTokens: 0, cacheHitRate: 0 },
);
assert.equal(
  discoveryRunCacheMetrics('open', { d5: { usage: { ...usage, inputTokens: 0 } } }).cacheHitRate,
  null,
);
for (const handler of [POST, GET])
  assert.equal(
    (await handler(new Request('http://example.test/ai/api/admin/discovery'))).status,
    401,
  );
console.log(
  'Discovery durable submission/idempotency, concurrent guard, independent retries, restart failure, exclusive execution, usage and auth passed.',
);
