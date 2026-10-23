import { withFilePrompts, runPath } from '../src/lib/prompts/run-file.js';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

loadPipelineEnvironment();

// Stage 2 reads retry/timeout defaults during module initialization. Load dotenv
// before dynamically importing processing modules so .env.local takes effect.
const [
  llmClient,
  stage2Job,
  runtimeArtifacts,
  stage1Runtime,
  dailyAttribution,
  dailyScope,
  eventGroupPersistence,
  pipelineRunLog,
] = await Promise.all([
  import('../src/processing/llm-client.js'),
  import('../src/processing/stage2-job.js'),
  import('../src/processing/stage2-runtime-artifacts.js'),
  import('../src/processing/stage1-runtime.js'),
  import('../src/processing/daily-attribution.js'),
  import('../src/lib/daily-scope.js'),
  import('../src/processing/event-group-persistence.js'),
  import('../src/processing/pipeline-run-log.js'),
]);

const inheritedStage1RunDir = process.env.STAGE2_STAGE1_RUN_DIR;
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to process Stage 2.');
  }

  llmClient.assertStageLlmConfiguration('stage2');

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
    const scope = dailyScope.resolveDailyScope(process.env.DAILY_DATE);
    const pipelineRunId = await pipelineRunLog.safelyStartPipelineRun(pool, {
      dailyDate: scope.dailyDate,
      step: 'stage2',
      triggerSource: pipelineRunLog.pipelineTriggerSource(process.env.PIPELINE_TRIGGER_SOURCE),
      startedAt,
    });
    try {
      const stage1 = await stage1Runtime.loadOptionalStage1Runtime(
        process.cwd(),
        inheritedStage1RunDir ?? process.env.STAGE2_STAGE1_RUN_DIR,
        scope.dailyDate,
      );
      await dailyAttribution.backfillDailyAttribution(pool, scope);
      const result = await withFilePrompts(pool, runPath('stage2', startedAt), () =>
        stage2Job.processStage2Merge(pool, {
          dailyDate: scope.dailyDate,
          stage1StartedAt: stage1?.run.started_at,
          stage1FinishedAt: stage1?.run.finished_at,
        }),
      );
      const summary = stage2Job.summarizeStage2Result(result);
      const artifacts = await runtimeArtifacts.writeStage2RuntimeArtifacts(result, {
        startedAt,
        stage1RunDir: stage1?.runDir ?? null,
        stage1StartedAt: stage1?.run.started_at ?? null,
        stage1FinishedAt: stage1?.run.finished_at ?? null,
        dailyDate: scope.dailyDate,
      });
      await writeRunPointer(artifacts.runDir);

      if (!result.success) {
        await pipelineRunLog.safelyFinishPipelineRun(pool, pipelineRunId, {
          status: 'failed',
          provider: llmClient.resolveStageLlmProvider('stage2'),
          model: result.model,
          metrics: {
            prompt_version: result.promptVersion,
            candidate_count: summary.eventCandidateCount,
            group_count: summary.eventGroupCount,
            llm_calls: summary.llmCallCount,
            retry_count: summary.retryCount,
            duration_ms: result.elapsedMs,
            llm_duration_ms: summary.llmDurationMs,
            input_tokens: result.tokenUsage?.inputTokens ?? null,
            output_tokens: result.tokenUsage?.outputTokens ?? null,
            total_tokens: result.tokenUsage?.totalTokens ?? null,
            cached_input_tokens: result.tokenUsage?.cachedInputTokens ?? null,
            token_usage_complete: result.tokenUsage?.usageComplete ?? null,
            ...stage2Job.stage2WarningMetrics(summary),
          },
          errorSummary: result.error,
        });
        console.log(JSON.stringify({ ...summary, runtimePath: artifacts.runDir }, null, 2));
        process.exitCode = 1;
        return;
      }

      const eventGroupIds = await eventGroupPersistence.replaceEventGroups(
        pool,
        scope.dailyDate,
        result.eventGroups,
      );

      await pipelineRunLog.safelyFinishPipelineRun(pool, pipelineRunId, {
        status: 'success',
        provider: llmClient.resolveStageLlmProvider('stage2'),
        model: result.model,
        metrics: {
          prompt_version: result.promptVersion,
          candidate_count: summary.eventCandidateCount,
          group_count: summary.eventGroupCount,
          llm_calls: summary.llmCallCount,
          retry_count: summary.retryCount,
          duration_ms: result.elapsedMs,
          llm_duration_ms: summary.llmDurationMs,
          input_tokens: result.tokenUsage?.inputTokens ?? null,
          output_tokens: result.tokenUsage?.outputTokens ?? null,
          total_tokens: result.tokenUsage?.totalTokens ?? null,
          cached_input_tokens: result.tokenUsage?.cachedInputTokens ?? null,
          token_usage_complete: result.tokenUsage?.usageComplete ?? null,
          ...stage2Job.stage2WarningMetrics(summary),
        },
        errorSummary: null,
      });

      console.log(
        JSON.stringify({ ...summary, eventGroupIds, runtimePath: artifacts.runDir }, null, 2),
      );
    } catch (error) {
      await pipelineRunLog.safelyFinishPipelineRun(pool, pipelineRunId, {
        status: 'failed',
        provider: llmClient.resolveStageLlmProvider('stage2'),
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
