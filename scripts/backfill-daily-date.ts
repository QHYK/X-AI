import { config } from "dotenv";
import { Pool } from "pg";
import {
  executeDailyDateBackfill,
  previewDailyDateBackfill,
} from "../src/processing/daily-date-backfill.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for daily_date backfill.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  const dryRun = process.argv.includes("--dry-run");

  try {
    if (dryRun) {
      const preview = await previewDailyDateBackfill(pool);
      console.log(JSON.stringify({
        mode: "dry_run",
        writes_database: false,
        processed_contents_total: preview.processedContentsCount,
        daily_date_null: preview.nullDailyDateCount,
        derivable_from_published_at: preview.updates.length,
        skipped_missing_or_invalid_published_at: preview.skippedCount,
        by_daily_date: preview.byDailyDate.map(({ dailyDate, count }) => ({
          daily_date: dailyDate,
          count,
        })),
      }, null, 2));
      return;
    }

    const result = await executeDailyDateBackfill(pool);
    console.log(JSON.stringify({
      mode: "execute",
      before_null_count: result.beforeNullCount,
      updated_count: result.updatedCount,
      skipped_count: result.skippedCount,
      after_null_count: result.afterNullCount,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
