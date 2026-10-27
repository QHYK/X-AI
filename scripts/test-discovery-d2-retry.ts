/** Same-Run queue transition + real Worker/Orchestrator wiring; no database or paid requests. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import type { DiscoveryBranchExecutionState, DiscoveryExecutionState } from '../src/db/schema.js';
import {
  submitDiscoveryD2Retry,
  processNextDiscoveryJob,
  DiscoveryJobConflict,
} from '../src/discovery/background-jobs.js';
import {
  getDiscoveryRun,
  startDiscoveryRun,
  finishDiscoveryRun,
} from '../src/discovery/run-service.js';
import {
  runDiscoveryWorkflow,
  type OrchestratorServices,
} from '../src/discovery/workflow-orchestrator.js';
import { canRetryDiscoveryD2 } from '../src/lib/discovery-d2-retry.js';
const id = '00000000-0000-4000-8000-000000000822';
const prompt = '00000000-0000-4000-8000-000000000823';
const stage = (status: string) =>
  ({
    status,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      usageComplete: true,
    },
    elapsedMs: 0,
    completedAt: null,
    errorSummary: null,
    endReason: null,
    provider: null,
    model: null,
    apiMode: null,
  }) as DiscoveryBranchExecutionState;
const row = {
  id,
  run_type: 'regular',
  parent_run_id: null,
  source_lead_id: null,
  trigger_source: 'manual',
  status: 'failed',
  end_reason: 'error',
  window_start_date: '2026-10-25',
  window_end_date: '2026-10-26',
  input_content_ids: {
    event: [],
    digest: [{ id: 'original-input', dailyDate: '2026-10-26' }],
    longForm: [],
  },
  selection_output: null as Record<string, unknown> | null,
  execution_state: { d2: stage('failed') } as Record<string, ReturnType<typeof stage>>,
  config_snapshot: {
    dashboardJob: { requestId: 'original-submission' },
    promptVersions: { 'discovery.d2.topic_selection': prompt },
  } as Record<string, unknown>,
  started_at: '2026-10-26T00:00:00Z',
  finished_at: '2026-10-26T00:00:01Z',
  error_summary: 'D2 failed',
  created_at: '2026-10-26T00:00:00Z',
  updated_at: '2026-10-26T00:00:01Z',
};
let gate = Promise.resolve(),
  held = false,
  candidates = false,
  releases = 0,
  creates = 0;
const dbQuery = async (sql: string, p: unknown[] = []) => {
  if (sql.includes('from discovery_runs where id'))
    return { rows: p[0] === id ? [structuredClone(row)] : [] };
  if (sql.includes('from discovery_candidates'))
    return { rows: candidates ? [{ id: 'candidate' }] : [] };
  if (sql.includes("status in ('pending', 'running')") && sql.includes('select'))
    return { rows: ['pending', 'running'].includes(row.status) ? [{ id }] : [] };
  if (sql.includes("set status = 'pending'")) {
    assert.equal(row.status, 'failed');
    row.status = 'pending';
    row.config_snapshot.dashboardJob = {
      ...(row.config_snapshot.dashboardJob as object),
      d2RetryRequestIds: [
        ...((row.config_snapshot.dashboardJob as { d2RetryRequestIds?: string[] })
          .d2RetryRequestIds ?? []),
        p[1],
      ],
    };
    return { rows: [{ id }], rowCount: 1 };
  }
  if (sql.includes('Executor interrupted')) return { rows: [], rowCount: 0 };
  if (sql.includes("status = 'pending'") && sql.includes('select id'))
    return { rows: row.status === 'pending' ? [{ id }] : [] };
  if (sql.includes("set status = 'running'")) {
    row.status = 'running';
    return { rows: [structuredClone(row)], rowCount: 1 };
  }
  if (sql.includes('set status = $2')) {
    row.status = String(p[1]);
    return { rows: [structuredClone(row)], rowCount: 1 };
  }
  if (sql.includes('insert into discovery_runs')) {
    creates++;
    throw new Error('D2 Retry must not create a Run.');
  }
  throw new Error(`Unexpected SQL: ${sql}`);
};
const pool = {
  query: dbQuery,
  connect: async () => {
    let unlock: (() => void) | undefined;
    return Object.assign(new EventEmitter(), {
      query: async (sql: string, p: unknown[] = []) => {
        if (sql === 'begin' || sql.startsWith('set local')) return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          const before = gate;
          gate = new Promise<void>((r) => {
            unlock = r;
          });
          await before;
          return { rows: [] };
        }
        if (sql === 'commit' || sql === 'rollback') {
          unlock?.();
          return { rows: [] };
        }
        if (sql.includes('pg_try_advisory_lock')) {
          if (held) return { rows: [{ locked: false }] };
          held = true;
          return { rows: [{ locked: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          held = false;
          return { rows: [] };
        }
        if (sql === 'select id from discovery_runs where id = $1::uuid for update')
          return { rows: [{ id }] };
        return dbQuery(sql, p);
      },
      release: () => {
        releases++;
      },
    });
  },
} as unknown as Pool;
const originalInput = structuredClone(row.input_content_ids);
const originalConfig = structuredClone(row.config_snapshot);
const input = { runId: id, requestId: 'a'.repeat(32) };
const duplicate = await Promise.all([
  submitDiscoveryD2Retry(pool, input),
  submitDiscoveryD2Retry(pool, input),
]);
assert.ok(duplicate.every((r) => r.id === id && r.status === 'pending'));
assert.equal(creates, 0);
assert.equal(
  (row.config_snapshot.dashboardJob as { requestId: string }).requestId,
  'original-submission',
);
assert.deepEqual(row.input_content_ids, originalInput);
assert.deepEqual(row.config_snapshot.promptVersions, originalConfig.promptVersions);
await assert.rejects(
  submitDiscoveryD2Retry(pool, { ...input, requestId: 'b'.repeat(32) }),
  DiscoveryJobConflict,
);
held = true;
assert.equal(await processNextDiscoveryJob(pool), false);
held = false;
let d2 = 0,
  d3 = 0,
  d4 = 0;
const services = {
  getRun: getDiscoveryRun,
  startRun: startDiscoveryRun,
  finishRun: finishDiscoveryRun,
  runD2: async () => {
    assert.equal(held, true);
    d2++;
    assert.deepEqual(row.input_content_ids, originalInput);
    assert.deepEqual(row.config_snapshot.promptVersions, originalConfig.promptVersions);
    row.selection_output = { leads: [] };
    row.execution_state.d2 = stage('completed');
    return { selection: { leads: [] } };
  },
  runD3: async () => {
    d3++;
    row.execution_state.d3 = stage('completed');
    return {};
  },
  runD4: async () => {
    d4++;
    row.execution_state.d4 = stage('completed');
    return {};
  },
  loadCounts: async () => ({
    directLeads: 0,
    topicLeads: 0,
    candidates: 1,
    qualified: 1,
    submittedForReview: 1,
  }),
} as unknown as OrchestratorServices;
const execute = (db: Pool, options: Parameters<typeof runDiscoveryWorkflow>[1]) =>
  runDiscoveryWorkflow(db, options, services);
assert.equal(await processNextDiscoveryJob(pool, execute), true);
assert.deepEqual([d2, d3, d4], [1, 1, 1]);
assert.equal(row.status, 'completed');
assert.equal(held, false);
assert.equal(await processNextDiscoveryJob(pool, execute), false);
await submitDiscoveryD2Retry(pool, input);
assert.deepEqual([d2, d3, d4], [1, 1, 1]);
await assert.rejects(
  submitDiscoveryD2Retry(pool, { ...input, requestId: 'c'.repeat(32) }),
  DiscoveryJobConflict,
);
const eligible = {
  ...(await getDiscoveryRun(pool, id))!,
  status: 'failed' as const,
  selectionOutput: null,
  executionState: { d2: stage('failed') } as DiscoveryExecutionState,
};
assert.equal(canRetryDiscoveryD2(eligible, false), true);
for (const status of ['pending', 'running', 'completed', 'partial'] as const)
  assert.equal(canRetryDiscoveryD2({ ...eligible, status }, false), false);
assert.equal(canRetryDiscoveryD2({ ...eligible, selectionOutput: { leads: [] } }, false), false);
assert.equal(canRetryDiscoveryD2({ ...eligible, configSnapshot: {} }, false), false);
assert.equal(canRetryDiscoveryD2(eligible, true), false);
assert.equal(
  canRetryDiscoveryD2(
    {
      ...eligible,
      executionState: { ...eligible.executionState, d3: { status: 'completed' } as never },
    },
    false,
  ),
  false,
);
// State validation errors roll back and release the submission gate for later requests.
row.status = 'failed';
row.selection_output = null;
row.execution_state = { d2: stage('failed') };
candidates = true;
await assert.rejects(
  submitDiscoveryD2Retry(pool, { ...input, requestId: 'd'.repeat(32) }),
  DiscoveryJobConflict,
);
candidates = false;
await submitDiscoveryD2Retry(pool, { ...input, requestId: 'e'.repeat(32) });
assert.equal(row.status, 'pending');
assert.ok(releases > 5);
console.log(
  'D2 Retry: same Run/inputs/Prompt, durable dedupe, state guards, global Worker lock and D2→D3/D4 continuation passed.',
);

row.status = 'failed';
const delayed = await submitDiscoveryD2Retry(pool, input);
assert.equal(
  delayed.status,
  'failed',
  'A delayed request from an older attempt must not enqueue another paid attempt.',
);
