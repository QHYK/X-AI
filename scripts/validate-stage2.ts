import { mkdir, writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { Pool } from "pg";
import { processStage2Merge, summarizeStage2Result } from "../src/processing/stage2-job.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const REPORT_PATH =
  process.env.STAGE2_VALIDATION_REPORT_PATH ?? "docs/spikes/stage2-validation-report.json";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to validate Stage 2.");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to validate Stage 2.");
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
    const result = await processStage2Merge(pool, {
      collectedWithinHours: optionalPositiveInteger(process.env.STAGE2_COLLECTED_WITHIN_HOURS),
      model: process.env.OPENAI_MODEL,
    });
    const summary = summarizeStage2Result(result);

    await mkdir("docs/spikes", { recursive: true });
    await writeFile(
      REPORT_PATH,
      `${JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          summary,
          input: result.input,
          idMap: result.idMap,
          eventGroups: result.success ? result.eventGroups : [],
        },
        null,
        2,
      )}\n`,
    );

    console.log(JSON.stringify({ ...summary, reportPath: REPORT_PATH }, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
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
