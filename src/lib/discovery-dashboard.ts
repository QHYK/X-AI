import { parseBriefDate } from './brief-date.js';
import type { Pool } from 'pg';
import type { DiscoveryBranchExecutionState, DiscoveryStage } from '../db/schema.js';

export type DiscoveryDashboardRun = {
  id: string;
  runType: string;
  status: string;
  endReason: string | null;
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
     select r.id, r.run_type, r.status, r.end_reason, r.started_at, r.finished_at,
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
