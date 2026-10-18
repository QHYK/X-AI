import assert from 'node:assert/strict';
import type { DiscoveryRunRecord } from '../src/discovery/run-service.js';
import {
  runDiscoveryWorkflow,
  type DiscoveryWorkflowCounts,
  type OrchestratorServices,
} from '../src/discovery/workflow-orchestrator.js';

type Scenario = {
  leads: Array<Record<string, unknown>>;
  d2?: 'completed' | 'failed';
  d3: 'completed' | 'failed';
  d4: 'completed' | 'failed';
  d5?: 'completed' | 'failed';
  qualified?: number;
  initial?: 'new' | 'partial' | 'completed' | 'missing_state';
  manualOpen?: boolean;
};

async function execute(scenario: Scenario) {
  const initial = scenario.initial ?? 'new';
  const calls = { d2: 0, d3: 0, d4: 0, d5: 0 };
  const run = makeRun(initial, scenario.leads);
  const services: OrchestratorServices = {
    createRun: (async () => ({
      run,
      input: null,
      missingDailyDates: [],
    })) as OrchestratorServices['createRun'],
    startRun: (async () => {
      run.status = 'running';
      return run;
    }) as OrchestratorServices['startRun'],
    resumeRun: (async () => {
      run.status = 'running';
      return run;
    }) as OrchestratorServices['resumeRun'],
    getRun: (async () => run) as OrchestratorServices['getRun'],
    finishRun: (async (_pool, _id, outcome) => {
      run.status = outcome.status;
      run.endReason =
        outcome.status === 'completed'
          ? outcome.hasCandidates
            ? 'candidates_found'
            : 'no_candidates'
          : outcome.endReason;
      run.errorSummary = outcome.status === 'completed' ? null : outcome.errorSummary;
      return run;
    }) as OrchestratorServices['finishRun'],
    runD2: (async () => {
      calls.d2 += 1;
      if (scenario.d2 === 'failed') {
        run.executionState.d2 = state('failed');
        throw new Error('d2 failed');
      }
      run.selectionOutput = { leads: scenario.leads };
      run.executionState.d2 = state('completed');
      return { selection: { leads: scenario.leads } };
    }) as unknown as OrchestratorServices['runD2'],
    runD3: (async () => {
      calls.d3 += 1;
      run.executionState.d3 = state(scenario.d3);
      if (scenario.d3 === 'failed') throw new Error('d3 failed');
      return {};
    }) as unknown as OrchestratorServices['runD3'],
    runD4: (async () => {
      calls.d4 += 1;
      run.executionState.d4 = state(scenario.d4);
      if (scenario.d4 === 'failed') return { failures: [{ error: 'd4 failed' }] };
      return { failures: [] };
    }) as unknown as OrchestratorServices['runD4'],
    runD5: (async () => {
      calls.d5 += 1;
      run.executionState.d5 = state(scenario.d5 ?? 'completed');
      if (scenario.d5 === 'failed') throw new Error('d5 failed');
      return {};
    }) as unknown as OrchestratorServices['runD5'],
    createOpenRun: (async (_pool: unknown, input: { parentRunId: string }) => {
      run.runType = 'open';
      run.parentRunId = input.parentRunId;
      run.selectionOutput = null;
      run.status = 'pending';
      return run;
    }) as unknown as OrchestratorServices['createOpenRun'],
    resumeOpenRun: (async () => run) as unknown as OrchestratorServices['resumeOpenRun'],
    loadCounts: async (_pool, _id, selection): Promise<DiscoveryWorkflowCounts> => ({
      directLeads: selection.leads.filter((lead) => lead.kind === 'direct').length,
      topicLeads: selection.leads.filter((lead) => lead.kind === 'topic').length,
      candidates: scenario.qualified ?? 0,
      qualified: scenario.qualified ?? 0,
      submittedForReview: scenario.qualified ?? 0,
    }),
  };
  const report = await runDiscoveryWorkflow(
    {} as never,
    {
      ...(scenario.manualOpen
        ? { openParentRunId: '00000000-0000-4000-8000-000000000099' }
        : initial === 'new'
          ? { dailyDates: ['2026-10-14', '2026-10-15'] as const }
          : { runId: run.id }),
    },
    services,
  );
  return { report, calls, run };
}

