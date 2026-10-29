import { join } from 'node:path';
import { readRunBindings } from '../src/lib/prompts/run-file.js';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { readPublishedAtScopeFromEnv } from '../src/lib/daily-scope.js';
import { assertStageLlmConfiguration } from '../src/processing/llm-client.js';
import { processStage3, stage3WarningMetrics } from '../src/processing/stage3-job.js';
import { resolveDailyScope } from '../src/lib/daily-scope.js';
import { resolveStageLlmModel, resolveStageLlmProvider } from '../src/processing/llm-client.js';
import {
  pipelineTriggerSource,
  safelyFinishPipelineRun,
  safelyStartPipelineRun,
} from '../src/processing/pipeline-run-log.js';
import { STAGE3_EVENT_RANKING_PROMPT_VERSION } from '../src/prompts/stage3-event-ranking.js';
import { STAGE3_DIGEST_RANKING_PROMPT_VERSION } from '../src/prompts/stage3-digest-ranking.js';
import { STAGE3_LONG_FORM_RANKING_PROMPT_VERSION } from '../src/prompts/stage3-long-form-ranking.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();
const inheritedDailyScope = readPublishedAtScopeFromEnv(process.env);
const inheritedDailyDate = process.env.DAILY_DATE;
const inheritedStage2RunDir = process.env.STAGE3_STAGE2_RUN_DIR;
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for Stage 3 processing.');
  }
  assertStageLlmConfiguration('stage3');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === 'true'
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  try {
    const startedAt = new Date();
    const dailyDate = resolveDailyScope(inheritedDailyDate, startedAt).dailyDate;
    const pipelineRunId = await safelyStartPipelineRun(pool, {
      dailyDate,
      step: 'stage3',
      triggerSource: pipelineTriggerSource(process.env.PIPELINE_TRIGGER_SOURCE),
      startedAt,
    });
    try {
      if (!pipelineRunId)
        throw new Error('Stage3 cannot run without its durable pipeline_runs record.');
      const result = await processStage3(pool, {
        pipelineRunId,
        stage2RunDir: inheritedStage2RunDir ?? process.env.STAGE3_STAGE2_RUN_DIR,
        publishedWithinHours: parseOptionalPositiveInt(
          process.env.STAGE3_PUBLISHED_WITHIN_HOURS ?? process.env.STAGE3_COLLECTED_WITHIN_HOURS,
        ),
        publishedAtScope: inheritedDailyScope ?? readPublishedAtScopeFromEnv(process.env),
        dailyDate: inheritedDailyDate,
      });
      const promptVersions = await readRunBindings(join(result.runDir, 'run.json'));
      await writeRunPointer(result.runDir);
      await safelyFinishPipelineRun(pool, pipelineRunId, {
        status: result.status,
        mergeMetrics: true,
        provider: resolveStageLlmProvider('stage3'),
        model: resolveStageLlmModel('stage3'),
        metrics: {
          prompt_versions: {
            event: promptVersions['daily.stage3.event_ranking'] ?? null,
            digest: promptVersions['daily.stage3.digest_ranking'] ?? null,
            long_form: promptVersions['daily.stage3.long_form_ranking'] ?? null,
          },
          legacy_prompt_versions: {
            event: STAGE3_EVENT_RANKING_PROMPT_VERSION,
            digest: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
            long_form: STAGE3_LONG_FORM_RANKING_PROMPT_VERSION,
          },
          event_group_count: result.eventGroupCount,
          selected_count: result.eventSelectedCount,
          digest_before_dedup: result.digestBeforeDedup,
          digest_after_dedup: result.digestAfterDedup,
          long_form_count: result.longFormCount,
          llm_calls: result.llmCallCount,
          retry_count: result.retryCount,
          llm_duration_ms: result.llmDurationMs,
          input_tokens: result.tokenUsage?.inputTokens ?? null,
          output_tokens: result.tokenUsage?.outputTokens ?? null,
          total_tokens: result.tokenUsage?.totalTokens ?? null,
          cached_input_tokens: result.tokenUsage?.cachedInputTokens ?? null,
          token_usage_complete: result.tokenUsage?.usageComplete ?? null,
          event_review_run_id: result.eventReviewRunId,
          input_snapshot_hashes: result.inputSnapshotHashes
            ? {
                event: result.inputSnapshotHashes.event,
                digest: result.inputSnapshotHashes.digest,
                long_form: result.inputSnapshotHashes.longForm,
              }
            : null,
          ranking_statuses: result.rankingStatuses,
          category_correction_count: result.categoryCorrections.length,
          digest_categories: JSON.parse(JSON.stringify(result.digestCategories)),
          category_corrections: JSON.parse(JSON.stringify(result.categoryCorrections)),
          ...stage3WarningMetrics(result),
        },
        errorSummary: result.error,
      });

      console.log(JSON.stringify(result, null, 2));
      // A partial Stage 3 attempt has persisted usable output (notably the Event
      // Review snapshot), so the Daily orchestrator may continue to Stage 4.
      if (result.status === 'failed') {
        process.exitCode = 1;
      }
    } catch (error) {
      await safelyFinishPipelineRun(pool, pipelineRunId, {
        status: 'failed',
        mergeMetrics: true,
        provider: resolveStageLlmProvider('stage3'),
        model: resolveStageLlmModel('stage3'),
        errorSummary: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } finally {
    await pool.end();
  }
}

async function writeRunPointer(runDir: string): Promise<void> {
  const path = inheritedRunPointer ?? process.env.DAILY_STAGE_RUN_POINTER;
  if (path) {
    await writeFile(path, `${runDir}\n`);
  }
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer env value, got ${value}.`);
  }

  return parsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
