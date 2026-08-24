import { config } from "dotenv";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  completeRawArticleContent,
  resolveContentCompletionLimits,
  type ContentCompletionMetrics,
} from "../src/processing/content-completion.js";
import {
  contentCompletionRunDir,
  writeContentCompletionRuntime,
  type ContentCompletionRuntimeArtifact,
} from "../src/processing/content-completion-runtime.js";

const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const startedAt = new Date();
  const options = {
    sourceNames: parseSourceNames(process.env.CONTENT_COMPLETION_SOURCE_NAMES),
    limit: optionalNumber(process.env.CONTENT_COMPLETION_LIMIT),
    perSourceLimit: optionalNumber(process.env.CONTENT_COMPLETION_PER_SOURCE_LIMIT),
    concurrency: optionalNumber(process.env.CONTENT_COMPLETION_CONCURRENCY),
  };
  const limits = resolveContentCompletionLimits(options);
  const runDir = contentCompletionRunDir(startedAt);
  const artifact: ContentCompletionRuntimeArtifact = {
    status: "running",
    started_at: startedAt.toISOString(),
    finished_at: null,
    duration_ms: null,
    candidate_count: null,
    selected_count: null,
    success_count: null,
    failed_count: null,
    skipped_count: null,
    remaining_count: null,
    limit: limits.limit,
    per_source_limit: limits.perSourceLimit,
    error: null,
  };

  await writeContentCompletionRuntime(runDir, artifact);
  await writeRunPointer(runDir);

  let pool: Pool | null = null;

  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required to complete raw article content.");
    }

    pool = new Pool({
      connectionString: databaseUrl,
      ssl:
        process.env.DATABASE_SSL === "true"
          ? {
              rejectUnauthorized: false,
            }
          : undefined,
    });
    const summary = await completeRawArticleContent(pool, options, (metrics) => {
      applyMetrics(artifact, metrics);
    });
    finishArtifact(artifact, startedAt, "success", null);
    await writeContentCompletionRuntime(runDir, artifact);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    finishArtifact(
      artifact,
      startedAt,
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    await writeContentCompletionRuntime(runDir, artifact);
    throw error;
  } finally {
    await pool?.end();
  }
}

function applyMetrics(
  artifact: ContentCompletionRuntimeArtifact,
  metrics: Partial<ContentCompletionMetrics>,
): void {
  artifact.candidate_count = metrics.candidateCount ?? artifact.candidate_count;
  artifact.selected_count = metrics.selectedCount ?? artifact.selected_count;
  artifact.success_count = metrics.successCount ?? artifact.success_count;
  artifact.failed_count = metrics.failedCount ?? artifact.failed_count;
  artifact.skipped_count = metrics.skippedCount ?? artifact.skipped_count;
  artifact.remaining_count = metrics.remainingCount ?? artifact.remaining_count;
}

function finishArtifact(
  artifact: ContentCompletionRuntimeArtifact,
  startedAt: Date,
  status: "success" | "failed",
  error: string | null,
): void {
  const finishedAt = new Date();
  artifact.status = status;
  artifact.finished_at = finishedAt.toISOString();
  artifact.duration_ms = finishedAt.getTime() - startedAt.getTime();
  artifact.error = error;
}

async function writeRunPointer(runDir: string): Promise<void> {
  const path = inheritedRunPointer ?? process.env.DAILY_STAGE_RUN_POINTER;
  if (path) {
    await writeFile(path, `${runDir}\n`);
  }
}

function parseSourceNames(value: string | undefined): string[] | undefined {
  const sourceNames = value
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  return sourceNames && sourceNames.length > 0 ? sourceNames : undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`Expected a positive number, got "${value}".`);
  }

  return numberValue;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
