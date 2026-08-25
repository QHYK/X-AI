import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import {
  getDashboardData,
  loadContentCompletionRuntimeByDate,
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
        query.text.includes("ra.published_at >= scope.start_at") &&
        query.text.includes("ra.published_at < scope.end_at") &&
        !query.text.includes("ra.collected_at >= scope.start_at") &&
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

const processedAggregateQuery = completedQueries.find((query) =>
  query.text.includes("count(pc.id)::int as total"),
);
const processedDetailQueries = completedQueries.filter(
  (query) =>
    query.text.includes("select category") ||
    query.text.includes("as processed_summary_chars"),
);
checks.push({
  name: "late Processed retries remain attributed to the Raw Article Daily scope",
  passed:
    processedAggregateQuery?.text.includes("left join raw_articles ra") === true &&
    processedAggregateQuery.text.includes("pc.raw_article_id = ra.id") &&
    !processedAggregateQuery.text.includes("pc.created_at >=") &&
    processedDetailQueries.length === 3 &&
    processedDetailQueries.every(
      (query) =>
        query.text.includes("join raw_articles ra on ra.id = pc.raw_article_id") &&
        query.text.includes("ra.published_at >=") &&
        query.text.includes("ra.published_at <") &&
        !query.text.includes("ra.collected_at >=") &&
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
  query.text.includes("count(distinct e.id)::int as total"),
);
checks.push({
  name: "Events are attributed through Event Candidates in the Raw scope and counted once",
  passed:
    eventAggregateQuery?.text.includes("count(distinct e.id)::int") === true &&
    eventAggregateQuery.text.includes("left join raw_articles ra") &&
    eventAggregateQuery.text.includes("pc.raw_article_id = ra.id") &&
    eventAggregateQuery.text.includes("pc.event_id is not null") &&
    eventAggregateQuery.text.includes("pc.routing = 'event'") &&
    eventAggregateQuery.text.includes("ra.published_at >= scope.start_at") &&
    !eventAggregateQuery.text.includes("e.created_at >="),
  detail: "Multiple in-scope Event Candidates for one event produce one count.",
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
const apiScopeQueries = apiQueries.filter((query) =>
  query.text.includes("from events") || query.text.includes("pc.routing ="),
);
checks.push({
  name: "API uses Raw Article scope for late Processed and Event results",
  passed:
    apiBrief.events.length === 1 &&
    Object.values(apiBrief.digests).flat().length === 1 &&
    apiBrief.long_form.length === 1 &&
    apiBrief.inspiration.length === 1 &&
    apiBrief.meta.date_basis === "raw_articles.published_at" &&
    apiScopeQueries.length === 4 &&
    apiScopeQueries.every(
      (query) =>
        query.text.includes("ra.published_at >=") &&
        query.text.includes("ra.published_at <") &&
        !query.text.includes("ra.collected_at >=") &&
        JSON.stringify(query.values) === JSON.stringify([detailScope.startAt, detailScope.endAt]),
    ),
  detail: {
    rawPublishedAt: "2026-08-23T02:00:00.000Z",
    rawCollectedAt: "2026-08-27T02:00:00.000Z",
    processedAndEventCreatedAt: "2026-08-26T02:00:00.000Z",
    dailyDate: detailScope.dailyDate,
  },
});
checks.push({
  name: "API Events use EXISTS over Event Candidates and adjacent Daily scopes do not share bounds",
  passed:
    apiQueries.some(
      (query) =>
        query.text.includes("where pc.event_id = events.id") &&
        query.text.includes("exists (") &&
        query.text.includes("pc.routing = 'event'") &&
        !query.text.includes("events.created_at >="),
    ) &&
    apiBrief.events.length === 1 &&
    adjacentApiQueries
      .filter((query) => query.text.includes("from events") || query.text.includes("pc.routing ="))
      .every(
        (query) =>
          JSON.stringify(query.values) ===
          JSON.stringify([adjacentScope.startAt, adjacentScope.endAt]),
      ) &&
    JSON.stringify([detailScope.startAt, detailScope.endAt]) !==
      JSON.stringify([adjacentScope.startAt, adjacentScope.endAt]),
  detail: "The fixture supplies two Event Candidate sources for one Event; the Event remains one item.",
});
checks.push({
  name: "Dashboard and API use identical attribution bounds for the same daily_date",
  passed: apiScopeQueries.every(
    (query) => JSON.stringify(query.values) === JSON.stringify([detailScope.startAt, detailScope.endAt]),
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
