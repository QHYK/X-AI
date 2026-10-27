import type { Pool } from 'pg';
import type { DiscoveryBranchExecutionState } from '../db/schema.js';
import { runDiscoveryD4 } from './direct-verification.js';
import {
  createRegularDiscoveryRun,
  finishDiscoveryRun,
  getDiscoveryRun,
  resumeDiscoveryRun,
  startDiscoveryRun,
  type DiscoveryRunRecord,
} from './run-service.js';
import { runDiscoveryD3 } from './topic-discovery.js';
import { runDiscoveryD5 } from './open-discovery.js';
import { runDiscoveryD2, type DiscoverySelectionOutput } from './topic-selection.js';
import { createOpenDiscoveryRun, resumeOpenDiscoveryRun } from './run-service.js';
import type { DiscoveryDailyDatePair } from './daily-read-adapter.js';
import { discoveryCacheHitRate } from './execution-diagnostics.js';

export type DiscoveryWorkflowCounts = {
  directLeads: number;
  topicLeads: number;
  candidates: number;
  qualified: number;
  submittedForReview: number;
};

export type DiscoveryWorkflowReport = {
  run: DiscoveryRunRecord;
  counts: DiscoveryWorkflowCounts;
  d5Eligible: boolean;
  branchStates: {
    d2: DiscoveryBranchExecutionState | null;
    d3: DiscoveryBranchExecutionState | null;
    d4: DiscoveryBranchExecutionState | null;
    d5: DiscoveryBranchExecutionState | null;
  };
};

export type OrchestratorServices = {
  createRun: typeof createRegularDiscoveryRun;
  startRun: typeof startDiscoveryRun;
  resumeRun: typeof resumeDiscoveryRun;
  getRun: typeof getDiscoveryRun;
  finishRun: typeof finishDiscoveryRun;
  runD2: typeof runDiscoveryD2;
  runD3: typeof runDiscoveryD3;
  runD4: typeof runDiscoveryD4;
  runD5: typeof runDiscoveryD5;
  createOpenRun: typeof createOpenDiscoveryRun;
  resumeOpenRun: typeof resumeOpenDiscoveryRun;
  loadCounts: (
    pool: Pool,
    runId: string,
    selection: DiscoverySelectionOutput,
  ) => Promise<DiscoveryWorkflowCounts>;
};

const defaults: OrchestratorServices = {
  createRun: createRegularDiscoveryRun,
  startRun: startDiscoveryRun,
  resumeRun: resumeDiscoveryRun,
  getRun: getDiscoveryRun,
  finishRun: finishDiscoveryRun,
  runD2: runDiscoveryD2,
  runD3: runDiscoveryD3,
  runD4: runDiscoveryD4,
  runD5: runDiscoveryD5,
  createOpenRun: createOpenDiscoveryRun,
  resumeOpenRun: resumeOpenDiscoveryRun,
  loadCounts: loadDiscoveryWorkflowCounts,
};

export type RunDiscoveryWorkflowOptions = {
  queuedRunId?: string;
  dailyDates?: DiscoveryDailyDatePair;
  runId?: string;
  openParentRunId?: string;
  openContext?: string;
  triggerSource?: 'schedule' | 'manual';
};

async function runManualOpenDiscovery(
  pool: Pool,
  options: RunDiscoveryWorkflowOptions,
  services: OrchestratorServices,
): Promise<DiscoveryWorkflowReport> {
  const parentRunId = options.openParentRunId;
  if (!parentRunId) throw new Error('openParentRunId is required for manual Open Discovery.');
  const run = await services.createOpenRun(pool, {
    parentRunId,
    manualContext: options.openContext,
    triggerSource: 'manual',
  });
  const running = await services.startRun(pool, run.id);
  return executeOpenRun(pool, running, services);
}

async function executeOpenRun(
  pool: Pool,
  run: DiscoveryRunRecord,
  services: OrchestratorServices,
): Promise<DiscoveryWorkflowReport> {
  let d5Error: string | null = null;
  try {
    await services.runD5(pool, run.id);
  } catch (error) {
    d5Error = errorMessage(error);
  }
  const current = await services.getRun(pool, run.id);
  if (!current) throw new Error(`Discovery Run disappeared: ${run.id}`);
  const counts = await services.loadCounts(pool, current.id, { leads: [] });
  const d5 = current.executionState.d5;
  const outcome =
    !d5Error && d5?.status === 'completed'
      ? { status: 'completed' as const, hasCandidates: counts.qualified > 0 }
      : {
          status: 'partial' as const,
          endReason: 'error' as const,
          errorSummary: d5Error ?? d5?.errorSummary ?? 'D5 did not complete.',
        };
  const finished = await services.finishRun(pool, current.id, outcome);
  return buildReport(finished, counts);
}

/**
 * Thin D2→D5 coordinator. Stages remain the owners of prompts, validation,
 * persistence, traces and branch-level resume behaviour.
 */
