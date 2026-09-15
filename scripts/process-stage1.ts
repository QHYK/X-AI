import { config } from "dotenv";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { assertStageLlmConfiguration, resolveStageLlmModel } from "../src/processing/llm-client.js";
import { processStage1Batch } from "../src/processing/stage1-job.js";
import { buildStage1BatchInput } from "../src/processing/stage1-contract.js";
import { STAGE1_PROMPT_VERSION } from "../src/prompts/stage1-content-understanding.js";
import { pipelineTriggerSource, safelyFinishPipelineRun, safelyStartPipelineRun } from "../src/processing/pipeline-run-log.js";
import { resolveStageLlmProvider } from "../src/processing/llm-client.js";
import {
  readCatchupPublishedAtScopeFromEnv,
  readPublishedAtScopeFromEnv,
  resolveDailyScope,
} from "../src/lib/daily-scope.js";

const inheritedDailyScope = readPublishedAtScopeFromEnv(process.env);
const inheritedCatchupScope = readCatchupPublishedAtScopeFromEnv(process.env);
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to process Stage 1.");
  }

  assertStageLlmConfiguration("stage1");

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  try {
    const startedAt = new Date();
    const dailyDate = resolveDailyScope(process.env.DAILY_DATE, startedAt).dailyDate;
    const pipelineRunId = await safelyStartPipelineRun(pool, { dailyDate, step: "stage1", triggerSource: pipelineTriggerSource(process.env.PIPELINE_TRIGGER_SOURCE), startedAt });
    const runDir = join(process.cwd(), "runtime/stage1", toRunTimestamp(startedAt));
    const attemptsPath = join(runDir, "attempts.jsonl");
    const publishedAtScope =
      inheritedCatchupScope ??
      readCatchupPublishedAtScopeFromEnv(process.env) ??
      inheritedDailyScope ??
      readPublishedAtScopeFromEnv(process.env);
    await mkdir(join(runDir, "batches"), { recursive: true });
    try {
      const summary = await processStage1Batch(pool, {
        limit: optionalPositiveInteger(process.env.STAGE1_LIMIT),
        concurrency: optionalPositiveInteger(process.env.STAGE1_CONCURRENCY),
        publishedWithinHours: optionalPositiveInteger(
          process.env.STAGE1_PUBLISHED_WITHIN_HOURS ??
            process.env.STAGE1_COLLECTED_WITHIN_HOURS,
        ),
        publishedAtScope,
        dailyDate,
        batchSize: optionalPositiveInteger(process.env.STAGE1_BATCH_SIZE),
        batchMaxContentChars: optionalPositiveInteger(
          process.env.STAGE1_BATCH_MAX_CONTENT_CHARS,
        ),
        batchMaxTotalChars: optionalPositiveInteger(
          process.env.STAGE1_BATCH_MAX_TOTAL_CHARS,
        ),
        onInitialBatches: async (batches) => {
          await Promise.all(batches.map((batch, index) => writeFile(
            join(runDir, "batches", `batch-${String(index + 1).padStart(3, "0")}.input.json`),
            `${JSON.stringify(buildStage1BatchInput(batch), null, 2)}\n`,
          )));
        },
        onAttemptRecord: async (record) => {
          await appendFile(attemptsPath, `${JSON.stringify(record)}\n`);
        },
      });
      const artifact = {
        ...summary,
        initialBatchCount: summary.batchCount,
        llmRequestCount: summary.llmCallCount,
        successArticleCount: summary.selectedCount,
        durationMs: Date.parse(summary.finishedAt) - Date.parse(summary.startedAt),
      };
      await writeFile(join(runDir, "summary.json"), `${JSON.stringify(artifact, null, 2)}\n`);
      await writeFile(
        join(runDir, "run.json"),
        `${JSON.stringify({
          stage: "stage1",
          status: "success",
          daily_date: dailyDate,
          started_at: summary.startedAt,
          finished_at: summary.finishedAt,
          scope_start_at: summary.scopeStartAt,
          scope_end_at: summary.scopeEndAt,
          model: summary.model,
          prompt_version: STAGE1_PROMPT_VERSION,
          duration_ms: artifact.durationMs,
          candidate_count: summary.loadedCount,
          selected_count: summary.selectedCount,
          ignored_count: summary.ignoredCount,
          failed_count: summary.failedCount,
          batch_count: summary.batchCount,
          fallback_batch_count: summary.fallbackBatchCount,
          split_count: summary.splitCount,
          singleton_batch_count: summary.singletonBatchCount,
          llm_call_count: summary.llmCallCount,
          retry_count: summary.retryCount,
          llm_duration_ms: summary.llmDurationMs,
          input_tokens: summary.tokenUsage?.inputTokens ?? null,
          output_tokens: summary.tokenUsage?.outputTokens ?? null,
          total_tokens: summary.tokenUsage?.totalTokens ?? null,
        }, null, 2)}\n`,
      );
      await writeRunPointer(runDir);
      await safelyFinishPipelineRun(pool, pipelineRunId, {
        status: "success", provider: resolveStageLlmProvider("stage1"), model: summary.model,
        metrics: { llm_calls: summary.llmCallCount, retry_count: summary.retryCount, duration_ms: artifact.durationMs,
          llm_duration_ms: summary.llmDurationMs, input_tokens: summary.tokenUsage?.inputTokens ?? null,
          output_tokens: summary.tokenUsage?.outputTokens ?? null, total_tokens: summary.tokenUsage?.totalTokens ?? null,
          batch_count: summary.batchCount, fallback_batch_count: summary.fallbackBatchCount,
          split_count: summary.splitCount, singleton_batch_count: summary.singletonBatchCount },
      });
      console.log(JSON.stringify({ ...summary, runtimeDir: runDir }, null, 2));
    } catch (error) {
      await writeFile(
        join(runDir, "run.json"),
        `${JSON.stringify({
          stage: "stage1",
          status: "failed",
          daily_date: dailyDate,
          started_at: startedAt.toISOString(),
          finished_at: new Date().toISOString(),
          scope_start_at: publishedAtScope?.startAt ?? null,
          scope_end_at: publishedAtScope?.endAt ?? null,
          model: resolveStageLlmModel("stage1"),
          prompt_version: STAGE1_PROMPT_VERSION,
          duration_ms: Date.now() - startedAt.getTime(),
          candidate_count: null,
          selected_count: null,
          ignored_count: null,
          failed_count: null,
          batch_count: null,
          fallback_batch_count: null,
          split_count: null,
          singleton_batch_count: null,
          llm_call_count: null,
          retry_count: null,
          llm_duration_ms: null,
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          error: error instanceof Error ? error.message : String(error),
        }, null, 2)}\n`,
      );
      await safelyFinishPipelineRun(pool, pipelineRunId, { status: "failed", provider: resolveStageLlmProvider("stage1"), errorSummary: error instanceof Error ? error.message : String(error) });
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

function toRunTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`Expected a positive integer, got "${value}".`);
  }

  return numberValue;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
