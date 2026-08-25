import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { readPublishedAtScopeFromEnv } from "../src/lib/daily-scope.js";
import { assertStageLlmConfiguration } from "../src/processing/llm-client.js";
import { processStage3 } from "../src/processing/stage3-job.js";

const inheritedDailyScope = readPublishedAtScopeFromEnv(process.env);
const inheritedStage2RunDir = process.env.STAGE3_STAGE2_RUN_DIR;
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Stage 3 processing.");
  }
  assertStageLlmConfiguration("stage3");

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
    const result = await processStage3(pool, {
      stage2RunDir: inheritedStage2RunDir ?? process.env.STAGE3_STAGE2_RUN_DIR,
      publishedWithinHours: parseOptionalPositiveInt(
        process.env.STAGE3_PUBLISHED_WITHIN_HOURS ??
          process.env.STAGE3_COLLECTED_WITHIN_HOURS,
      ),
      publishedAtScope: inheritedDailyScope ?? readPublishedAtScopeFromEnv(process.env),
      eventTopN: parseOptionalPositiveInt(process.env.STAGE3_EVENT_TOP_N),
    });
    await writeRunPointer(result.runDir);

    console.log(JSON.stringify(result, null, 2));
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