function makeRun(
  initial: NonNullable<Scenario['initial']>,
  leads: Array<Record<string, unknown>>,
): DiscoveryRunRecord {
  const selection = initial === 'new' ? null : { leads };
  return {
    id: '00000000-0000-4000-8000-000000000001',
    parentRunId: null,
    sourceLeadId: null,
    runType: 'regular',
    triggerSource: 'manual',
    status: initial === 'completed' ? 'completed' : initial === 'new' ? 'pending' : 'partial',
    endReason: null,
    windowStartDate: '2026-10-14',
    windowEndDate: '2026-10-15',
    inputContentIds: { event: [], digest: [], longForm: [] },
    selectionOutput: selection,
    configSnapshot: null,
    executionState:
      initial === 'missing_state'
        ? {}
        : initial === 'completed'
          ? { d2: state('completed'), d3: state('completed'), d4: state('completed') }
          : selection
            ? { d2: state('completed') }
            : {},
    startedAt: null,
    finishedAt: null,
    errorSummary: null,
    createdAt: '',
    updatedAt: '',
  };
}

function state(status: 'completed' | 'failed') {
  return {
    status,
    endReason: status === 'completed' ? 'no_candidates' : 'error',
    completedAt: '',
    errorSummary: status === 'failed' ? 'failed' : null,
    provider: null,
    model: null,
    apiMode: null,
    elapsedMs: 0,
    usage: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      usageComplete: true,
    },
  } as const;
}

const direct = {
  leadId: 'lead-1',
  kind: 'direct',
  sourceContentId: 'content-1',
  url: 'https://example.com',
  rationale: 'x',
};
const topic = {
  leadId: 'lead-2',
  kind: 'topic',
  question: 'q',
  rationale: 'x',
  newsContext: 'n',
  sourceContentIds: ['content-2'],
};

const success = await execute({
  leads: [direct, topic],
  d3: 'completed',
  d4: 'completed',
  qualified: 1,
});
assert.equal(success.report.run.status, 'completed');
assert.deepEqual(success.calls, { d2: 1, d3: 1, d4: 1, d5: 0 });

const d2Failure = await execute({ leads: [], d2: 'failed', d3: 'completed', d4: 'completed' });
assert.equal(d2Failure.report.run.status, 'failed');
assert.deepEqual(d2Failure.calls, { d2: 1, d3: 0, d4: 0, d5: 0 });

const empty = await execute({ leads: [], d3: 'completed', d4: 'completed' });
assert.equal(empty.calls.d5, 1);
assert.equal(empty.report.branchStates.d5?.status, 'completed');
assert.equal(empty.report.d5Eligible, false);
assert.equal(empty.report.run.endReason, 'no_candidates');

const directOnly = await execute({ leads: [direct], d3: 'completed', d4: 'completed' });
assert.equal(directOnly.report.counts.topicLeads, 0);
const topicOnly = await execute({ leads: [topic], d3: 'completed', d4: 'completed' });
assert.equal(topicOnly.report.counts.directLeads, 0);

const d3Failure = await execute({ leads: [direct, topic], d3: 'failed', d4: 'completed' });
assert.equal(d3Failure.report.run.status, 'partial');
assert.equal(d3Failure.calls.d4, 1);
assert.equal(d3Failure.report.d5Eligible, false);

const d4Failure = await execute({ leads: [direct], d3: 'completed', d4: 'failed' });
assert.equal(d4Failure.report.run.status, 'partial');
assert.equal(d4Failure.report.d5Eligible, false);

const resumed = await execute({
  leads: [topic],
  d3: 'completed',
  d4: 'completed',
  initial: 'partial',
});
assert.deepEqual(resumed.calls, { d2: 0, d3: 1, d4: 1, d5: 1 });

const completed = await execute({
  leads: [topic],
  d3: 'completed',
  d4: 'completed',
  qualified: 1,
  initial: 'completed',
});
assert.deepEqual(completed.calls, { d2: 0, d3: 0, d4: 0, d5: 0 });

const historicalMissingState = await execute({
  leads: [topic],
  d3: 'completed',
  d4: 'completed',
  initial: 'missing_state',
});
assert.deepEqual(historicalMissingState.calls, { d2: 0, d3: 1, d4: 1, d5: 1 });

const d5Failure = await execute({ leads: [], d3: 'completed', d4: 'completed', d5: 'failed' });
assert.equal(d5Failure.report.run.status, 'partial');
assert.equal(d5Failure.calls.d5, 1);

const manualOpen = await execute({
  leads: [],
  d3: 'completed',
  d4: 'completed',
  manualOpen: true,
});
assert.equal(manualOpen.report.run.runType, 'open');
assert.equal(manualOpen.report.run.parentRunId, '00000000-0000-4000-8000-000000000099');
assert.deepEqual(manualOpen.calls, { d2: 0, d3: 0, d4: 0, d5: 1 });

console.log('Discovery orchestrator mock tests passed.');
