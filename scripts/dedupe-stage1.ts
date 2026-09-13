import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { readPublishedAtScopeFromEnv, resolveDailyScope } from "../src/lib/daily-scope.js";
import { ignorePreStage1ExactDuplicates } from "../src/processing/pre-stage1-exact-duplicates.js";
import { pipelineTriggerSource, safelyFinishPipelineRun, safelyStartPipelineRun } from "../src/processing/pipeline-run-log.js";

const inheritedScope = readPublishedAtScopeFromEnv(process.env);
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;
config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const scope = inheritedScope ?? readPublishedAtScopeFromEnv(process.env);
  if (!databaseUrl || !scope) throw new Error("DATABASE_URL and DAILY published_at scope are required.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined });
  const startedAt = new Date();
  const dailyDate = resolveDailyScope(process.env.DAILY_DATE, startedAt).dailyDate;
  const pipelineRunId = await safelyStartPipelineRun(pool, { dailyDate, step: "exact_duplicate_filter", triggerSource: pipelineTriggerSource(process.env.PIPELINE_TRIGGER_SOURCE), startedAt });
  try {
    const runDir = join(process.cwd(), "runtime/pre-stage1-duplicates", toRunTimestamp(startedAt));
    await mkdir(runDir, { recursive: true });
    const summary = await ignorePreStage1ExactDuplicates(pool, scope);
    await writeFile(join(runDir, "run.json"), `${JSON.stringify({
      status: "success", started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(), daily_date: process.env.DAILY_DATE ?? null,
      scope_start_at: scope.startAt, scope_end_at: scope.endAt,
      historical_reference_hours: 72, ...summary,
    }, null, 2)}\n`);
    await safelyFinishPipelineRun(pool, pipelineRunId, { status: "success", metrics: {
      input_count: summary.inputCount, duplicate_count: summary.duplicateCount, output_count: summary.outputCount,
      duplicate_rate: summary.duplicateRate, same_url_count: summary.sameUrlCount,
      same_title_count: summary.sameTitleCount, same_url_and_title_count: summary.sameUrlAndTitleCount,
    } });
    const runPointer = inheritedRunPointer ?? process.env.DAILY_STAGE_RUN_POINTER;
    if (runPointer) {
      await writeFile(runPointer, `${runDir}\n`);
    }
    console.log(JSON.stringify({ ...summary, runtimeDir: runDir }, null, 2));
  } catch (error) {
    await safelyFinishPipelineRun(pool, pipelineRunId, { status: "failed", errorSummary: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally { await pool.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

function toRunTimestamp(date: Date): string { return date.toISOString().replaceAll(":", "-").replaceAll(".", "-"); }
