import type { Pool } from 'pg';
import { discoveryDatesForEndDate } from '../lib/discovery-window.js';
import {
  createOpenDiscoveryRun,
  createRegularDiscoveryRun,
  getDiscoveryRun,
} from './run-service.js';
import { runDiscoveryWorkflow, formatDiscoveryWorkflowReport } from './workflow-orchestrator.js';

export class DiscoveryJobConflict extends Error {}
const submissionServices = { createRegularDiscoveryRun, createOpenDiscoveryRun, getDiscoveryRun };
/** Durable submission; no paid work occurs in this request. */
export async function submitDiscoveryJob(
  pool: Pool,
  input: {
    date: string;
    mode: 'regular' | 'open';
    requestId: string;
  },
  services = submissionServices,
) {
  const dailyDates = discoveryDatesForEndDate(input.date);
  const gate = await pool.connect();
  try {
    await gate.query('begin');
    await gate.query('select pg_advisory_xact_lock(736210, 2)');
    const repeated = await gate.query<{ id: string }>(
      `select id from discovery_runs where config_snapshot->'dashboardJob'->>'requestId' = $1`,
      [input.requestId],
    );
    if (repeated.rows[0]) {
      const existing = await services.getDiscoveryRun(pool, repeated.rows[0].id);
      if (!existing || existing.windowEndDate !== input.date || existing.runType !== input.mode)
        throw new DiscoveryJobConflict('Request ID already belongs to another request.');
      await gate.query('commit');
      return existing;
    }
    const active = await gate.query(
      `select id from discovery_runs where window_end_date = $1::date and status in ('pending', 'running') limit 1`,
      [input.date],
    );
    if (active.rows.length)
      throw new DiscoveryJobConflict('该业务窗口已有排队或运行中的 Discovery。');
    const configSnapshot = { dashboardJob: { requestId: input.requestId } };
    let run;
    if (input.mode === 'open') {
      const parent = await gate.query<{ id: string }>(
        `select id from discovery_runs where run_type = 'regular' and window_end_date = $1::date
         order by started_at desc nulls last, id desc limit 1`,
        [input.date],
      );
      if (!parent.rows[0])
        throw new DiscoveryJobConflict('该日期没有可关联的 Regular Run，请先运行完整 Discovery。');
      run = await services.createOpenDiscoveryRun(pool, {
        parentRunId: parent.rows[0].id,
        triggerSource: 'manual',
        configSnapshot,
      });
    } else {
      run = (
        await services.createRegularDiscoveryRun(pool, {
          dailyDates,
          triggerSource: 'manual',
          configSnapshot,
        })
      ).run;
    }
    await gate.query('commit');
    return run;
  } catch (error) {
    await gate.query('rollback');
    throw error;
  } finally {
    gate.release();
  }
}

/** Session lock requires a direct/session-pooled PostgreSQL connection, never transaction pooling. */
export async function withDiscoveryExecutionLock<T>(
  pool: Pool,
  execute: () => Promise<T>,
): Promise<T | null> {
  const lock = await pool.connect();
  // Losing lock ownership while continuing paid work would allow concurrent executors.
  const lost = (error: Error) => {
    console.error('Discovery execution lock lost; terminating executor.', error);
    process.exit(1);
  };
  lock.on('error', lost);
  try {
    const result = await lock.query<{ locked: boolean }>(
      'select pg_try_advisory_lock(736210, 1) as locked',
    );
    if (!result.rows[0]?.locked) return null;
    try {
      return await execute();
    } finally {
      await lock.query('select pg_advisory_unlock(736210, 1)');
    }
  } finally {
    lock.off('error', lost);
    lock.release();
  }
}

/** Run one durable task. Interrupted work is explicitly failed, never silently retried/charged. */
export async function processNextDiscoveryJob(
  pool: Pool,
  execute = runDiscoveryWorkflow,
): Promise<boolean> {
  const result = await withDiscoveryExecutionLock(pool, async () => {
    await pool.query(`update discovery_runs set status = 'failed', end_reason = 'error',
      error_summary = 'Executor interrupted; preserved results. Explicit Resume or new Retry required.',
      finished_at = now(), updated_at = now()
      where status = 'running' and config_snapshot ? 'dashboardJob'`);
    const pending = await pool.query<{ id: string }>(`select id from discovery_runs
      where status = 'pending' and config_snapshot ? 'dashboardJob'
      order by created_at, id limit 1`);
    const id = pending.rows[0]?.id;
    if (!id) return false;
    try {
      const report = await execute(pool, { queuedRunId: id });
      console.log(JSON.stringify(formatDiscoveryWorkflowReport(report)));
    } catch (error) {
      console.error('Discovery background task failed.', { runId: id, error });
      await pool.query(
        `update discovery_runs set status = 'failed', end_reason = 'error',
        error_summary = $2, finished_at = now(), updated_at = now()
        where id = $1::uuid and status in ('pending', 'running')`,
        [id, error instanceof Error ? error.message : String(error)],
      );
    }
    return true;
  });
  return result ?? false;
}
