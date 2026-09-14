import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertStageLlmConfiguration, resolveStageLlmModel, resolveStageLlmProvider } from "../src/processing/llm-client.js";
import { processStage4 } from "../src/processing/stage4-job.js";
import { resolveDailyScope } from "../src/lib/daily-scope.js";
import { pipelineTriggerSource, safelyFinishPipelineRun, safelyStartPipelineRun } from "../src/processing/pipeline-run-log.js";
import { STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION } from "../src/prompts/stage4-event-enrichment.js";

const inheritedStage3RunDir = process.env.STAGE4_STAGE3_RUN_DIR;
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Stage 4 processing.");
  }
  assertStageLlmConfiguration("stage4");

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
    const pipelineRunId = await safelyStartPipelineRun(pool, { dailyDate, step: "stage4", triggerSource: pipelineTriggerSource(process.env.PIPELINE_TRIGGER_SOURCE), startedAt });
    try {
    const result = await processStage4(pool, {
      stage3RunDir: inheritedStage3RunDir ?? process.env.STAGE4_STAGE3_RUN_DIR,
      dailyDate: process.env.DAILY_DATE,
      concurrency: parseOptionalPositiveInt(process.env.STAGE4_CONCURRENCY),
    });
    await writeRunPointer(result.runDir);
    const status = result.success ? "success" : result.enrichmentSuccessCount > 0 ? "partial" : "failed";
    await safelyFinishPipelineRun(pool, pipelineRunId, {
      status, provider: resolveStageLlmProvider("stage4"), model: resolveStageLlmModel("stage4"),
      metrics: { selected_count: result.selectedEventCount, ready_count: result.enrichmentSuccessCount,
        failed_count: result.enrichmentFailureCount ?? (status === "partial" ? 1 : result.success ? 0 : result.selectedEventCount),
        draft_count: status === "partial" ? result.enrichmentSuccessCount : 0,
        published_count: result.success ? result.eventsCreated : 0, llm_calls: result.llmCalls,
        prompt_version: STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
        retry_count: result.retryCount, duration_ms: Date.now() - startedAt.getTime(),
        llm_duration_ms: result.llmDurationMs,
        input_tokens: result.tokenUsage?.inputTokens ?? null,
        output_tokens: result.tokenUsage?.outputTokens ?? null,
        total_tokens: result.tokenUsage?.totalTokens ?? null,
        web_search_event_count: result.webSearchEventCount,
        total_web_search_calls: result.totalWebSearchCalls }, errorSummary: result.error,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
    } catch (error) {
      await safelyFinishPipelineRun(pool, pipelineRunId, { status: "failed", provider: resolveStageLlmProvider("stage4"), model: resolveStageLlmModel("stage4"), errorSummary: error instanceof Error ? error.message : String(error) });
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
