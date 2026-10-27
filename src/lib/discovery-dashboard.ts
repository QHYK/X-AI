import { canRetryDiscoveryD2 } from './discovery-d2-retry.js';
import { parseBriefDate } from './brief-date.js';
import type { Pool } from 'pg';
import type { DiscoveryRunRecord } from '../discovery/run-service.js';
import type {
  DiscoveryBranchExecutionState,
  DiscoveryStage,
  DiscoveryExecutionState,
} from '../db/schema.js';
import {
  emptyDiscoveryStageUsage,
  mergeDiscoveryStageUsage,
  normalizeDiscoveryStageUsage,
  discoveryCacheHitRate,
} from '../discovery/execution-diagnostics.js';

export function discoveryRunCacheMetrics(runType: string, stages: DiscoveryDashboardRun['stages']) {
  const keys =
    runType === 'open'
      ? (['d5'] as const)
      : (['d2', 'd3', 'd4', ...(stages.d5 ? ['d5' as const] : [])] as const);
  let usage = emptyDiscoveryStageUsage();
  for (const key of keys)
    usage = mergeDiscoveryStageUsage(
      usage,
      normalizeDiscoveryStageUsage(stages[key as DiscoveryStage]?.usage),
    );
  return { cachedInputTokens: usage.cachedInputTokens, cacheHitRate: discoveryCacheHitRate(usage) };
}

export async function getDiscoveryActiveRunForDate(db: Pick<Pool, 'query'>, date: string) {
  const result = await db.query<{ id: string; status: string; errorSummary: string | null }>(
    `select id, status, error_summary as "errorSummary" from discovery_runs where window_end_date = $1::date
      and status in ('pending', 'running') order by created_at, id limit 1`,
    [date],
  );
  return result.rows[0] ?? null;
}

export type DiscoveryDashboardRun = {
  id: string;
  runType: string;
  status: string;
  endReason: string | null;
  errorSummary?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  runCount: number;
  candidateCount: number;
  d2RetryAvailable?: boolean;
  reviewCount: number;
  topicQuestions: string[];
  stages: Partial<Record<DiscoveryStage, Partial<DiscoveryBranchExecutionState>>>;
};

export type DiscoveryDashboard = {
  regularRun: DiscoveryDashboardRun | null;
  d5: {
    runId: string;
    runType: string;
    executedAt: string | null;
    state: Partial<DiscoveryBranchExecutionState>;
  } | null;
};

/** Keep Regular summaries separate from independently retried D5 executions. */
export async function getDiscoveryRunForDate(
  db: Pick<Pool, 'query'>,
  selectedDate: string,
  now = new Date(),
): Promise<DiscoveryDashboard | null> {
  if (!parseBriefDate(selectedDate)) throw new Error('Invalid Dashboard date.');
  const [regularRun, result] = await Promise.all([
    getLatestRegularRun(db, selectedDate, now),
    db.query<{
      id: string;
      run_type: string;
      d5: Partial<DiscoveryBranchExecutionState>;
      executed_at: Date | string | null;
    }>(
      `select id, run_type, execution_state->'d5' as d5,
              coalesce((execution_state->'d5'->>'completedAt')::timestamptz,
                       updated_at, started_at) as executed_at
         from discovery_runs
        where window_end_date = $1::date
          and execution_state->'d5'->>'status' in ('running', 'completed', 'failed')
        order by executed_at desc nulls last, id desc limit 1`,
      [selectedDate],
    ),
  ]);
  const row = result.rows[0];
  if (!regularRun && !row) return null;
  return {
    regularRun,
    d5: row
      ? {
          runId: row.id,
          runType: row.run_type,
          executedAt: row.executed_at ? new Date(row.executed_at).toISOString() : null,
          state: row.d5,
        }
      : null,
  };
}

