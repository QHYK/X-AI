import { config } from "dotenv";
import { Pool } from "pg";
import { processStage3 } from "../src/processing/stage3-job.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Stage 3 processing.");
  }

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
      stage2RunDir: process.env.STAGE3_STAGE2_RUN_DIR,
      collectedWithinHours: parseOptionalPositiveInt(
        process.env.STAGE3_COLLECTED_WITHIN_HOURS,
      ),
      eventTopN: parseOptionalPositiveInt(process.env.STAGE3_EVENT_TOP_N),
      model: process.env.OPENAI_MODEL,
    });

    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
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
