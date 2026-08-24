import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  countCompletionCandidates,
  loadCompletionCandidates,
  summarizeCompletionResults,
  type ContentCompletionResult,
} from "../src/processing/content-completion.js";
import {
  contentCompletionRunDir,
  writeContentCompletionRuntime,
  type ContentCompletionRuntimeArtifact,
} from "../src/processing/content-completion-runtime.js";
import {
  formatContentCompletionRatio,
  loadContentCompletionRuntimeByDate,
} from "../src/lib/dashboard.js";

type CapturedQuery = { text: string; values: unknown[] | undefined };
type Check = { name: string; passed: boolean; detail?: unknown };

const checks: Check[] = [];
const countQueries: CapturedQuery[] = [];
let countCall = 0;
const countQueryable = createQueryable(async (text, values) => {
  countQueries.push({ text, values });
  countCall += 1;
  return { rows: [{ count: countCall === 1 ? 12 : 9 }] };
});
const completionOptions = {
  sourceNames: ["Example Source"],
  limit: 2,
  perSourceLimit: 1,
};
const candidateCount = await countCompletionCandidates(countQueryable, completionOptions);
const remainingCount = await countCompletionCandidates(countQueryable, completionOptions);
checks.push({
  name: "candidate and remaining counts share eligibility and ignore selection limits",
  passed:
    candidateCount === 12 &&
    remainingCount === 9 &&
    countQueries.length === 2 &&
    countQueries[0]?.text === countQueries[1]?.text &&
    JSON.stringify(countQueries[0]?.values) === JSON.stringify(countQueries[1]?.values) &&
    !countQueries[0]?.text.includes("source_rank") &&
    !countQueries[0]?.text.includes("limit $"),
  detail: countQueries,
});

const selectionQueries: CapturedQuery[] = [];
const selectedRows = [completionCandidate("a1"), completionCandidate("a2")];
const selectionQueryable = createQueryable(async (text, values) => {
  selectionQueries.push({ text, values });
  return { rows: selectedRows };
});
const selected = await loadCompletionCandidates(selectionQueryable, completionOptions);
checks.push({
  name: "selected count is constrained by per-source limit and total limit",
  passed:
    selected.length === 2 &&
    selectionQueries[0]?.text.includes("source_rank <= $5") === true &&
    selectionQueries[0]?.text.includes("limit $6") === true &&
    selectionQueries[0]?.values?.[4] === 1 &&
    selectionQueries[0]?.values?.[5] === 2,
  detail: selectionQueries[0],
});

const resultCounts = summarizeCompletionResults([
  completionResult("updated"),
  completionResult("updated"),
  completionResult("failed"),
  completionResult("skipped"),
]);
checks.push({
  name: "success, failed, and skipped results are counted from real statuses",
  passed:
    resultCounts.successCount === 2 &&
    resultCounts.failedCount === 1 &&
    resultCounts.skippedCount === 1,
  detail: resultCounts,
});

const rootDir = await mkdtemp(join(tmpdir(), "x-ai-content-completion-test-"));
try {
  await writeFixture(rootDir, "2026-08-24T02:00:00.000Z", {
    selected_count: 2,
    success_count: 1,
    remaining_count: 10,
  });
  await writeFixture(rootDir, "2026-08-24T08:00:00.000Z", {
    selected_count: 3,
    success_count: 2,
    remaining_count: 8,
  });

  const dashboardMetrics = await loadContentCompletionRuntimeByDate(
    rootDir,
    new Set(["2026-08-24", "2026-08-23"]),
  );
  const latest = dashboardMetrics.get("2026-08-24");
  checks.push({
    name: "Dashboard reads the latest Content Completion runtime for the date",
    passed:
      latest?.selectedCount === 3 &&
      latest.successCount === 2 &&
      latest.remainingCount === 8 &&
      formatContentCompletionRatio(latest) === "2 / 3",
    detail: latest,
  });
  checks.push({
    name: "Dashboard renders N/A when the date has no Completion runtime",
    passed:
      dashboardMetrics.get("2026-08-23") === undefined &&
      formatContentCompletionRatio(null) === "N/A",
  });
} finally {
  await rm(rootDir, { recursive: true, force: true });
}

const failures = checks.filter((check) => !check.passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

function createQueryable(
  handler: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>,
): Pick<Pool, "query"> {
  return { query: handler as Pick<Pool, "query">["query"] };
}

function completionCandidate(id: string) {
  return {
    id,
    sourceName: "Example Source",
    sourceCategory: "Technology",
    sourceType: "rss",
    title: `Article ${id}`,
    url: `https://example.com/${id}`,
    contentText: null,
  };
}

function completionResult(
  status: ContentCompletionResult["status"],
): ContentCompletionResult {
  return {
    rawArticleId: status,
    sourceName: "Example Source",
    title: status,
    url: "https://example.com/article",
    status,
    trigger: "empty_content",
    skipReason: status === "skipped" ? "known_blocked_source" : null,
    originalLength: 0,
    extractedLength: status === "updated" ? 1000 : null,
    httpStatus: status === "skipped" ? null : 200,
    error: status === "failed" ? "fetch failed" : null,
  };
}

async function writeFixture(
  rootDir: string,
  startedAt: string,
  metrics: Pick<
    ContentCompletionRuntimeArtifact,
    "selected_count" | "success_count" | "remaining_count"
  >,
): Promise<void> {
  const started = new Date(startedAt);
  const runDir = contentCompletionRunDir(started, rootDir);
  await writeContentCompletionRuntime(runDir, {
    status: "success",
    started_at: startedAt,
    finished_at: new Date(started.getTime() + 10_000).toISOString(),
    duration_ms: 10_000,
    candidate_count: 12,
    selected_count: metrics.selected_count,
    success_count: metrics.success_count,
    failed_count: 1,
    skipped_count: 0,
    remaining_count: metrics.remaining_count,
    limit: 50,
    per_source_limit: 10,
    error: null,
  });
}