export async function runDiscoveryWorkflow(
  pool: Pool,
  options: RunDiscoveryWorkflowOptions,
  services: OrchestratorServices = defaults,
): Promise<DiscoveryWorkflowReport> {
  if (options.openParentRunId) {
    return runManualOpenDiscovery(pool, options, services);
  }
  let run: DiscoveryRunRecord;
  let selection: DiscoverySelectionOutput;

  if (options.queuedRunId) {
    const pending = await services.getRun(pool, options.queuedRunId);
    if (!pending || pending.status !== 'pending') throw new Error('Queued Run must be pending.');
    run = await services.startRun(pool, pending.id);
    if (run.runType === 'open') return executeOpenRun(pool, run, services);
    if (run.runType !== 'regular') throw new Error('Unsupported queued Run type.');
    try {
      selection = (await services.runD2(pool, run.id)).selection;
    } catch (error) {
      return buildReport(
        await services.finishRun(pool, run.id, {
          status: 'failed',
          endReason: 'error',
          errorSummary: errorMessage(error),
        }),
        emptyCounts(),
      );
    }
  } else if (options.runId) {
    const existing = await services.getRun(pool, options.runId);
    if (!existing) throw new Error(`Discovery Run not found: ${options.runId}`);
    if (existing.runType === 'open') {
      if (existing.executionState.d5?.status === 'completed' && existing.status === 'completed') {
        return buildReport(existing, await services.loadCounts(pool, existing.id, { leads: [] }));
      }
      if (existing.status === 'running') throw new Error('Discovery Run is already running.');
      if (existing.status !== 'partial' && existing.status !== 'failed') {
        throw new Error(
          `Open Discovery Run ${existing.id} cannot be resumed from status ${existing.status}.`,
        );
      }
      return executeOpenRun(pool, await services.resumeOpenRun(pool, existing.id), services);
    }
    if (!existing.selectionOutput) {
      throw new Error(
        'This Run has no persisted D2 selection_output; create a new Regular Run to retry D2.',
      );
    }
    if (existing.status === 'completed') {
      if (
        existing.executionState.d3?.status === 'completed' &&
        existing.executionState.d4?.status === 'completed' &&
        (existing.executionState.d5?.status === 'completed' ||
          (await services.loadCounts(pool, existing.id, readSelection(existing))).qualified > 0)
      ) {
        return buildReport(
          existing,
          await services.loadCounts(pool, existing.id, readSelection(existing)),
        );
      }
      throw new Error(
        'Completed Run lacks explicit D3/D4 completion state; create a new Run instead of inferring historical branch completion.',
      );
    }
    if (existing.status === 'running') {
      throw new Error('Discovery Run is already running.');
    }
    if (existing.status !== 'partial' && existing.status !== 'failed') {
      throw new Error(
        `Discovery Run ${existing.id} cannot be resumed from status ${existing.status}.`,
      );
    }
    run = await services.resumeRun(pool, existing.id);
    selection = readSelection(run);
  } else {
    if (!options.dailyDates)
      throw new Error('dailyDates are required when creating a Discovery Run.');
    const created = await services.createRun(pool, {
      dailyDates: options.dailyDates,
      triggerSource: options.triggerSource ?? 'manual',
    });
    if (created.run.status === 'blocked') {
      return buildReport(created.run, emptyCounts());
    }
    run = await services.startRun(pool, created.run.id);
    try {
      selection = (await services.runD2(pool, run.id)).selection;
    } catch (error) {
      const message = errorMessage(error);
      const failed = await services.finishRun(pool, run.id, {
        status: 'failed',
        endReason: 'error',
        errorSummary: message,
      });
      return buildReport(failed, emptyCounts());
    }
  }

  // D3 and D4 are deliberately sequential here, but independently isolated.
  // A D3 failure must not prevent Direct verification from preserving work.
  let d3Error: string | null = null;
  try {
    if (run.executionState.d3?.status !== 'completed') await services.runD3(pool, run.id);
  } catch (error) {
    d3Error = errorMessage(error);
  }

  let d4Error: string | null = null;
  try {
    if (run.executionState.d4?.status !== 'completed') await services.runD4(pool, run.id);
  } catch (error) {
    d4Error = errorMessage(error);
  }

  const current = await services.getRun(pool, run.id);
  if (!current) throw new Error(`Discovery Run disappeared: ${run.id}`);
  const counts = await services.loadCounts(pool, run.id, selection);
  const d5Required =
    current.executionState.d3?.status === 'completed' &&
    current.executionState.d4?.status === 'completed' &&
    counts.qualified === 0;
  let d5Error: string | null = null;
  if (d5Required && current.executionState.d5?.status !== 'completed') {
    try {
      await services.runD5(pool, current.id);
    } catch (error) {
      d5Error = errorMessage(error);
    }
  }
  const afterD5 = (await services.getRun(pool, run.id)) ?? current;
  const finalCounts = await services.loadCounts(pool, run.id, selection);
  const outcome = determineFinalOutcome(
    afterD5,
    finalCounts,
    d3Error,
    d4Error,
    d5Required,
    d5Error,
  );
  const finished = await services.finishRun(pool, run.id, outcome);
  return buildReport(finished, finalCounts);
}

