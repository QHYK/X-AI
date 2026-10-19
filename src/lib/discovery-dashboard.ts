import { parseBriefDate } from './brief-date.js';
import type { Pool } from 'pg';
import type { DiscoveryBranchExecutionState, DiscoveryStage } from '../db/schema.js';
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
  reviewCount: number;
  stages: Partial<Record<DiscoveryStage, Partial<DiscoveryBranchExecutionState>>>;
};

/** Business date belongs to the input window; timestamps only order attempts and show timing. */
export async function getDiscoveryRunForDate(
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
    execution_state: DiscoveryDashboardRun['stages'] | null;
    run_count: number | string;
    candidate_count: number | string;
    review_count: number | string;
  }>(
    `with date_runs as (
       select *, count(*) over () as run_count from discovery_runs
       where window_end_date = $1::date
     )
     select r.id, r.run_type, r.status, r.end_reason, r.error_summary, r.started_at, r.finished_at,
            r.execution_state, r.run_count,
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
    reviewCount: Number(row.review_count),
    stages: row.execution_state ?? {},
  };
}
