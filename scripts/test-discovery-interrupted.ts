/** Explicit CLI recovery under the real global lock wrapper; no external I/O. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Pool } from 'pg';
import { withDiscoveryExecutionLock } from '../src/discovery/background-jobs.js';
import {
  getDiscoveryRun,
  resumeDiscoveryRun,
  resumeOpenDiscoveryRun,
  finishDiscoveryRun,
} from '../src/discovery/run-service.js';
import {
  runDiscoveryWorkflow,
  type OrchestratorServices,
} from '../src/discovery/workflow-orchestrator.js';
import { databasePoolOptions } from '../src/db/pool-options.js';

const id = '00000000-0000-4000-8000-000000000777';
const state = (status: string) => ({
  status,
  completedAt: status === 'completed' ? '2026-10-26T00:00:00Z' : null,
  usage: {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    usageComplete: true,
  },
  elapsedMs: 0,
});
function row() {
  return {
    id,
    run_type: 'regular',
    parent_run_id: null as string | null,
    source_lead_id: null,
    trigger_source: 'manual',
    status: 'running',
    end_reason: null as string | null,
    window_start_date: '2026-10-25',
    window_end_date: '2026-10-26',
    input_content_ids: { event: [], digest: [], longForm: [] },
    selection_output: { leads: [] } as Record<string, unknown> | null,
    execution_state: {
      d2: state('completed'),
      d3: state('completed'),
      d4: state('running'),
    } as Record<string, ReturnType<typeof state>>,
    config_snapshot: {} as Record<string, unknown>,
    started_at: '2026-10-26T00:00:00Z',
    finished_at: null,
    error_summary: null,
    created_at: '2026-10-26T00:00:00Z',
    updated_at: '2026-10-26T00:00:00Z',
  };
}
let stored = row(),
  held = true,
  released = 0,
  reads = 0,
  paidSteps = 0,
  executions = 0;
const query = async (sql: string, p: unknown[] = []) => {
  if (sql.includes('from discovery_runs where id')) {
    reads++;
    return { rows: [structuredClone(stored)] };
  }
  if (sql.includes('update discovery_runs')) {
    assert.equal(held, true, 'Every recovery/Resume mutation stays under the global lock.');
    if (sql.includes("set status = 'running'")) {
      assert.equal(stored.status, 'failed');
      stored.status = 'running';
    } else {
      assert.equal(stored.status, 'running');
      stored.status = String(p[1]);
      stored.end_reason = String(p[2]);
    }
    return { rows: [structuredClone(stored)], rowCount: 1 };
  }
  throw new Error(`Unexpected SQL: ${sql}`);
};
const pool = {
  query,
  connect: async () =>
    Object.assign(new EventEmitter(), {
      query: async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock')) {
          if (held) return { rows: [{ locked: false }] };
          held = true;
          return { rows: [{ locked: true }] };
        }
        assert.ok(sql.includes('pg_advisory_unlock'));
        held = false;
        return { rows: [] };
      },
      release: () => {
        released++;
      },
    }),
  end: async () => {},
} as unknown as Pool;
const services = {
  getRun: getDiscoveryRun,
  resumeRun: resumeDiscoveryRun,
  resumeOpenRun: resumeOpenDiscoveryRun,
  finishRun: finishDiscoveryRun,
  runD2: async () => {
    throw new Error('Completed D2 must not run.');
  },
  runD3: async () => {
    throw new Error('Completed D3 must not run.');
  },
  runD4: async () => {
    assert.equal(held, true);
    paidSteps++;
    stored.execution_state.d4 = state('completed');
    return {};
  },
  runD5: async () => {
    assert.equal(held, true);
    paidSteps++;
    stored.execution_state.d5 = state('completed');
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
const source = await readFile(new URL('./run-discovery-workflow.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('cli.ts', source, ts.ScriptTarget.Latest, true);
const body = parsed.statements
  .filter((n) => ts.isFunctionDeclaration(n) && ['main', 'parseOptions'].includes(n.name!.text))
  .map((n) => n.getText(parsed))
  .join('\n');
const invoke = (args: string[]) =>
  runInNewContext(
    ts.transpileModule(body + '\nmain();', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      process: { argv: ['node', 'cli', ...args], env: { DATABASE_URL: 'mock-only' } },
      console: { log: () => {} },
      Pool: class {
        constructor() {
          return pool;
        }
      },
      databasePoolOptions,
      withDiscoveryExecutionLock,
      runDiscoveryWorkflow: async (
        db: Pool,
        options: Parameters<typeof runDiscoveryWorkflow>[1],
      ) => {
        executions++;
        assert.equal(held, true);
        return runDiscoveryWorkflow(db, options, services);
      },
      formatDiscoveryWorkflowReport: () => ({}),
    },
  ) as Promise<void>;
const args = [`--run-id=${id}`, '--recover-interrupted', '--confirm-paid'];
await assert.rejects(invoke(args), /Another Discovery executor/);
assert.equal(reads, 0);
assert.equal(paidSteps, 0);
assert.equal(stored.status, 'running');
held = false;
await invoke(args);
assert.equal(stored.status, 'completed');
assert.equal(paidSteps, 1);
assert.equal(held, false);
assert.equal(executions, 1);
assert.equal(stored.execution_state.d3!.status, 'completed');
assert.equal(stored.selection_output?.leads instanceof Array, true);
// Reuse completed D3/D4 and run only unfinished D5.
stored = row();
stored.execution_state.d4 = state('completed');
stored.execution_state.d5 = state('running');
services.loadCounts = async () => ({
  directLeads: 0,
  topicLeads: 0,
  candidates: 0,
  qualified: 0,
  submittedForReview: 0,
});
const prior = paidSteps;
await invoke(args);
assert.equal(paidSteps, prior + 1);
assert.equal(stored.status, 'completed');
// Independent Open-only Runs can resume without fabricating D2 state.
stored = row();
stored.run_type = 'open';
stored.parent_run_id = id;
stored.selection_output = null;
stored.execution_state = { d5: state('running') };
await invoke(args);
assert.equal(stored.status, 'completed');
for (const invalid of [
  'missing-selection',
  'invalid-selection',
  'unknown-stage',
  'missing-stage-history',
  'unsupported',
] as const) {
  stored = row();
  if (invalid === 'missing-selection') stored.selection_output = null;
  if (invalid === 'invalid-selection') stored.selection_output = { leads: [{}] };
  if (invalid === 'unknown-stage') stored.execution_state.d3 = state('unknown');
  if (invalid === 'missing-stage-history') {
    delete stored.execution_state.d3;
    stored.config_snapshot.d3 = { model: 'historic' };
  }
  if (invalid === 'unsupported') stored.run_type = 'single_lead';
  const before: number = paidSteps;
  await assert.rejects(invoke(args), /Cannot recover|ambiguous|Unsupported/);
  assert.equal(stored.status, 'running');
  assert.equal(paidSteps, before);
  assert.equal(held, false);
}
stored = row();
stored.status = 'failed';
await assert.rejects(invoke(args), /without --recover-interrupted/);
await assert.rejects(
  invoke(['--dates=2026-10-25,2026-10-26', '--recover-interrupted', '--confirm-paid']),
  /requires --run-id/,
);
assert.ok(released >= 8);
console.log(
  'Explicit CLI interrupted recovery: lock refusal/release, completed-step reuse, Open Resume and ambiguous-state rejection passed.',
);
