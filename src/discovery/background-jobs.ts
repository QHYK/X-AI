import { canRetryDiscoveryD2 } from '../lib/discovery-d2-retry.js';
import type { Pool } from 'pg';
import { discoveryDatesForEndDate } from '../lib/discovery-window.js';
import {
  createOpenDiscoveryRun,
  createRegularDiscoveryRunInTransaction,
  getDiscoveryRun,
  finishDiscoveryRun,
} from './run-service.js';
import { runDiscoveryWorkflow, formatDiscoveryWorkflowReport } from './workflow-orchestrator.js';

export class DiscoveryJobConflict extends Error {}
const submissionServices = {
  createRegularDiscoveryRun: createRegularDiscoveryRunInTransaction,
  createOpenDiscoveryRun,
  getDiscoveryRun,
};
/** Durable submission; no paid work occurs in this request. */
export async function submitDiscoveryJob(
  pool: Pool,
  input: {
    date: string;
    mode: 'regular' | 'open';
    requestId: string;
    triggerSource?: 'schedule' | 'manual';
  },
  services = submissionServices,
) {
  const dailyDates = discoveryDatesForEndDate(input.date);
  const triggerSource = input.triggerSource ?? 'manual';
  if (triggerSource === 'schedule' && input.mode !== 'regular') {
    throw new Error('Scheduled Discovery only submits Regular Runs.');
  }
  const gate = await pool.connect();
  let releaseError: Error | undefined;
  try {
    // READ COMMITTED sees the preceding submitter's commit after waiting for the gate.
    await gate.query('begin');
    await gate.query("set local lock_timeout = '5s'");
    await gate.query('select pg_advisory_xact_lock(736210, 2)');
    const repeated = await gate.query<{ id: string }>(
      `select id from discovery_runs where config_snapshot->'dashboardJob'->>'requestId' = $1`,
      [input.requestId],
    );
    if (repeated.rows[0]) {
      const existing = await services.getDiscoveryRun(gate, repeated.rows[0].id);
      if (
        !existing ||
        existing.windowEndDate !== input.date ||
        existing.runType !== input.mode ||
        existing.triggerSource !== triggerSource
      )
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
      run = await services.createOpenDiscoveryRun(gate, {
        parentRunId: parent.rows[0].id,
        triggerSource: 'manual',
        configSnapshot,
      });
    } else {
      run = (
        await services.createRegularDiscoveryRun(gate, {
          dailyDates,
          triggerSource,
          configSnapshot,
        })
      ).run;
    }
    await gate.query('commit');
    return run;
  } catch (error) {
    try {
      await gate.query('rollback');
    } catch (rollbackError) {
      releaseError = new AggregateError(
        [error, rollbackError],
        'Discovery submission rollback failed.',
      );
      throw releaseError;
    }
    if ((error as { code?: string })?.code === '55P03') {
      throw new Error('Discovery submission lock wait timed out; retry the request.', {
        cause: error,
      });
    }
    throw error;
  } finally {
    // A failed rollback must not put a possibly open transaction back into the Pool.
    gate.release(releaseError);
  }
}

