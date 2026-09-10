import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { assertStageLlmConfiguration } from "../src/processing/llm-client.js";
import { processStage2Merge, summarizeStage2Result } from "../src/processing/stage2-job.js";
import { writeStage2RuntimeArtifacts } from "../src/processing/stage2-runtime-artifacts.js";
import { loadStage1Runtime } from "../src/processing/stage1-runtime.js";

const inheritedStage1RunDir = process.env.STAGE2_STAGE1_RUN_DIR;
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
    const stage1 = await loadStage1Runtime(
      process.cwd(),
      inheritedStage1RunDir ?? process.env.STAGE2_STAGE1_RUN_DIR,
    );
    const result = await processStage2Merge(pool, {
      stage1StartedAt: stage1.run.started_at,
      stage1FinishedAt: stage1.run.finished_at,
    });
    const summary = summarizeStage2Result(result);
    const artifacts = await writeStage2RuntimeArtifacts(result, {
      startedAt,
      stage1RunDir: stage1.runDir,
      stage1StartedAt: stage1.run.started_at,
      stage1FinishedAt: stage1.run.finished_at,
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