/** Business date belongs to the input window; timestamps only order attempts and show timing. */
async function getLatestRegularRun(
  db: Pick<Pool, 'query'>,
  selectedDate: string,
  now = new Date(),
): Promise<DiscoveryDashboardRun | null> {
  if (!parseBriefDate(selectedDate)) throw new Error('Invalid Dashboard date.');
  const result = await db.query<{
    id: string;
    run_type: string;
    status: string;
    end_reason: string | null;
    error_summary: string | null;
    started_at: Date | string | null;
    finished_at: Date | string | null;
    window_start_date: string | null;
    window_end_date: string | null;
    input_content_ids: DiscoveryRunRecord['inputContentIds'];
    selection_output: Record<string, unknown> | null;
    config_snapshot: Record<string, unknown> | null;
    execution_state: DiscoveryDashboardRun['stages'] | null;
    run_count: number | string;
    candidate_count: number | string;
    review_count: number | string;
  }>(
    `with date_runs as (
       select *, count(*) over () as run_count from discovery_runs
       where window_end_date = $1::date and run_type = 'regular'
     )
     select r.id, r.run_type, r.status, r.end_reason, r.error_summary, r.started_at, r.finished_at,
            r.execution_state, r.run_count, r.window_start_date::text, r.window_end_date::text,
            r.input_content_ids, r.selection_output, r.config_snapshot,
            (select count(*) from discovery_candidates dc where dc.run_id = r.id) as candidate_count,
            (select count(*) from in_depth_candidates ic
               join discovery_candidates dc on dc.id = ic.discovery_candidate_id
              where dc.run_id = r.id) as review_count
       from date_runs r order by r.started_at desc nulls last, r.id desc limit 1`,
    [selectedDate],
  );
  const row = result.rows[0];
  if (!row) return null;
  const startedAt = row.started_at ? new Date(row.started_at).toISOString() : null;
  const finishedAt = row.finished_at ? new Date(row.finished_at).toISOString() : null;
  const end = finishedAt ? Date.parse(finishedAt) : row.status === 'running' ? now.getTime() : null;
  return {
    id: row.id,
    runType: row.run_type,
    status: row.status,
    endReason: row.end_reason,
    errorSummary: row.error_summary,
    startedAt,
    finishedAt,
    durationMs:
      end === null || startedAt === null ? null : Math.max(0, end - Date.parse(startedAt)),
    runCount: Number(row.run_count),
    candidateCount: Number(row.candidate_count),
    d2RetryAvailable: canRetryDiscoveryD2(
      {
        runType: row.run_type as 'regular',
        status: row.status as DiscoveryRunRecord['status'],
        windowStartDate: row.window_start_date,
        windowEndDate: row.window_end_date,
        inputContentIds: row.input_content_ids,
        selectionOutput: row.selection_output,
        configSnapshot: row.config_snapshot,
        executionState: (row.execution_state as DiscoveryExecutionState) ?? {},
      },
      Number(row.candidate_count) > 0,
    ),
    reviewCount: Number(row.review_count),
    topicQuestions: readD3TopicQuestions(row.selection_output, row.execution_state?.d3),
    stages: row.execution_state ?? {},
  };
}

function readD3TopicQuestions(
  selection: Record<string, unknown> | null,
  d3: Partial<DiscoveryBranchExecutionState> | undefined,
): string[] {
  if (!d3?.status || !Array.isArray(selection?.leads)) return [];
  return selection.leads.flatMap((lead: unknown) => {
    if (!lead || typeof lead !== 'object') return [];
    const { kind, question } = lead as Record<string, unknown>;
    return kind === 'topic' && typeof question === 'string' && question.trim()
      ? [question.trim()]
      : [];
  });
}

export function discoveryStageTokenMetrics(value: unknown) {
  const usage = normalizeDiscoveryStageUsage(value);
  return {
    totalTokens:
      usage.inputTokens === null || usage.outputTokens === null
        ? null
        : usage.inputTokens + usage.outputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheHitRate: discoveryCacheHitRate(usage),
  };
}
