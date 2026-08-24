import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { readCollectedAtScopeFromEnv } from "../src/lib/daily-scope.js";
import { assertStageLlmConfiguration } from "../src/processing/llm-client.js";
import { processStage2Merge, summarizeStage2Result } from "../src/processing/stage2-job.js";
import { writeStage2RuntimeArtifacts } from "../src/processing/stage2-runtime-artifacts.js";

const inheritedDailyScope = readCollectedAtScopeFromEnv(process.env);
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to process Stage 2.");
  }

  assertStageLlmConfiguration("stage2");

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
    const result = await processStage2Merge(pool, {
      collectedWithinHours: optionalPositiveInteger(process.env.STAGE2_COLLECTED_WITHIN_HOURS),
      collectedAtScope: inheritedDailyScope ?? readCollectedAtScopeFromEnv(process.env),
    });
    const summary = summarizeStage2Result(result);
    const artifacts = await writeStage2RuntimeArtifacts(result, {
      startedAt,
    });
    await writeRunPointer(artifacts.runDir);

    console.log(JSON.stringify({ ...summary, runtimePath: artifacts.runDir }, null, 2));
    if (!result.success) {
      process.exitCode = 1;
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
