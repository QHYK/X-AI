import { collectRssSources } from '../src/collectors/rss.js';
import { collectConfiguredGmail } from '../src/collectors/gmail/runtime.js';
import { runDailyCollection, type DailyCollectionResult } from '../src/lib/daily-collection.js';
import { databasePoolOptions } from '../src/db/pool-options.js';
import type { PipelineMetricValue } from '../src/processing/pipeline-run-log.js';
import { writeRunFile, initializeSystemFragmentFile } from '../src/lib/prompts/run-file.js';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { resolveDailyScope } from '../src/lib/daily-scope.js';
import { buildDailyStepEnv, type DailyStageName } from '../src/lib/daily-workflow.js';
import {
  safelyFinishPipelineRun,
  safelyStartPipelineRun,
} from '../src/processing/pipeline-run-log.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();

const STEPS = [
  'collect:rss',
  'dedupe:stage1',
  'complete:content',
  'process:stage1',
  'process:stage2',
  'process:stage3',
  'process:stage4',
] as const;

type StepName = (typeof STEPS)[number] & DailyStageName;
type StepStatus = 'running' | 'success' | 'partial' | 'failed';

type StepRun = {
  name: StepName;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: StepStatus;
  exit_code: number | null;
};

type DailyRun = {
  daily_date: string;
  timezone: 'Asia/Shanghai';
  scope_start_at: string;
  scope_end_at: string;
  content_completion_run: string | null;
  duplicate_filter_run: string | null;
  stage1_run: string | null;
  stage2_run: string | null;
  stage3_run: string | null;
  stage4_run: string | null;
  started_at: string;
  finished_at: string | null;
  status: StepStatus;
  duration_ms: number | null;
  steps: StepRun[];
  failed_step: StepName | null;
  collection: DailyCollectionResult | null;
  warning_count: number;
  warnings: DailyCollectionResult['warnings'];
};

async function main() {
  const startedAt = new Date();
  const requestedDailyDate = readDailyDateOption() ?? process.env.DAILY_DATE;
  const scope = resolveDailyScope(requestedDailyDate, startedAt);
  const isHistoricalRun = scope.dailyDate !== resolveDailyScope(undefined, startedAt).dailyDate;
  const runDir = join(process.cwd(), 'runtime/daily', toRunTimestamp(startedAt));
  const runPath = join(runDir, 'run.json');
  const logPool = process.env.DATABASE_URL
    ? new Pool({
        ...databasePoolOptions('cli'),
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      })
    : null;
  const pipelineRunId = logPool
    ? await safelyStartPipelineRun(logPool, {
        dailyDate: scope.dailyDate,
        step: 'daily',
        triggerSource: 'daily_orchestrator',
        startedAt,
      })
    : null;
  const run: DailyRun = {
    daily_date: scope.dailyDate,
    timezone: scope.timezone,
    scope_start_at: scope.startAt,
    scope_end_at: scope.endAt,
    content_completion_run: null,
    duplicate_filter_run: null,
    stage1_run: null,
    stage2_run: null,
    stage3_run: null,
    stage4_run: null,
    started_at: startedAt.toISOString(),
    finished_at: null,
    status: 'running',
    duration_ms: null,
    steps: [],
    failed_step: null,
    collection: null,
    warning_count: 0,
    warnings: [],
  };

  await mkdir(runDir, { recursive: true });
  await writeRun(runPath, run);
  if (logPool) await initializeSystemFragmentFile(runPath, logPool, undefined, true);
  console.log(`[daily] Runtime artifact: ${runPath}`);
  console.log(
    `[daily] Daily ${scope.dailyDate}: ${scope.startAt} <= published_at < ${scope.endAt} (${scope.timezone})`,
  );

  for (const name of STEPS) {
    const stepStartedAt = new Date();
    const step: StepRun = {
      name,
      started_at: stepStartedAt.toISOString(),
      finished_at: null,
      duration_ms: null,
      status: 'running',
      exit_code: null,
    };
    run.steps.push(step);
    await writeRun(runPath, run);

    console.log(`\n[daily] Starting ${name === 'collect:rss' ? 'Collection (RSS + Gmail)' : name}`);
    const pointerPath = getRunPointerPath(runDir, name);
    const stepEnv = buildDailyStepEnv({
      scope,
      step: name,
      lineage: {
        stage1Run: run.stage1_run,
        stage2Run: run.stage2_run,
        stage3Run: run.stage3_run,
      },
      runPointerPath: pointerPath ?? undefined,
      useCatchupWindow: !isHistoricalRun,
    });
    let exitCode: number;
    if (name === 'collect:rss') {
      const requirePool = () => {
        if (!logPool) throw new Error('DATABASE_URL is required');
        return logPool;
      };
      run.collection = await runDailyCollection({
        rss: () => collectRssSources(requirePool()),
        gmail: () => collectConfiguredGmail(requirePool(), { interactive: false }),
        onResult: (collector, result) =>
          console.log(`[daily] Collection ${collector}: ${JSON.stringify(result)}`),
      });
      run.warning_count = run.collection.warning_count;
      run.warnings = run.collection.warnings;
      if (run.warning_count)
        console.warn(
          `[daily] Warnings: ${run.warning_count} unsupported Gmail messages; review /ai/newsletter-parser.`,
        );
      for (const warning of run.warnings)
        console.warn(`[daily] Warning: Gmail ${warning.gmail_message_id}: ${warning.message}`);
      exitCode = run.collection.status === 'failed' ? 1 : 0;
    } else {
      exitCode = await runNpmScript(name, {
        ...process.env,
        ...stepEnv,
        DAILY_PROMPT_RUN_PATH: runPath,
        PIPELINE_TRIGGER_SOURCE: 'daily_orchestrator',
      });
    }
    if (pointerPath) {
      try {
        setStageRun(run, name, (await readFile(pointerPath, 'utf8')).trim());
      } catch (error) {
        if (exitCode === 0) {
          console.error(`[daily] ${name} did not report its runtime path.`, error);
          exitCode = 1;
        }
      }
    }
    const stepFinishedAt = new Date();
    step.finished_at = stepFinishedAt.toISOString();
    step.duration_ms = stepFinishedAt.getTime() - stepStartedAt.getTime();
    step.exit_code = exitCode;
    step.status =
      exitCode !== 0
        ? 'failed'
        : name === 'collect:rss' && run.collection?.status === 'partial'
          ? 'partial'
          : 'success';

    console.log(`[daily] ${name} ${step.status} (exit ${exitCode}, ${step.duration_ms} ms)`);

    if (exitCode !== 0) {
      finishRun(run, startedAt, stepFinishedAt, 'failed', name);
      await writeRun(runPath, run);
      if (logPool)
        await safelyFinishPipelineRun(logPool, pipelineRunId, {
          status: 'failed',
          metrics: {
            duration_ms: run.duration_ms,
            failed_step: name,
            collection: collectionMetric(run.collection),
            warning_count: run.warning_count,
            warnings: collectionMetric(run.warnings),
          },
          errorSummary:
            name === 'collect:rss' && run.collection
              ? `Collection failed: ${[run.collection.rss.overall_failure ? 'rss' : '', run.collection.gmail.overall_failure ? 'gmail' : ''].filter(Boolean).join(', ')}`
              : `${name} exited with ${exitCode}`,
        });
      await logPool?.end();
      process.exitCode = exitCode;
      return;
    }

    await writeRun(runPath, run);
  }

  const finishedAt = new Date();
  const status = run.collection?.status === 'partial' ? 'partial' : 'success';
  finishRun(run, startedAt, finishedAt, status, null);
  await writeRun(runPath, run);
  if (logPool)
    await safelyFinishPipelineRun(logPool, pipelineRunId, {
      status,
      metrics: {
        duration_ms: run.duration_ms,
        collection: collectionMetric(run.collection),
        warning_count: run.warning_count,
        warnings: collectionMetric(run.warnings),
      },
      errorSummary:
        status === 'partial'
          ? 'Collection partially failed; downstream steps completed.'
          : undefined,
    });
  await logPool?.end();
  if (status === 'partial') process.exitCode = 1;
  console.log(`\n[daily] Workflow ${status} (${run.duration_ms} ms)`);
}