function determineFinalOutcome(
  run: DiscoveryRunRecord,
  counts: DiscoveryWorkflowCounts,
  d3Error: string | null,
  d4Error: string | null,
  d5Required: boolean,
  d5Error: string | null,
):
  | { status: 'completed'; hasCandidates: boolean }
  | { status: 'partial' | 'failed'; endReason: 'error'; errorSummary: string } {
  const d3 = run.executionState.d3;
  const d4 = run.executionState.d4;
  const d5 = run.executionState.d5;
  const failures = [
    d3?.status === 'failed' ? d3.errorSummary : null,
    d4?.status === 'failed' ? d4.errorSummary : null,
    d3Error,
    d4Error,
    d5?.status === 'failed' ? d5.errorSummary : null,
    d5Error,
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  if (
    failures.length === 0 &&
    d3?.status === 'completed' &&
    d4?.status === 'completed' &&
    (!d5Required || d5?.status === 'completed')
  ) {
    return { status: 'completed', hasCandidates: counts.qualified > 0 };
  }
  return {
    status: d3?.status === 'failed' && d4?.status === 'failed' ? 'failed' : 'partial',
    endReason: 'error',
    errorSummary: failures.join('; ') || 'Discovery branches did not both complete.',
  };
}

function buildReport(
  run: DiscoveryRunRecord,
  counts: DiscoveryWorkflowCounts,
): DiscoveryWorkflowReport {
  const d3 = run.executionState.d3 ?? null;
  const d4 = run.executionState.d4 ?? null;
  const d5 = run.executionState.d5 ?? null;
  return {
    run,
    counts,
    branchStates: { d2: run.executionState.d2 ?? null, d3, d4, d5 },
    d5Eligible:
      d3?.status === 'completed' &&
      d4?.status === 'completed' &&
      counts.qualified === 0 &&
      d5?.status !== 'completed',
  };
}

function readSelection(run: DiscoveryRunRecord): DiscoverySelectionOutput {
  const value = run.selectionOutput;
  if (!value || !Array.isArray(value.leads))
    throw new Error('Persisted D2 selection_output is invalid.');
  return value as unknown as DiscoverySelectionOutput;
}

function emptyCounts(): DiscoveryWorkflowCounts {
  return { directLeads: 0, topicLeads: 0, candidates: 0, qualified: 0, submittedForReview: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadDiscoveryWorkflowCounts(
  pool: Pool,
  runId: string,
  selection: DiscoverySelectionOutput,
): Promise<DiscoveryWorkflowCounts> {
  const result = await pool.query<{
    candidates: string;
    qualified: string;
    submitted_for_review: string;
  }>(
    `select
       count(dc.id)::text as candidates,
       count(*) filter (where evaluation->>'decision' = 'qualified')::text as qualified,
       count(idc.id)::text as submitted_for_review
     from discovery_candidates dc
     left join in_depth_candidates idc on idc.discovery_candidate_id = dc.id
     where dc.run_id = $1::uuid`,
    [runId],
  );
  const row = result.rows[0];
  return {
    directLeads: selection.leads.filter((lead) => lead.kind === 'direct').length,
    topicLeads: selection.leads.filter((lead) => lead.kind === 'topic').length,
    candidates: Number(row?.candidates ?? 0),
    qualified: Number(row?.qualified ?? 0),
    submittedForReview: Number(row?.submitted_for_review ?? 0),
  };
}

export function formatDiscoveryWorkflowReport(
  report: DiscoveryWorkflowReport,
): Record<string, unknown> {
  const stage = (state: DiscoveryBranchExecutionState | null) => ({
    status: state?.status ?? 'not_executed',
    endReason: state?.endReason ?? null,
    provider: state?.provider ?? null,
    model: state?.model ?? null,
    apiMode: state?.apiMode ?? null,
    elapsedMs: state?.elapsedMs ?? null,
    usage: state
      ? {
          ...state.usage,
          totalTokens:
            state.usage.inputTokens === null || state.usage.outputTokens === null
              ? null
              : state.usage.inputTokens + state.usage.outputTokens,
          cacheHitRate: discoveryCacheHitRate(state.usage),
        }
      : null,
    errorSummary: state?.errorSummary ?? null,
  });
  return {
    runId: report.run.id,
    runType: report.run.runType,
    parentRunId: report.run.parentRunId,
    dailyDates: [report.run.windowStartDate, report.run.windowEndDate],
    status: report.run.status,
    endReason: report.run.endReason,
    stages: {
      d2: stage(report.branchStates.d2),
      d3: stage(report.branchStates.d3),
      d4: stage(report.branchStates.d4),
      d5: stage(report.branchStates.d5),
    },
    counts: report.counts,
    d5Eligible: report.d5Eligible,
    errorSummary: report.run.errorSummary,
  };
}
