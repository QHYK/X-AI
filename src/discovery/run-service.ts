import { captureSystemFragments } from '../lib/prompts/system-fragments.js';
// D2-5
// 管理 Discovery Run 的创建、状态更新、恢复及数据库操作
import type { Pool, PoolClient } from 'pg';
import type {
  DiscoveryBranchExecutionState,
  DiscoveryExecutionState,
  DiscoveryStage,
  DiscoveryInputContentIds,
} from '../db/schema.js';
import {
  readDiscoveryDailyWindow,
  validateDiscoveryDailyDates,
  type DiscoveryDailyDatePair,
  type DiscoveryWindowInput,
} from './daily-read-adapter.js';

export type DiscoveryRunStatus =
  'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'blocked';

export type DiscoveryRunEndReason =
  | 'candidates_found'
  | 'no_candidates'
  | 'timeout'
  | 'budget_exhausted'
  | 'upstream_not_ready'
  | 'error';

export type DiscoveryRunRecord = {
  id: string;
  parentRunId: string | null;
  sourceLeadId: string | null;
  runType: 'regular' | 'single_lead' | 'open';
  triggerSource: 'schedule' | 'manual';
  status: DiscoveryRunStatus;
  endReason: DiscoveryRunEndReason | null;
  windowStartDate: string | null;
  windowEndDate: string | null;
  inputContentIds: DiscoveryInputContentIds | null;
  selectionOutput: Record<string, unknown> | null;
  configSnapshot: Record<string, unknown> | null;
  executionState: DiscoveryExecutionState;
  startedAt: string | null;
  finishedAt: string | null;
  errorSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateRegularDiscoveryRunResult = {
  run: DiscoveryRunRecord;
  input: DiscoveryWindowInput | null;
  missingDailyDates: string[];
};

/** Creates an isolated, manually requested Open Discovery child Run. */
export async function createOpenDiscoveryRun(
  pool: Pick<Pool, 'query'>,
  input: {
    parentRunId: string;
    manualContext?: string;
    triggerSource: 'manual';
    configSnapshot?: Record<string, unknown>;
  },
): Promise<DiscoveryRunRecord> {
  const parent = await getDiscoveryRun(pool, input.parentRunId);
  if (!parent || parent.runType !== 'regular') {
    throw new Error('Manual Open Discovery requires an existing Regular parent Run.');
  }
  const context = input.manualContext?.trim() || null;
  const result = await pool.query<DiscoveryRunRow>(
    `insert into discovery_runs (
        parent_run_id, run_type, trigger_source, status, config_snapshot, window_start_date, window_end_date
      ) values (
        $1::uuid, 'open', $2, 'pending', $3::jsonb, $4::date, $5::date
      ) returning ${DISCOVERY_RUN_COLUMNS}`,
    [
      input.parentRunId,
      input.triggerSource,
      JSON.stringify({
        ...input.configSnapshot,
        systemFragmentVersions: await captureSystemFragments(pool),
        ...(context ? { manualOpen: { context } } : {}),
      }),
      parent.windowStartDate,
      parent.windowEndDate,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Open Discovery Run insert did not return a row.');
  return toDiscoveryRunRecord(row);
}

type CreateRegularDiscoveryRunDependencies = {
  readWindow: typeof readDiscoveryDailyWindow;
};

const defaultDependencies: CreateRegularDiscoveryRunDependencies = {
  readWindow: readDiscoveryDailyWindow,
};

/**
 * Creates either an executable pending Regular Run or a durable blocked Run.
 * Completion checks, Daily reads and the insert share a repeatable-read
 * transaction so the saved membership belongs to one database snapshot.
 */
export async function createRegularDiscoveryRun(
  pool: Pool,
  input: {
    dailyDates: DiscoveryDailyDatePair;
    triggerSource: 'schedule' | 'manual';
    configSnapshot?: Record<string, unknown> | null;
  },
  dependencies: CreateRegularDiscoveryRunDependencies = defaultDependencies,
): Promise<CreateRegularDiscoveryRunResult> {
  validateDiscoveryDailyDates(input.dailyDates);
  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read');
    const result = await createRegularDiscoveryRunInTransaction(client, input, dependencies);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Caller owns transaction isolation, commit/rollback and connection lifetime. */
export async function createRegularDiscoveryRunInTransaction(
  client: PoolClient,
  input: Parameters<typeof createRegularDiscoveryRun>[1],
  dependencies: CreateRegularDiscoveryRunDependencies = defaultDependencies,
): Promise<CreateRegularDiscoveryRunResult> {
  const dailyDates = validateDiscoveryDailyDates(input.dailyDates);
  const completedDates = await loadCompletedDailyDates(client, dailyDates);
  const missingDailyDates = dailyDates.filter((dailyDate) => !completedDates.has(dailyDate));

  if (missingDailyDates.length > 0) {
    const errorSummary = `Upstream Daily not completed: ${missingDailyDates.join(', ')}`;
    const run = await insertRegularRun(client, {
      dailyDates,
      triggerSource: input.triggerSource,
      status: 'blocked',
      endReason: 'upstream_not_ready',
      inputContentIds: null,
      configSnapshot: input.configSnapshot ?? null,
      finishedAt: new Date(),
      errorSummary,
    });
    return { run, input: null, missingDailyDates };
  }

  const windowInput = await dependencies.readWindow(client, dailyDates);
  const run = await insertRegularRun(client, {
    dailyDates,
    triggerSource: input.triggerSource,
    status: 'pending',
    endReason: null,
    inputContentIds: windowInput.contentIds,
    configSnapshot: {
      ...input.configSnapshot,
      systemFragmentVersions: await captureSystemFragments(client),
    },
    finishedAt: null,
    errorSummary: null,
  });
  return { run, input: windowInput, missingDailyDates: [] };
}

export async function startDiscoveryRun(
  pool: Pool,
  runId: string,
  startedAt: Date = new Date(),
): Promise<DiscoveryRunRecord> {
  const updated = await pool.query<DiscoveryRunRow>(
    `update discovery_runs
      set status = 'running', started_at = $2::timestamptz,
          finished_at = null, end_reason = null, error_summary = null, updated_at = now()
      where id = $1::uuid and status = 'pending'
      returning ${DISCOVERY_RUN_COLUMNS}`,
    [runId, startedAt.toISOString()],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new Error('Discovery Run must be pending before it can start.');
  }
  return toDiscoveryRunRecord(row);
}

/** Resumes unfinished Discovery branches without changing frozen D2 output. */
export async function resumeDiscoveryRun(pool: Pool, runId: string): Promise<DiscoveryRunRecord> {
  const updated = await pool.query<DiscoveryRunRow>(
    `update discovery_runs
      set status = 'running', finished_at = null, end_reason = null,
          error_summary = null, updated_at = now()
      where id = $1::uuid
        and run_type = 'regular'
        and status in ('partial', 'failed')
        and selection_output is not null
      returning ${DISCOVERY_RUN_COLUMNS}`,
    [runId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new Error(
      'Discovery resume requires a partial or failed regular Run with persisted D2 output.',
    );
  }
  return toDiscoveryRunRecord(row);
}

/**
 * Reopens an existing Run for an independently executed branch. Completed is
 * accepted for historical D2/D4-only Runs, but a missing branch state is never
 * interpreted as completed.
 */
export async function resumeDiscoveryBranchRun(
  pool: Pool,
  runId: string,
): Promise<DiscoveryRunRecord> {
  const updated = await pool.query<DiscoveryRunRow>(
    `update discovery_runs
      set status = 'running', finished_at = null, end_reason = null,
          error_summary = null, updated_at = now()
      where id = $1::uuid
        and run_type = 'regular'
        and status in ('partial', 'failed', 'completed')
        and selection_output is not null
      returning ${DISCOVERY_RUN_COLUMNS}`,
    [runId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new Error('Discovery branch execution requires a resumable regular Run with D2 output.');
  }
  return toDiscoveryRunRecord(row);
}

/** Resumes only an unfinished manual Open Discovery branch. */
export async function resumeOpenDiscoveryRun(
  pool: Pool,
  runId: string,
): Promise<DiscoveryRunRecord> {
  const updated = await pool.query<DiscoveryRunRow>(
    `update discovery_runs
      set status = 'running', finished_at = null, end_reason = null,
          error_summary = null, updated_at = now()
      where id = $1::uuid
        and run_type = 'open'
        and status in ('partial', 'failed')
      returning ${DISCOVERY_RUN_COLUMNS}`,
    [runId],
  );
  const row = updated.rows[0];
  if (!row) throw new Error('Open Discovery resume requires a partial or failed Open Run.');
  return toDiscoveryRunRecord(row);
}

export async function updateDiscoveryBranchExecutionState(
  queryable: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
  runId: string,
  branch: DiscoveryStage,
  state: DiscoveryBranchExecutionState,
): Promise<void> {
  const result = await queryable.query(
    `update discovery_runs
      set execution_state = jsonb_set(
            coalesce(execution_state, '{}'::jsonb),
            array[$2]::text[],
            $3::jsonb,
            true
          ),
          updated_at = now()
      where id = $1::uuid`,
    [runId, branch, JSON.stringify(state)],
  );
  if (result.rowCount !== 1) throw new Error(`Discovery Run not found: ${runId}`);
}

export async function finishDiscoveryRun(
  pool: Pool,
  runId: string,
  outcome:
    | { status: 'completed'; hasCandidates: boolean; finishedAt?: Date }
    | {
        status: 'partial' | 'failed';
        endReason: 'timeout' | 'budget_exhausted' | 'error';
        errorSummary: string;
        finishedAt?: Date;
      },
): Promise<DiscoveryRunRecord> {
  const endReason: DiscoveryRunEndReason =
    outcome.status === 'completed'
      ? outcome.hasCandidates
        ? 'candidates_found'
        : 'no_candidates'
      : outcome.endReason;
  const errorSummary = outcome.status === 'completed' ? null : outcome.errorSummary.trim();
  if (outcome.status !== 'completed' && !errorSummary) {
    throw new Error('Partial and failed Discovery Runs require an error summary.');
  }

  const result = await pool.query<DiscoveryRunRow>(
    `update discovery_runs
      set status = $2, end_reason = $3, error_summary = $4,
          finished_at = $5::timestamptz, updated_at = now()
      where id = $1::uuid and status = 'running'
      returning ${DISCOVERY_RUN_COLUMNS}`,
    [
      runId,
      outcome.status,
      endReason,
      errorSummary,
      (outcome.finishedAt ?? new Date()).toISOString(),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Discovery Run must be running before it can finish.');
  }
  return toDiscoveryRunRecord(row);
}

export async function getDiscoveryRun(
  pool: Pick<Pool, 'query'>,
  runId: string,
): Promise<DiscoveryRunRecord | null> {
  const result = await pool.query<DiscoveryRunRow>(
    `${DISCOVERY_RUN_SELECT} from discovery_runs where id = $1::uuid`,
    [runId],
  );
  return result.rows[0] ? toDiscoveryRunRecord(result.rows[0]) : null;
}

async function loadCompletedDailyDates(
  client: PoolClient,
  dailyDates: DiscoveryDailyDatePair,
): Promise<Set<string>> {
  const result = await client.query<{ daily_date: string }>(
    `select distinct daily_date::text as daily_date
      from pipeline_runs
      where daily_date = any($1::date[])
        and step in ('daily', 'stage4')
        and status = 'success'`,
    [dailyDates],
  );
  return new Set(result.rows.map((row) => row.daily_date));
}

async function insertRegularRun(
  client: PoolClient,
  input: {
    dailyDates: DiscoveryDailyDatePair;
    triggerSource: 'schedule' | 'manual';
    status: 'pending' | 'blocked';
    endReason: 'upstream_not_ready' | null;
    inputContentIds: DiscoveryInputContentIds | null;
    configSnapshot: Record<string, unknown> | null;
    finishedAt: Date | null;
    errorSummary: string | null;
  },
): Promise<DiscoveryRunRecord> {
  const result = await client.query<DiscoveryRunRow>(
    `insert into discovery_runs (
        run_type, trigger_source, status, end_reason,
        window_start_date, window_end_date, input_content_ids,
        config_snapshot, finished_at, error_summary
      ) values (
        'regular', $1, $2, $3, $4::date, $5::date, $6::jsonb,
        $7::jsonb, $8::timestamptz, $9
      ) returning ${DISCOVERY_RUN_COLUMNS}`,
    [
      input.triggerSource,
      input.status,
      input.endReason,
      input.dailyDates[0],
      input.dailyDates[1],
      input.inputContentIds === null ? null : JSON.stringify(input.inputContentIds),
      input.configSnapshot === null ? null : JSON.stringify(input.configSnapshot),
      input.finishedAt?.toISOString() ?? null,
      input.errorSummary,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('Discovery Run insert did not return a row.');
  }
  return toDiscoveryRunRecord(row);
}

const DISCOVERY_RUN_COLUMNS = `
  id,
  parent_run_id,
  source_lead_id,
  run_type,
  trigger_source,
  status,
  end_reason,
  window_start_date::text as window_start_date,
  window_end_date::text as window_end_date,
  input_content_ids,
  selection_output,
  config_snapshot,
  execution_state,
  started_at,
  finished_at,
  error_summary,
  created_at,
  updated_at`;

const DISCOVERY_RUN_SELECT = `select ${DISCOVERY_RUN_COLUMNS}`;

type DiscoveryRunRow = {
  id: string;
  parent_run_id: string | null;
  source_lead_id: string | null;
  run_type: DiscoveryRunRecord['runType'];
  trigger_source: DiscoveryRunRecord['triggerSource'];
  status: DiscoveryRunStatus;
  end_reason: DiscoveryRunEndReason | null;
  window_start_date: string | null;
  window_end_date: string | null;
  input_content_ids: DiscoveryInputContentIds | null;
  selection_output: Record<string, unknown> | null;
  config_snapshot: Record<string, unknown> | null;
  execution_state: DiscoveryExecutionState | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error_summary: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function toDiscoveryRunRecord(row: DiscoveryRunRow): DiscoveryRunRecord {
  return {
    id: row.id,
    parentRunId: row.parent_run_id,
    sourceLeadId: row.source_lead_id,
    runType: row.run_type,
    triggerSource: row.trigger_source,
    status: row.status,
    endReason: row.end_reason,
    windowStartDate: row.window_start_date,
    windowEndDate: row.window_end_date,
    inputContentIds: row.input_content_ids,
    selectionOutput: row.selection_output,
    configSnapshot: row.config_snapshot,
    executionState: row.execution_state ?? {},
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    errorSummary: row.error_summary,
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
