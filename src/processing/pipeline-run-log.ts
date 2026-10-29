import { relative, isAbsolute } from 'node:path';
import type { Pool } from 'pg';

export const PIPELINE_STEPS = [
  'daily',
  'content_completion',
  'exact_duplicate_filter',
  'stage1',
  'stage2',
  'stage3',
  'stage4',
] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];
export type PipelineRunStatus = 'running' | 'success' | 'partial' | 'failed';
export type PipelineTriggerSource = 'daily_orchestrator' | 'standalone' | 'dashboard';
export type PipelineMetricValue =
  boolean | number | string | null | PipelineMetricValue[] | { [key: string]: PipelineMetricValue };
export type PipelineMetrics = Record<string, PipelineMetricValue>;

export async function startPipelineRun(
  pool: Pool,
  input: {
    dailyDate: string;
    step: PipelineStep;
    triggerSource: PipelineTriggerSource;
    startedAt?: Date;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `insert into pipeline_runs (daily_date, step, status, trigger_source, started_at)
     values ($1::date, $2, 'running', $3, $4::timestamptz) returning id`,
    [
      input.dailyDate,
      input.step,
      input.triggerSource,
      (input.startedAt ?? new Date()).toISOString(),
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Pipeline run insert did not return an id.');
  return id;
}

export async function finishPipelineRun(
  pool: Pool,
  id: string,
  input: {
    status: Exclude<PipelineRunStatus, 'running'>;
    provider?: string | null;
    model?: string | null;
    metrics?: PipelineMetrics;
    mergeMetrics?: boolean;
    errorSummary?: string | null;
    finishedAt?: Date;
  },
): Promise<void> {
  await pool.query(
    `update pipeline_runs
     set status=$2, provider=$3, model=$4, finished_at=$5::timestamptz,
         metrics=${input.mergeMetrics ? 'metrics || $6::jsonb' : '$6::jsonb'} ||
           case when metrics ? 'runtime_dir' then jsonb_build_object('runtime_dir', metrics->'runtime_dir') else '{}'::jsonb end, error_summary=$7, updated_at=now()
     where id=$1::uuid`,
    [
      id,
      input.status,
      input.provider ?? null,
      input.model ?? null,
      (input.finishedAt ?? new Date()).toISOString(),
      JSON.stringify(input.metrics ?? {}),
      input.errorSummary ?? null,
    ],
  );
}

/** Logging is auxiliary: report its failure but never make a successful pipeline attempt fail. */
export async function safelyStartPipelineRun(
  pool: Pool,
  input: Parameters<typeof startPipelineRun>[1],
): Promise<string | null> {
  try {
    return await startPipelineRun(pool, input);
  } catch (error) {
    console.error('Failed to create durable pipeline run log.', error);
    return null;
  }
}

export async function safelyFinishPipelineRun(
  pool: Pool,
  id: string | null,
  input: Parameters<typeof finishPipelineRun>[2],
): Promise<void> {
  if (!id) return;
  try {
    await finishPipelineRun(pool, id, input);
  } catch (error) {
    console.error('Failed to finish durable pipeline run log.', error);
  }
}

export function pipelineTriggerSource(value: string | undefined): PipelineTriggerSource {
  return value === 'daily_orchestrator' || value === 'dashboard' ? value : 'standalone';
}

/** Observation only; never changes the result of a pipeline operation. */
export async function safelyRecordPipelineRuntime(
  pool: Pool,
  id: string | null,
  directory: string,
): Promise<void> {
  if (!id) return;
  try {
    const path = relative(process.cwd(), directory);
    if (
      isAbsolute(path) ||
      !/^runtime\/(stage[1-4]|content-completion|pre-stage1-duplicates)\/[^/]+$/.test(path)
    ) {
      throw new Error('Invalid pipeline Runtime directory.');
    }
    const result = await pool.query(
      `update pipeline_runs set metrics = jsonb_set(metrics, '{runtime_dir}', to_jsonb($2::text)), updated_at=now()
       where id=$1::uuid and (not metrics ? 'runtime_dir' or metrics->>'runtime_dir'=$2) returning id`,
      [id, path],
    );
    if (result.rows.length !== 1)
      throw new Error('Runtime observation missing or conflicting attempt.');
  } catch (error) {
    console.error('Failed to record pipeline Runtime directory.', error);
  }
}
