import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { readPublishedAtScopeFromEnv } from "../src/lib/daily-scope.js";
import { ignorePreStage1ExactDuplicates } from "../src/processing/pre-stage1-exact-duplicates.js";

const inheritedScope = readPublishedAtScopeFromEnv(process.env);
const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;
config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const scope = inheritedScope ?? readPublishedAtScopeFromEnv(process.env);
  if (!databaseUrl || !scope) throw new Error("DATABASE_URL and DAILY published_at scope are required.");
  const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined });
  try {
    const startedAt = new Date();
    const runDir = join(process.cwd(), "runtime/pre-stage1-duplicates", toRunTimestamp(startedAt));
    await mkdir(runDir, { recursive: true });
    const summary = await ignorePreStage1ExactDuplicates(pool, scope);
    await writeFile(join(runDir, "run.json"), `${JSON.stringify({
      status: "success", started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(), ...summary,
    }, null, 2)}\n`);
    const runPointer = inheritedRunPointer ?? process.env.DAILY_STAGE_RUN_POINTER;
    if (runPointer) {
      await writeFile(runPointer, `${runDir}\n`);
    }
    console.log(JSON.stringify({ ...summary, runtimeDir: runDir }, null, 2));
  }
  finally { await pool.end(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

function toRunTimestamp(date: Date): string { return date.toISOString().replaceAll(":", "-").replaceAll(".", "-"); }