function readDailyDateOption(): string | undefined {
  const option = process.argv.find((value) => value.startsWith('--date='));
  return option?.slice('--date='.length) || undefined;
}

function runNpmScript(name: StepName, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', name], {
      env,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      console.error(`[daily] Failed to start ${name}.`, error);
      resolve(1);
    });
    child.once('close', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      console.error(`[daily] ${name} terminated by signal ${signal ?? 'unknown'}.`);
      resolve(1);
    });
  });
}

function getRunPointerPath(runDir: string, name: StepName): string | null {
  switch (name) {
    case 'complete:content':
      return join(runDir, 'content-completion-run.txt');
    case 'dedupe:stage1':
      return join(runDir, 'duplicate-filter-run.txt');
    case 'process:stage1':
      return join(runDir, 'stage1-run.txt');
    case 'process:stage2':
      return join(runDir, 'stage2-run.txt');
    case 'process:stage3':
      return join(runDir, 'stage3-run.txt');
    case 'process:stage4':
      return join(runDir, 'stage4-run.txt');
    default:
      return null;
  }
}

function setStageRun(run: DailyRun, name: StepName, runDir: string): void {
  if (!runDir) {
    throw new Error(`${name} reported an empty runtime path.`);
  }

  switch (name) {
    case 'dedupe:stage1':
      run.duplicate_filter_run = runDir;
      break;
    case 'complete:content':
      run.content_completion_run = runDir;
      break;
    case 'process:stage1':
      run.stage1_run = runDir;
      break;
    case 'process:stage2':
      run.stage2_run = runDir;
      break;
    case 'process:stage3':
      run.stage3_run = runDir;
      break;
    case 'process:stage4':
      run.stage4_run = runDir;
      break;
  }
}

function finishRun(
  run: DailyRun,
  startedAt: Date,
  finishedAt: Date,
  status: 'success' | 'partial' | 'failed',
  failedStep: StepName | null,
) {
  run.finished_at = finishedAt.toISOString();
  run.status = status;
  run.duration_ms = finishedAt.getTime() - startedAt.getTime();
  run.failed_step = failedStep;
}

function collectionMetric(
  value: DailyCollectionResult | DailyCollectionResult['warnings'] | null,
): PipelineMetricValue {
  return JSON.parse(JSON.stringify(value)) as PipelineMetricValue;
}

function writeRun(path: string, run: DailyRun): Promise<void> {
  return writeRunFile(path, run as unknown as Record<string, unknown>);
}

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

main().catch((error) => {
  console.error('[daily] Workflow failed.', error);
  process.exitCode = 1;
});
