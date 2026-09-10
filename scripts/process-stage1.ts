import { config } from "dotenv";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { assertStageLlmConfiguration } from "../src/processing/llm-client.js";
import { processStage1Batch } from "../src/processing/stage1-job.js";
import { buildStage1BatchInput } from "../src/processing/stage1-contract.js";
import { readPublishedAtScopeFromEnv } from "../src/lib/daily-scope.js";

const inheritedDailyScope = readPublishedAtScopeFromEnv(process.env);

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
    const runDir = join(process.cwd(), "runtime/stage1", toRunTimestamp(new Date()));
    const attemptsPath = join(runDir, "attempts.jsonl");
    await mkdir(join(runDir, "batches"), { recursive: true });
    const summary = await processStage1Batch(pool, {
      limit: optionalPositiveInteger(process.env.STAGE1_LIMIT),
      concurrency: optionalPositiveInteger(process.env.STAGE1_CONCURRENCY),
      publishedWithinHours: optionalPositiveInteger(
        process.env.STAGE1_PUBLISHED_WITHIN_HOURS ??
          process.env.STAGE1_COLLECTED_WITHIN_HOURS,
      ),
      publishedAtScope: inheritedDailyScope ?? readPublishedAtScopeFromEnv(process.env),
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
    console.log(JSON.stringify({ ...summary, runtimeDir: runDir }, null, 2));
  } finally {
    await pool.end();
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
