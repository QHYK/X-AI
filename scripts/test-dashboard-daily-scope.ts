import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  getDashboardData,
  loadContentCompletionRuntimeByDate,
  loadDuplicateFilterRuntimeByDate,
  loadRuntimeMetricsByDate,
} from "../src/lib/dashboard.js";
import { getDailyBriefForDailyDate } from "../src/lib/daily-brief.js";
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
  name: "Dashboard defaults to the last completed Daily scope on either side of 08:30 Shanghai",
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
const rawAggregateQuery = completedQueries.find((query) => query.text.includes("completion_backlog"));
checks.push({
  name: "Raw intake uses published_at scope while workflow aggregates receive the target daily_date values",
  passed:
    rawAggregateQuery?.text.includes("ra.published_at >= scope.start_at") === true &&
    rawAggregateQuery.text.includes("ra.published_at < scope.end_at") &&
    JSON.stringify(rawAggregateQuery.values?.slice(0, 3)) === JSON.stringify([
      recentScopes.map((scope) => scope.dailyDate), recentScopes.map((scope) => scope.startAt), recentScopes.map((scope) => scope.endAt),
    ]) &&
    topScopeQueries.filter((query) => query.text.includes("unnest($1::text[]) as date")).length === 2 &&
    topScopeQueries.filter((query) => query.text.includes("unnest($1::text[]) as date")).every(
      (query) => JSON.stringify(query.values) === JSON.stringify([recentScopes.map((scope) => scope.dailyDate)]),
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
checks.push({ name: "Date Details and Content Funnel keep their documented scopes", passed: detailScopeQueries.length >= 5 });

const processedAggregateQuery = completedQueries.find((query) =>
  query.text.includes("count(pc.id)::int as total"),
);
const processedDetailQueries = completedQueries.filter(
  (query) =>
    query.text.includes("select category") ||
    query.text.includes("as processed_summary_chars"),
);
checks.push({
  name: "Processed counts use workflow daily_date rather than raw published_at or processed created_at",
  passed:
    processedAggregateQuery?.text.includes("pc.daily_date = scope.date::date") === true &&
    !processedAggregateQuery.text.includes("raw_articles") &&
    !processedAggregateQuery.text.includes("pc.created_at >=") &&
    processedDetailQueries.length === 3 &&
    processedDetailQueries.every(
      (query) =>
        (query.text.includes("pc.daily_date = $1::date") || query.text.includes("ra.published_at >=")) &&
        !query.text.includes("pc.created_at >="),
    ),
  detail: {
    rawPublishedAt: "2026-08-19T05:00:00.000Z",
    rawCollectedAt: "2026-08-22T05:00:00.000Z",
    processedCreatedAt: "2026-08-21T05:00:00.000Z",
    dailyDate: "2026-08-20",
  },
});

const eventAggregateQuery = completedQueries.find((query) =>
  query.text.includes("left join stage4_runs s4r"),
);
checks.push({
  name: "Events are attributed through stage4_runs.daily_date and split by publication state",
  passed:
    eventAggregateQuery?.text.includes("stage4_runs s4r on s4r.daily_date = scope.date::date") === true &&
    eventAggregateQuery.text.includes("publication_status = 'published'") &&
    eventAggregateQuery.text.includes("publication_status = 'draft'") &&
    !eventAggregateQuery.text.includes("raw_articles") &&
    !eventAggregateQuery.text.includes("events.event_date"),
  detail: "Published and draft Event counts follow Stage4 workflow ownership.",
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

const apiQueries: CapturedQuery[] = [];
const apiBrief = await getDailyBriefForDailyDate(createBriefPool(apiQueries), detailScope.dailyDate);
const adjacentScope = resolveDailyScope("2026-08-25");
const adjacentApiQueries: CapturedQuery[] = [];
await getDailyBriefForDailyDate(createBriefPool(adjacentApiQueries), adjacentScope.dailyDate);
checks.push({
  name: "API Events use published Stage 4 runs and workflow daily_date",
  passed:
    apiBrief.events.length === 1 &&
    Object.values(apiBrief.digests).flat().length === 1 &&
    apiBrief.long_form.length === 1 &&
    apiBrief.inspiration.length === 1 &&
    apiBrief.meta.date_basis === "workflow_daily_date" &&
    apiQueries.some((query) => query.text.includes("join stage4_runs") && query.text.includes("publication_status = 'published'") && JSON.stringify(query.values) === JSON.stringify([detailScope.dailyDate])),
  detail: {
    rawPublishedAt: "2026-08-23T02:00:00.000Z",
    rawCollectedAt: "2026-08-27T02:00:00.000Z",
    processedAndEventCreatedAt: "2026-08-26T02:00:00.000Z",
    dailyDate: detailScope.dailyDate,
  },
});
checks.push({ name: "API Event attribution does not filter by events.event_date", passed: apiQueries.some((query) => query.text.includes("join stage4_runs") && !query.text.includes("events.event_date =")) && adjacentApiQueries.some((query) => JSON.stringify(query.values) === JSON.stringify([adjacentScope.dailyDate])) });
checks.push({ name: "API Event query excludes draft and archived by status", passed: apiQueries.some((query) => query.text.includes("events.publication_status = 'published'")) });

const fallbackQueries: CapturedQuery[] = [];
const fallbackBrief = await getDailyBriefForDailyDate(createFallbackBriefPool(fallbackQueries), detailScope.dailyDate);
checks.push({
  name: "API falls back to drafts only when no published Events exist for the Daily",
  passed:
    fallbackBrief.events_status === "partial" && fallbackBrief.events.length === 1 &&
    fallbackQueries.some((query) => query.text.includes("publication_status = 'published'")) &&
    fallbackQueries.some((query) => query.text.includes("status in ('running', 'partial')")) &&
    fallbackQueries.some((query) => query.text.includes("publication_status = 'draft'")),
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
    prompt_version: "stage2-fixture-v1",
    status: "success",
  });
  await writeRun(runtimeRoot, "runtime/stage2/legacy-fixture", {
    stage: "stage2",
    daily_date: "2026-08-19",
    started_at: "2026-08-19T01:30:00.000Z",
    finished_at: "2026-08-19T01:30:01.000Z",
    status: "success",
  });
  await writeRun(runtimeRoot, "runtime/stage3/fixture", {
    stage: "stage3",
    daily_date: "2026-08-20",
    started_at: "2026-08-24T16:31:00.000Z",
    finished_at: "2026-08-24T16:31:01.000Z",
    prompt_versions: {
      event: "event-fixture-v1",
      digest: "digest-fixture-v2",
      long_form: "long-form-fixture-v3",
    },
    status: "success",
  });
  await writeRun(runtimeRoot, "runtime/stage4/fixture", {
    stage: "stage4",
    daily_date: "2026-08-20",
    started_at: "2026-08-24T16:32:00.000Z",
    finished_at: "2026-08-24T16:32:01.000Z",
    prompt_version: "stage4-fixture-v4",
    web_search_event_count: 2,
    total_web_search_calls: 5,
    status: "success",
  });
  await writeRun(runtimeRoot, "runtime/stage1/complete-contract", {
    stage: "stage1", daily_date: "2026-08-20", started_at: "2026-08-24T16:33:00.000Z",
    finished_at: "2026-08-24T16:33:01.000Z", status: "success", model: "stage1-model",
    prompt_version: "stage1-fixture-v6", llm_call_count: 5, retry_count: 1, batch_count: 3,
    fallback_batch_count: 1, split_count: 2, singleton_batch_count: 1,
  });
  await writeRun(runtimeRoot, "runtime/daily/fixture", {
    daily_date: "2026-08-20",
    started_at: "2026-08-24T16:29:00.000Z",
    status: "success",
    duplicate_filter_run: join(runtimeRoot, "runtime/pre-stage1-duplicates/fixture"),
    steps: [
      {
        name: "process:stage1",
        started_at: "2026-08-24T16:30:00.000Z",
        duration_ms: 1000,
        prompt_version: "stage1-fixture-v5",
        status: "success",
      },
    ],
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
  await writeRun(runtimeRoot, "runtime/pre-stage1-duplicates/fixture", {
    status: "success",
    inputCount: 10,
    duplicateCount: 3,
    outputCount: 7,
    duplicateRate: 0.3,
    sameUrlCount: 1,
    sameTitleCount: 1,
    sameUrlAndTitleCount: 1,
  });

  const dates = new Set(["2026-08-20", "2026-08-19"]);
  const stageRuntime = await loadRuntimeMetricsByDate(runtimeRoot, dates);
  const stages = stageRuntime.get("2026-08-20");
  const completionRuntime = await loadContentCompletionRuntimeByDate(runtimeRoot, dates);
  const duplicateFilterRuntime = await loadDuplicateFilterRuntimeByDate(runtimeRoot, dates);
  checks.push({
    name: "runtime artifacts use their recorded daily_date instead of their calendar start date",
    passed:
      stageRuntime.get("2026-08-20")?.get("stage2")?.candidateCount === 7 &&
      completionRuntime.get("2026-08-20")?.candidateCount === 11 &&
      completionRuntime.get("2026-08-20")?.remainingCount === 7,
  });
  checks.push({
    name: "Dashboard reads the current Stage1 runtime contract including model and batch metrics",
    passed:
      stages?.get("stage1")?.model === "stage1-model" && stages.get("stage1")?.llmCalls === 5 &&
      stages.get("stage1")?.batchCount === 3 && stages.get("stage1")?.fallbackBatchCount === 1 &&
      stages.get("stage1")?.splitCount === 2 && stages.get("stage1")?.singletonBatchCount === 1,
  });
  checks.push({
    name: "Dashboard runtime returns Exact Duplicate Filter statistics from the Daily run artifact",
    passed:
      duplicateFilterRuntime.get("2026-08-20")?.duplicateCount === 3 &&
      duplicateFilterRuntime.get("2026-08-20")?.outputCount === 7 &&
      duplicateFilterRuntime.get("2026-08-20")?.sameUrlCount === 1 &&
      duplicateFilterRuntime.get("2026-08-20")?.sameTitleCount === 1 &&
      duplicateFilterRuntime.get("2026-08-20")?.sameUrlAndTitleCount === 1,
  });
  const dashboardWithDuplicateFilter = await getDashboardData(createDashboardPool([]), {
    now: new Date("2026-08-20T16:30:00.000Z"),
    rootDir: runtimeRoot,
  });
  checks.push({
    name: "Dashboard Date Details exposes Exact Duplicate Filter statistics",
    passed:
      dashboardWithDuplicateFilter.details.duplicateFilter?.duplicateCount === 3 &&
      dashboardWithDuplicateFilter.details.duplicateFilter?.duplicateRate === 0.3 &&
      dashboardWithDuplicateFilter.details.duplicateFilter?.outputCount === 7,
  });
  checks.push({
    name: "legacy runtime without a prompt version remains N/A",
    passed: stageRuntime.get("2026-08-19")?.get("stage2")?.promptVersion === null,
  });
  checks.push({
    name: "Dashboard reads real prompt versions without merging Stage 3 prompts",
    passed:
      stages?.get("stage1")?.promptVersion === "stage1-fixture-v6" &&
      stages.get("stage2")?.promptVersion === "stage2-fixture-v1" &&
      stages.get("stage3")?.promptVersion === null &&
      stages.get("stage3")?.promptVersions?.event === "event-fixture-v1" &&
      stages.get("stage3")?.promptVersions?.digest === "digest-fixture-v2" &&
      stages.get("stage3")?.promptVersions?.longForm === "long-form-fixture-v3" &&
      stages.get("stage4")?.promptVersion === "stage4-fixture-v4",
  });
  checks.push({
    name: "Dashboard keeps Stage 4 Web Search Events and Calls as separate metrics",
    passed:
      stages?.get("stage4")?.webSearchEventCount === 2 &&
      stages.get("stage4")?.totalWebSearchCalls === 5,
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

function createBriefPool(queries: CapturedQuery[]): Pool {
  return {
    query: (async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("from events")) {
        return {
          rows: [
            {
              id: "event-1",
              rank: 1,
              event_date: "2026-08-24",
              created_at: "2026-08-26T02:00:00.000Z",
              title: "Event",
              title_zh: "事件",
              summary: "Event summary",
              summary_zh: "事件摘要",
              tags: [],
              tags_zh: [],
              entities: [],
              entities_zh: [],
              source_perspectives: {},
              external_context: null,
            },
          ],
        };
      }
      if (text.includes("where pc.event_id = any")) {
        return {
          rows: [
            { event_id: "event-1", source: "Source A", title: "Candidate A", url: null },
            { event_id: "event-1", source: "Source B", title: "Candidate B", url: null },
          ],
        };
      }
      if (text.includes("pc.routing = 'digest'")) {
        return { rows: [briefContentRow("digest-1", "Digest")] };
      }
      if (text.includes("pc.routing = 'long_form'")) {
        return { rows: [briefContentRow("long-form-1", "Long form")] };
      }
      if (text.includes("pc.routing = 'inspiration'")) {
        return { rows: [briefContentRow("inspiration-1", "Inspiration")] };
      }
      return { rows: [] };
    }) as Pool["query"],
  } as Pool;
}

function createFallbackBriefPool(queries: CapturedQuery[]): Pool {
  return {
    query: (async (text: string, values?: unknown[]) => {
      queries.push({ text, values });
      if (text.includes("join stage4_runs")) return { rows: [] };
      if (text.includes("status in ('running', 'partial')")) return { rows: [{ id: "partial-run" }] };
      if (text.includes("events.stage4_run_id")) return { rows: [briefEventRow("draft-event")] };
      if (text.includes("where pc.event_id = any")) return { rows: [] };
      if (text.includes("pc.routing = 'digest'") || text.includes("pc.routing = 'long_form'") || text.includes("pc.routing = 'inspiration'")) return { rows: [] };
      return { rows: [] };
    }) as Pool["query"],
  } as Pool;
}

function briefEventRow(id: string) {
  return {
    id, rank: 1, event_date: "2026-08-24", created_at: "2026-08-26T02:00:00.000Z",
    title: "Event", title_zh: "事件", summary: "Event summary", summary_zh: "事件摘要",
    tags: [], tags_zh: [], entities: [], entities_zh: [], source_perspectives: {}, external_context: null,
  };
}

function briefContentRow(id: string, title: string) {
  return {
    id,
    rank: 1,
    title,
    title_zh: title,
    summary: `${title} summary`,
    summary_zh: `${title} 摘要`,
    category: "Technology",
    source: "Source",
    url: null,
    image_url: null,
    published_at: "2026-08-23T02:00:00.000Z",
    created_at: "2026-08-26T02:00:00.000Z",
  };
}

async function writeRun(rootDir: string, relativeRunDir: string, body: unknown): Promise<void> {
  const runDir = join(rootDir, relativeRunDir);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "run.json"), `${JSON.stringify(body)}\n`);
}
