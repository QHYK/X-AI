import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  getDashboardData,
  loadContentCompletionRuntimeByDate,
  loadRuntimeMetricsByDate,
} from "../src/lib/dashboard.js";
import {
  resolveDailyScope,
  resolveRecentCompletedDailyScopes,
} from "../src/lib/daily-scope.js";

type CapturedQuery = {
  text: string;
  values: unknown[] | undefined;
};

type Check = {
  name: string;
  passed: boolean;
  detail?: unknown;
};

const checks: Check[] = [];
const beforeBoundary = new Date("2026-08-24T16:13:00.000Z");
const afterBoundary = new Date("2026-08-25T02:00:00.000Z");
const expectedRecentDates = [
  "2026-08-24",
  "2026-08-23",
  "2026-08-22",
  "2026-08-21",
  "2026-08-20",
  "2026-08-19",
  "2026-08-18",
];

checks.push({
  name: "Dashboard defaults to the last completed Daily scope on either side of 09:00 Shanghai",
  passed:
    resolveDailyScope(undefined, beforeBoundary).dailyDate === "2026-08-24" &&
    resolveDailyScope(undefined, afterBoundary).dailyDate === "2026-08-25",
});

checks.push({
  name: "recent Dashboard dates end at the most recently completed daily_date",
  passed:
    JSON.stringify(
      resolveRecentCompletedDailyScopes(7, beforeBoundary).map((scope) => scope.dailyDate),
    ) === JSON.stringify(expectedRecentDates),
});

const completedQueries: CapturedQuery[] = [];
const completedData = await getDashboardData(createDashboardPool(completedQueries), {
  now: beforeBoundary,
  rootDir: "/private/tmp/x-ai-field-dashboard-no-runtime",
});
const detailScope = resolveDailyScope("2026-08-24");
const recentScopes = resolveRecentCompletedDailyScopes(7, beforeBoundary);

checks.push({
  name: "Dashboard uses the completed daily_date as the default Date Details value",
  passed:
    completedData.latestDailyDate === "2026-08-24" &&
    completedData.detailDate === "2026-08-24" &&
    completedData.details.scopeCompleted,
});

const topScopeQueries = completedQueries.filter((query) =>
  query.text.includes("with scopes as (") && query.text.includes("from scopes scope"),
);
checks.push({
  name: "all seven-day DB aggregates receive the same Daily scope arrays",
  passed:
    topScopeQueries.length === 3 &&
    topScopeQueries.every(
      (query) =>
        JSON.stringify(query.values) ===
        JSON.stringify([
          recentScopes.map((scope) => scope.dailyDate),
          recentScopes.map((scope) => scope.startAt),
          recentScopes.map((scope) => scope.endAt),
        ]),
    ),
  detail: topScopeQueries.map((query) => query.values),
});

const detailScopeQueries = completedQueries.filter(
  (query) =>
    query.text.includes("select category") ||
    query.text.includes("as raw_chars") ||
    query.text.includes("as processed_summary_chars") ||
    query.text.includes("coalesce(pc.display_rank, pc.ai_rank)"),
);
checks.push({
  name: "Date Details and Content Funnel use the exact same Daily scope",
  passed:
    detailScopeQueries.length >= 5 &&
    detailScopeQueries.every(
      (query) => JSON.stringify(query.values) === JSON.stringify([detailScope.startAt, detailScope.endAt]),
    ),
  detail: detailScopeQueries.map((query) => query.values),
});

const futureQueries: CapturedQuery[] = [];
const futureData = await getDashboardData(createDashboardPool(futureQueries), {
  detailDate: "2026-08-25",
  now: beforeBoundary,
  rootDir: "/private/tmp/x-ai-field-dashboard-no-runtime",
});
checks.push({
  name: "an unfinished daily_date does not load partial details or Content Funnel data",
  passed:
    !futureData.details.scopeCompleted &&
    futureData.details.contentFunnel === null &&
    Object.keys(futureData.details.processedByCategory).length === 0 &&
    Object.keys(futureData.details.digestByCategory).length === 0 &&
    !futureQueries.some(
      (query) =>
        query.text.includes("as raw_chars") ||
        query.text.includes("as processed_summary_chars") ||
        query.text.includes("coalesce(pc.display_rank, pc.ai_rank)"),
    ),
});

const runtimeRoot = await mkdtemp(join(tmpdir(), "x-ai-field-dashboard-runtime-"));
try {
  await writeRun(runtimeRoot, "runtime/stage2/fixture", {
    stage: "stage2",
    daily_date: "2026-08-20",
    started_at: "2026-08-24T16:30:00.000Z",
    finished_at: "2026-08-24T16:30:01.000Z",
    candidate_count: 7,
    final_group_count: 3,
    status: "success",
  });
  await writeRun(runtimeRoot, "runtime/content-completion/fixture", {
    daily_date: "2026-08-20",
    started_at: "2026-08-24T16:30:00.000Z",
    finished_at: "2026-08-24T16:30:01.000Z",
    candidate_count: 11,
    selected_count: 5,
    success_count: 4,
    failed_count: 1,
    remaining_count: 7,
    status: "success",
  });

  const dates = new Set(["2026-08-20"]);
  const stageRuntime = await loadRuntimeMetricsByDate(runtimeRoot, dates);
  const completionRuntime = await loadContentCompletionRuntimeByDate(runtimeRoot, dates);
  checks.push({
    name: "runtime artifacts use their recorded daily_date instead of their calendar start date",
    passed:
      stageRuntime.get("2026-08-20")?.get("stage2")?.candidateCount === 7 &&
      completionRuntime.get("2026-08-20")?.candidateCount === 11 &&
      completionRuntime.get("2026-08-20")?.remainingCount === 7,
  });
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

const failures = checks.filter((check) => !check.passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) {
  process.exitCode = 1;
}

function createDashboardPool(queries: CapturedQuery[]): Pool {
  return {
    query: (async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("as raw_articles")) {
        return { rows: [{ raw_articles: 0, processed_contents: 0, events: 0 }] };
      }
      if (text.includes("as raw_chars")) {
        return { rows: [{ raw_chars: 0, selected_chars: 0 }] };
      }
      if (text.includes("as processed_summary_chars")) {
        return { rows: [{ processed_summary_chars: 0 }] };
      }
      return { rows: [] };
    }) as Pool["query"],
  } as Pool;
}

async function writeRun(rootDir: string, relativeRunDir: string, body: unknown): Promise<void> {
  const runDir = join(rootDir, relativeRunDir);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(body)}\n`);
}
