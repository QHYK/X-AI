import { config } from "dotenv";
import { Pool } from "pg";
import {
  countBy,
  loadStage4RecoveryCandidates,
  selectLatestMissingCandidatesByEventDate,
} from "../src/processing/stage4-event-recovery.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Stage 4 recovery dry-run.");
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
    const candidates = await loadStage4RecoveryCandidates(pool);
    const missing = candidates.filter((candidate) => !candidate.originalEventExists);
    const recoverable = missing.filter(
      (candidate) => candidate.requiredFieldsAvailable && candidate.eventDate !== null,
    );
    const byDate = countBy(
      recoverable.map((candidate) => candidate.eventDate ?? "UNKNOWN"),
    );
    const latestRecoverable = selectLatestMissingCandidatesByEventDate(candidates);
    const unknown = missing.filter(
      (candidate) => !candidate.requiredFieldsAvailable || candidate.eventDate === null,
    );

    console.log(
      JSON.stringify(
        {
          mode: "dry_run",
          writes_database: false,
          successful_stage4_events_seen: candidates.length,
          missing_from_events_table: missing.length,
          recoverable_without_llm: recoverable.length,
          recoverable_by_event_date: byDate,
          latest_recoverable_without_llm: latestRecoverable.length,
          latest_recoverable_by_event_date: countBy(
            latestRecoverable.map((candidate) => candidate.eventDate ?? "UNKNOWN"),
          ),
          latest_recovery_run_by_event_date: latestRecoveryRunByEventDate(latestRecoverable),
          not_recoverable_without_additional_data: unknown.map((candidate) => ({
            run_dir: candidate.runDir,
            event_group_id: candidate.eventGroupId,
            original_event_id: candidate.originalEventId,
            event_date: candidate.eventDate,
            required_fields_available: candidate.requiredFieldsAvailable,
          })),
          candidates: recoverable.map(toReportCandidate),
          latest_recoverable_candidates: latestRecoverable.map(toReportCandidate),
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

function latestRecoveryRunByEventDate(
  candidates: ReturnType<typeof selectLatestMissingCandidatesByEventDate>,
): Record<string, string> {
  return candidates.reduce<Record<string, string>>((accumulator, candidate) => {
    if (candidate.eventDate) {
      accumulator[candidate.eventDate] = candidate.runDir;
    }

    return accumulator;
  }, {});
}

function toReportCandidate(candidate: ReturnType<typeof selectLatestMissingCandidatesByEventDate>[number]) {
  return {
    run_dir: candidate.runDir,
    event_group_id: candidate.eventGroupId,
    original_event_id: candidate.originalEventId,
    original_event_exists: candidate.originalEventExists,
    event_date: candidate.eventDate,
    event_date_source: candidate.eventDateSource,
    rank: candidate.rank,
    processed_content_ids: candidate.processedContentIds,
    required_fields_available: candidate.requiredFieldsAvailable,
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