/** Enqueue the same failed D2 Run; preserve its original submission ID, inputs and Prompt bindings. */
export async function submitDiscoveryD2Retry(
  pool: Pool,
  input: { runId: string; requestId: string },
) {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '5s'");
    await client.query('select pg_advisory_xact_lock(736210, 2)');
    await client.query('select id from discovery_runs where id = $1::uuid for update', [
      input.runId,
    ]);
    const run = await getDiscoveryRun(client, input.runId);
    if (!run) throw new DiscoveryJobConflict('Discovery Run not found.');
    const job = run.configSnapshot?.dashboardJob as { d2RetryRequestIds?: string[] } | undefined;
    if (Array.isArray(job?.d2RetryRequestIds) && job.d2RetryRequestIds.includes(input.requestId)) {
      await client.query('commit');
      return run;
    }
    const candidates = await client.query(
      'select id from discovery_candidates where run_id = $1::uuid limit 1',
      [run.id],
    );
    if (!canRetryDiscoveryD2(run, candidates.rows.length > 0)) {
      throw new DiscoveryJobConflict(
        'Retry D2 requires a failed D2 with saved inputs/Prompt version and no downstream results. Use Retry Discovery for an unsupported historical Run.',
      );
    }
    const active = await client.query(
      `select id from discovery_runs where window_end_date = $1::date and status in ('pending', 'running') limit 1`,
      [run.windowEndDate],
    );
    if (active.rows.length)
      throw new DiscoveryJobConflict('该业务窗口已有排队或运行中的 Discovery。');
    const updated = await client.query(
      `update discovery_runs set status = 'pending', end_reason = null,
      error_summary = null, finished_at = null, updated_at = now(),
      config_snapshot = jsonb_set(coalesce(config_snapshot, '{}'::jsonb), '{dashboardJob}',
        coalesce(config_snapshot->'dashboardJob', '{}'::jsonb) || jsonb_build_object('d2RetryRequestIds',
          coalesce(config_snapshot#>'{dashboardJob,d2RetryRequestIds}', '[]'::jsonb) || jsonb_build_array($2::text)), true)
      where id = $1::uuid and status = 'failed' returning id`,
      [run.id, input.requestId],
    );
    if (updated.rowCount !== 1)
      throw new DiscoveryJobConflict('Discovery Run state changed; refresh before retrying.');
    const pending = await getDiscoveryRun(client, run.id);
    if (!pending) throw new Error('Queued D2 Retry Run could not be read.');
    await client.query('commit');
    return pending;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      releaseError = new AggregateError(
        [error, rollbackError],
        'D2 retry submission rollback failed.',
      );
      throw releaseError;
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/** Session lock requires a direct/session-pooled PostgreSQL connection, never transaction pooling. */
export async function withDiscoveryExecutionLock<T>(
  pool: Pool,
  execute: () => Promise<T>,
  options: { recoverRunId?: string } = {},
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
      if (options.recoverRunId) await recoverInterruptedRun(pool, options.recoverRunId);
      return await execute();
    } finally {
      await lock.query('select pg_advisory_unlock(736210, 1)');
    }
  } finally {
    lock.off('error', lost);
    lock.release();
  }
}

/** Called only after this module has acquired the global executor lock. Never infer death by age. */
async function recoverInterruptedRun(pool: Pool, runId: string): Promise<void> {
  const run = await getDiscoveryRun(pool, runId);
  if (!run || run.status !== 'running')
    throw new Error(
      'Interrupted recovery requires a running Run. For failed/partial Runs, use --run-id without --recover-interrupted.',
    );
  if (!['regular', 'open'].includes(run.runType))
    throw new Error('Unsupported interrupted Run type; inspect this Run manually.');
  if (
    run.runType === 'regular' &&
    (!run.selectionOutput || !Array.isArray(run.selectionOutput.leads))
  ) {
    throw new Error(
      'Cannot recover without persisted D2 selection_output. Inspect the Run; retry D2 with an explicitly requested new Regular Run.',
    );
  }
  if (run.runType === 'regular') {
    const leads = run.selectionOutput!.leads as unknown[];
    const ids = new Set<string>();
    const invalid =
      leads.length > 8 ||
      leads.some((value) => {
        if (!value || typeof value !== 'object') return true;
        const lead = value as Record<string, unknown>;
        if (typeof lead.leadId !== 'string' || !lead.leadId || ids.has(lead.leadId)) return true;
        ids.add(lead.leadId);
        if (lead.kind === 'direct')
          return typeof lead.sourceContentId !== 'string' || !lead.sourceContentId;
        return (
          lead.kind !== 'topic' ||
          typeof lead.question !== 'string' ||
          !lead.question ||
          !Array.isArray(lead.sourceContentIds) ||
          lead.sourceContentIds.some((id) => typeof id !== 'string' || !id)
        );
      });
    if (invalid)
      throw new Error(
        'Cannot recover malformed persisted D2 leads; inspect this Run before making paid requests.',
      );
  }
  if (!run.windowStartDate || !run.windowEndDate || (run.runType === 'open' && !run.parentRunId)) {
    throw new Error(
      'Interrupted Run is missing its execution context; inspect stored Run data before recovery.',
    );
  }
  for (const stage of ['d3', 'd4', 'd5'] as const) {
    const state = run.executionState[stage];
    if (
      (state && !['running', 'completed', 'failed'].includes(state.status)) ||
      (!state && run.configSnapshot && Object.hasOwn(run.configSnapshot, stage))
    ) {
      throw new Error(
        `Interrupted Run has ambiguous ${stage} state; inspect persisted results before recovery.`,
      );
    }
  }
  await finishDiscoveryRun(pool, runId, {
    status: 'failed',
    endReason: 'error',
    errorSummary:
      'Executor interrupted; recovered under global execution lock for explicit CLI Resume. Completed steps preserved.',
  });
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
