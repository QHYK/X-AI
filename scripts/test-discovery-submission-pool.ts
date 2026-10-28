import { systemFragmentFixtureQuery } from './fixtures/prompt-runtime.js';
/** Real pg-pool checkout/timeout behavior with an in-memory PostgreSQL client; no sockets or DB. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Pool, type PoolConfig } from 'pg';
import { submitDiscoveryJob } from '../src/discovery/background-jobs.js';
import { databasePoolOptions } from '../src/db/pool-options.js';

type Row = Record<string, unknown>;
const rows: Row[] = [];
let gate = Promise.resolve();
let failInsert = false;
let failCommit = false;
let failLock = false;
let failRollback = false;
let ready = false;
let rollbackCount = 0;
let acquisitions = 0;
let lockTimeoutConfigured = false;
class MemoryClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  pending: Row[] = [];
  unlock?: () => void;
  connect(done: (error?: Error) => void) {
    queueMicrotask(() => done());
  }
  end(done?: () => void) {
    this.pending = [];
    this.unlock?.();
    this.emit('end');
    done?.();
  }
  async query(sql: string, parameters: unknown[] = []) {
    if (sql === "set local lock_timeout = '5s'") lockTimeoutConfigured = true;
    if (sql.includes('pg_advisory_xact_lock')) {
      assert.ok(lockTimeoutConfigured);
      if (failLock)
        throw Object.assign(new Error('canceling statement due to lock timeout'), {
          code: '55P03',
        });
      const previous = gate;
      gate = new Promise<void>((resolve) => {
        this.unlock = resolve;
      });
      await previous;
    } else if (sql === 'commit') {
      if (failCommit) throw new Error('Mock commit failed');
      rows.push(...this.pending);
      this.pending = [];
      this.unlock?.();
    } else if (sql === 'rollback') {
      rollbackCount++;
      if (failRollback) throw new Error('Mock rollback failed');
      this.pending = [];
      this.unlock?.();
    } else if (sql.includes("->>'requestId'")) {
      return {
        rows: rows.filter(
          (r) =>
            (r.config_snapshot as { dashboardJob: { requestId: string } }).dashboardJob
              .requestId === parameters[0],
        ),
      };
    } else if (sql.includes("status in ('pending', 'running')")) {
      return {
        rows: rows.filter(
          (r) =>
            r.window_end_date === parameters[0] &&
            ['pending', 'running'].includes(String(r.status)),
        ),
      };
    } else if (sql.includes("run_type = 'regular'")) {
      return {
        rows: rows
          .filter((r) => r.window_end_date === parameters[0] && r.run_type === 'regular')
          .slice(-1),
      };
    } else if (sql.includes('from discovery_runs where id')) {
      return { rows: rows.filter((r) => r.id === parameters[0]) };
    } else if (sql.includes('from pipeline_runs')) {
      return {
        rows: ready ? (parameters[0] as string[]).map((daily_date) => ({ daily_date })) : [],
      };
    } else if (sql.includes('insert into discovery_runs')) {
      if (failInsert) throw new Error('Mock insert failed');
      const open = sql.includes("'open'");
      const row: Row = {
        id: `run-${rows.length + 1}`,
        parent_run_id: open ? parameters[0] : null,
        source_lead_id: null,
        run_type: open ? 'open' : 'regular',
        trigger_source: parameters[open ? 1 : 0],
        status: open ? 'pending' : parameters[1],
        end_reason: open ? null : parameters[2],
        window_start_date: parameters[3],
        window_end_date: parameters[4],
        config_snapshot: JSON.parse(String(parameters[open ? 2 : 6])),
        input_content_ids: open || !parameters[5] ? null : JSON.parse(String(parameters[5])),
        selection_output: null,
        execution_state: {},
        started_at: null,
        finished_at: null,
        error_summary: null,
        created_at: '2026-10-26T00:00:00Z',
        updated_at: '2026-10-26T00:00:00Z',
      };
      this.pending.push(row);
      return { rows: [row] };
    } else if (systemFragmentFixtureQuery(sql)) {
      return systemFragmentFixtureQuery(sql)!;
    } else if (sql.trimStart().startsWith('select')) {
      assert.ok(ready, 'Only read the Daily body when upstream is ready.');
      return { rows: [] };
    } else if (!['begin', "set local lock_timeout = '5s'"].includes(sql)) {
      throw new Error(`Unexpected submission query: ${sql}`);
    }
    return { rows: [] };
  }
}

const pool = new Pool({
  ...databasePoolOptions('submission'),
  connectionTimeoutMillis: 100,
  Client: MemoryClient,
} as unknown as PoolConfig);
pool.on('acquire', () => {
  acquisitions++;
});
const input = {
  date: '2026-10-22',
  mode: 'regular' as const,
  requestId: 'cron:2026-10-22',
  triggerSource: 'schedule' as const,
};
try {
  // max=1 is intentional: a nested pool checkout would timeout here.
  const repeated = await Promise.all(
    Array.from({ length: 6 }, () => submitDiscoveryJob(pool, input)),
  );
  assert.equal(new Set(repeated.map((r) => r.id)).size, 1);
  assert.equal(rows.length, 1);
  assert.equal(
    acquisitions,
    6,
    'Exactly one checkout per HTTP/Cron submission, including duplicate lookup.',
  );
  assert.equal(pool.totalCount, 1);
  const twoClients = new Pool({
    ...databasePoolOptions('web'),
    max: 2,
    connectionTimeoutMillis: 100,
    Client: MemoryClient,
  } as unknown as PoolConfig);
  try {
    const queued = await Promise.all(
      Array.from({ length: 4 }, () =>
        submitDiscoveryJob(twoClients, {
          ...input,
          date: '2026-10-28',
          requestId: 'parallel-two-clients',
        }),
      ),
    );
    assert.equal(
      new Set(queued.map((r) => r.id)).size,
      1,
      'Concurrent holders serialize on the gate and see committed idempotency data.',
    );
  } finally {
    await twoClients.end();
  }
  rows.pop(); // Remove this separate-date fixture before the remaining assertions.

  await submitDiscoveryJob(pool, { ...input, requestId: 'manual-new', triggerSource: 'manual' });
  assert.equal(rows.length, 2, 'Cron dedupe does not prohibit a new manual Run.');
  const open = await submitDiscoveryJob(pool, {
    ...input,
    mode: 'open',
    requestId: 'open-new',
    triggerSource: 'manual',
  });
  assert.equal(open.runType, 'open');
  assert.equal(open.parentRunId, 'run-2');
  await assert.rejects(
    submitDiscoveryJob(pool, {
      ...input,
      mode: 'open',
      requestId: 'open-other',
      triggerSource: 'manual',
    }),
    /已有排队/,
  );
  const before = rows.length;
  failInsert = true;
  await assert.rejects(
    submitDiscoveryJob(pool, { ...input, date: '2026-10-24', requestId: 'error-attempt' }),
    /Mock insert failed/,
  );
  failInsert = false;
  failCommit = true;
  await assert.rejects(
    submitDiscoveryJob(pool, { ...input, date: '2026-10-24', requestId: 'error-attempt' }),
    /Mock commit failed/,
  );
  failCommit = false;
  assert.equal(rows.length, before, 'An insert must not survive submission rollback.');
  failLock = true;
  await assert.rejects(
    submitDiscoveryJob(pool, { ...input, date: '2026-10-24', requestId: 'error-attempt' }),
    /submission lock wait timed out/,
  );
  failLock = false;
  assert.ok(rollbackCount >= 4);
  failInsert = failRollback = true;
  await assert.rejects(
    submitDiscoveryJob(pool, { ...input, date: '2026-10-24', requestId: 'broken-client' }),
    /submission rollback failed/,
  );
  assert.equal(pool.totalCount, 0, 'Discard the connection when rollback fails.');
  failInsert = failRollback = false;
  await submitDiscoveryJob(pool, { ...input, date: '2026-10-24', requestId: 'after-errors' });
  assert.equal(pool.idleCount, 1, 'Errors release the transaction and Pool client.');
  ready = true;
  const pending = await submitDiscoveryJob(pool, {
    ...input,
    date: '2026-10-26',
    requestId: 'ready-window',
  });
  assert.equal(pending.status, 'pending');
  assert.ok(
    pending.inputContentIds,
    'Ready Daily reads and insert share the single checked-out client.',
  );

  const held = await pool.connect();
  // pg-pool unrefs its checkout timer; the fake socket has no OS handle to keep Node alive.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      submitDiscoveryJob(pool, input),
      /timeout exceeded when trying to connect/,
    );
  } finally {
    clearTimeout(keepAlive);
    held.release();
  }
  await submitDiscoveryJob(pool, input);
  for (const profile of ['web', 'worker', 'cli', 'submission'] as const) {
    const options = databasePoolOptions(profile);
    assert.ok(options.max! > 0 && options.max! <= 10);
    assert.equal(options.connectionTimeoutMillis, 5000);
    assert.equal(options.idleTimeoutMillis, 10000);
  }
  assert.ok(databasePoolOptions('worker').max! >= 2);
  assert.ok(databasePoolOptions('cli').max! >= 2);
  console.log(
    'Discovery bounded pg-pool submissions, idempotency, atomic rollback, lock/checkout timeout and cleanup passed (no database).',
  );
} finally {
  await pool.end();
}
