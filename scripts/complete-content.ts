import { config } from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import {
  resolveCatchupPublishedAtScope,
  resolveDailyScope,
} from "../src/lib/daily-scope.js";
import {
  completeRawArticleContent,
  resolveContentCompletionLimits,
  type ContentCompletionMetrics,
} from "../src/processing/content-completion.js";
import {
  contentCompletionRunDir,
  writeContentCompletionRuntime,
  writeContentCompletionResults,
  type ContentCompletionRuntimeArtifact,
} from "../src/processing/content-completion-runtime.js";

const inheritedRunPointer = process.env.DAILY_STAGE_RUN_POINTER;

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const startedAt = new Date();
  const dailyScope = resolveDailyScope(process.env.DAILY_DATE, startedAt);
  const scope = resolveCatchupPublishedAtScope(dailyScope);

  const options = {
    sourceNames: parseSourceNames(process.env.CONTENT_COMPLETION_SOURCE_NAMES),
    limit: optionalNumber(process.env.CONTENT_COMPLETION_LIMIT),
    perSourceLimit: optionalNumber(process.env.CONTENT_COMPLETION_PER_SOURCE_LIMIT),
    concurrency: optionalNumber(process.env.CONTENT_COMPLETION_CONCURRENCY),
    scopeStartAt: scope.startAt,
    scopeEndAt: scope.endAt,
  };
  const limits = resolveContentCompletionLimits(options);
  const runDir = contentCompletionRunDir(startedAt);
  const artifact: ContentCompletionRuntimeArtifact = {
    status: "running",
    daily_date: dailyScope.dailyDate,
    scope_start_at: scope.startAt,
    scope_end_at: scope.endAt,
    started_at: startedAt.toISOString(),
    finished_at: null,
    duration_ms: null,
    candidate_count: null,
    selected_count: null,
    success_count: null,
    failed_count: null,
    skipped_count: null,
    unusable_count: null,
    remaining_count: null,
    input_count: null,
    attempted_count: null,
    firecrawl_request_count: null,
    retry_count: null,
    content_type_distribution: null,
    raw_length: null,
    content_text_length: null,
    full_content_text_length: null,
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
    applySummaryMetrics(artifact, summary);
    await writeRawMarkdown(runDir, summary.results);
    const runtimeResults = summary.results.map((result) => {
      return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "rawMarkdown"));
    });
    await writeContentCompletionResults(runDir, runtimeResults);
    finishArtifact(artifact, startedAt, "success", null);
    await writeContentCompletionRuntime(runDir, artifact);

    // Log the summary, but exclude the rawMarkdown content
    const { results: _results, ...summaryForLog } = summary;
    console.log(
      JSON.stringify(
        {
          ...summaryForLog,
          runtimeDir: runDir,
        },
        null,
        2,
      ),
    );
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

async function writeRawMarkdown(
  runDir: string,
  results: Array<{ rawArticleId: string; rawMarkdown: string | null }>,
): Promise<void> {
  const rawDir = join(runDir, "firecrawl-raw-markdown");
  await mkdir(rawDir, { recursive: true });
  await Promise.all(results.filter((result) => result.rawMarkdown).map((result) =>
    writeFile(join(rawDir, `${result.rawArticleId}.md`), result.rawMarkdown as string),
  ));
}

function applySummaryMetrics(artifact: ContentCompletionRuntimeArtifact, summary: Awaited<ReturnType<typeof completeRawArticleContent>>): void {
  artifact.unusable_count = summary.unusableCount;
  artifact.input_count = summary.inputCount;
  artifact.attempted_count = summary.attemptedCount;
  artifact.firecrawl_request_count = summary.firecrawlRequestCount;
  artifact.retry_count = summary.retryCount;
  artifact.content_type_distribution = summary.contentTypeDistribution;
  artifact.raw_length = summary.rawLength;
  artifact.content_text_length = summary.contentTextLength;
  artifact.full_content_text_length = summary.fullContentTextLength;
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
