import './test-discovery-d2-retry.js';
import './test-discovery-interrupted.js';
import './test-discovery-submission-pool.js';
import { databasePoolOptions } from '../src/db/pool-options.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
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
import { submitScheduledDiscovery } from '../src/discovery/scheduled.js';

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
    input: {
      dailyDates: readonly [string, string];
      configSnapshot: Record<string, unknown>;
      triggerSource: 'manual' | 'schedule';
    },
  ) => {
    const run = create('regular', input.dailyDates, input.configSnapshot);
    run.triggerSource = input.triggerSource;
    return { run };
  }) as never,
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
const scheduledNow = new Date('2026-10-20T04:00:00Z');
const beforeSchedule = runs.length;
await Promise.all(
  [1, 2].map(() =>
    submitScheduledDiscovery(
      scheduledNow,
      (input) => submitDiscoveryJob(db, input, services),
      () => {},
    ),
  ),
);
assert.equal(runs.length, beforeSchedule + 1, 'Concurrent Cron submissions create one Run.');
const scheduled = runs.at(-1)!;
assert.equal(scheduled.triggerSource, 'schedule');
assert.equal(scheduled.runType, 'regular');
assert.equal(scheduled.windowStartDate, '2026-10-19');
assert.equal(scheduled.windowEndDate, '2026-10-20');
for (const status of ['running', 'completed', 'failed', 'blocked'] as const) {
  scheduled.status = status;
  await submitScheduledDiscovery(
    scheduledNow,
    (input) => submitDiscoveryJob(db, input, services),
    () => {},
  );
  assert.equal(runs.length, beforeSchedule + 1, 'Cron dedup persists across all statuses.');
}
const manualAfterCron = await submitDiscoveryJob(
  db,
  { date: '2026-10-20', mode: 'regular', requestId: 'manual-after-cron' },
  services,
);
assert.notEqual(manualAfterCron.id, scheduled.id);
assert.equal(manualAfterCron.triggerSource, 'manual');
await submitScheduledDiscovery(
  scheduledNow,
  (input) => submitDiscoveryJob(db, input, services),
  () => {},
);
assert.equal(
  runs.length,
  beforeSchedule + 2,
  'Cron retry finds its original Run, not the manual Retry.',
);
await assert.rejects(
  submitDiscoveryJob(
    db,
    {
      date: '2026-10-22',
      mode: 'open',
      triggerSource: 'schedule',
      requestId: 'invalid-scheduled-open',
    },
    services,
  ),
  /only submits Regular/,
);
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
// Exercise the real CLI main functions with the existing lock and an in-memory
// pg client. Loading the CLI modules themselves would run main and load .env.local.
for (const file of [
  'scripts/test-discovery-d3.ts',
  'scripts/test-discovery-provider.ts',
  'spikes/discovery-agent/index.ts',
]) {
  const source = await readFile(file, 'utf8');
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const main = parsed.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'main',
  );
  assert.ok(main, `${file} must retain its CLI entry point.`);
  const code = ts.transpileModule(`${main.getText(parsed)}\nmain();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let held = true; // A Worker or another CLI already owns the global lock.
  let diagnosticCalls = 0;
  let ends = 0;
  let releases = 0;
  let fail = false;
  const connections: EventEmitter[] = [];
  const fakePool = {
    async connect() {
      const connection = new EventEmitter();
      connections.push(connection);
      return Object.assign(connection, {
        async query(sql: string) {
          if (sql.includes('pg_try_advisory_lock(736210, 1)')) {
            if (held) return { rows: [{ locked: false }] };
            held = true;
            return { rows: [{ locked: true }] };
          }
          assert.equal(sql, 'select pg_advisory_unlock(736210, 1)');
          assert.equal(held, true);
          held = false;
          return { rows: [] };
        },
        release() {
          releases++;
        },
      });
    },
    async end() {
      ends++;
    },
  };
  const invoke = () =>
    runInNewContext(code, {
      Pool: class {
        constructor() {
          return fakePool;
        }
      },
      process: { argv: [], env: { DATABASE_URL: 'mock-only' } },
      parseArguments: () => ({ runId: input.requestId, confirmPaid: true }),
      withDiscoveryExecutionLock,
      databasePoolOptions,
      runDiagnostic: async () => {
        assert.equal(held, true, `${file} must hold the global lock during all diagnostic work.`);
        diagnosticCalls++;
        if (fail) throw new Error('Mock diagnostic failure');
      },
    }) as Promise<void>;

  await assert.rejects(invoke(), /Another Discovery executor is running/);
  assert.equal(
    diagnosticCalls,
    0,
    `${file} must not read/change Run state or call a model when busy.`,
  );
  assert.equal(held, true, 'A refused diagnostic must not release the other executor lock.');
  assert.equal(ends, 1);
  assert.equal(releases, 1);

  held = false; // The other executor finishes normally.
  await invoke();
  assert.equal(diagnosticCalls, 1);
  assert.equal(held, false);
  assert.equal(ends, 2);
  assert.equal(releases, 2);

  fail = true;
  await assert.rejects(invoke(), /Mock diagnostic failure/);
  assert.equal(held, false, 'Unexpected failures must still release lock ownership.');
  assert.equal(ends, 3);
  assert.equal(releases, 3);
  fail = false;
  await invoke();
  assert.equal(diagnosticCalls, 3, 'A later diagnostic can execute after failure cleanup.');
  assert.equal(held, false);
  assert.equal(ends, 4);
  assert.equal(releases, 4);
  assert.ok(connections.every((connection) => connection.listenerCount('error') === 0));
}
console.log('Real Discovery diagnostic entry lock refusal, release and retry passed (Mock only).');
console.log(
  'Discovery durable submission/idempotency, concurrent guard, independent retries, restart failure, exclusive execution, usage and auth passed.',
);

// Exercise the actual Retry/Polling handlers with an existing shared Web Pool.
const retrySource = await readFile(
  new URL('../src/app/api/admin/dashboard/step/retry/route.ts', import.meta.url),
  'utf8',
);
const retryParsed = ts.createSourceFile('route.ts', retrySource, ts.ScriptTarget.Latest, true);
const handlers = retryParsed.statements
  .filter((node) => ts.isFunctionDeclaration(node))
  .map((node) => node.getText(retryParsed))
  .join('\n');
const retryExports: {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
} = {};
let denied = false;
let databaseAccesses = 0;
const sharedPool = {
  end() {
    throw new Error('An HTTP handler must not close the shared Web Pool.');
  },
};
runInNewContext(
  ts.transpileModule(handlers, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
  {
    exports: retryExports,
    Response,
    URL,
    adminApiError: async () => (denied ? new Response(null, { status: 401 }) : null),
    parseBriefDate: () => true,
    isDashboardRetryStep: () => true,
    getDatabasePool: () => {
      databaseAccesses++;
      return sharedPool;
    },
    startDashboardStepRetry: async (db: unknown) => {
      assert.equal(db, sharedPool);
      return { status: 'started' };
    },
    getDashboardStepRunStatus: async (db: unknown) => {
      assert.equal(db, sharedPool);
      return 'success';
    },
  },
);
assert.equal(
  (
    await retryExports.POST!(
      new Request('http://localhost/api/retry', {
        method: 'POST',
        body: JSON.stringify({ dailyDate: '2026-10-22', step: 'stage3' }),
      }),
    )
  ).status,
  202,
);
for (let i = 0; i < 2; i++)
  assert.equal(
    (
      await retryExports.GET!(
        new Request('http://localhost/api/retry?dailyDate=2026-10-22&step=stage3'),
      )
    ).status,
    200,
  );
assert.equal(databaseAccesses, 3);
denied = true;
assert.equal(
  (await retryExports.POST!(new Request('http://localhost/api/retry', { method: 'POST' }))).status,
  401,
);
assert.equal(databaseAccesses, 3, 'Unauthorized handlers do not acquire a database Pool.');
console.log('Dashboard Retry/Polling shared Pool lifetime and server auth passed.');
