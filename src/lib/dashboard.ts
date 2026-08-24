import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { parseBriefDate, type ShanghaiDayRange } from "./brief-date.js";
import { getDailyBrief, type DailyBriefResponse } from "./daily-brief.js";
import { resolveDailyScope } from "./daily-scope.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DASHBOARD_DAYS = 7;
const STAGES = ["stage1", "stage2", "stage3", "stage4"] as const;

type Routing = "event" | "digest" | "long_form" | "inspiration";
export type DashboardStage = (typeof STAGES)[number];

type CountRow = {
  date: string;
  total: number | string;
  pending?: number | string;
  selected?: number | string;
  ignored?: number | string;
  failed?: number | string;
  event?: number | string;
  digest?: number | string;
  long_form?: number | string;
  inspiration?: number | string;
};

type CategoryRow = {
  category: string;
  count: number | string;
};

type TotalRow = {
  raw_articles: number | string;
  processed_contents: number | string;
  events: number | string;
};

type ContentFunnelRow = {
  raw_chars?: number | string;
  selected_chars?: number | string;
  processed_summary_chars?: number | string;
};

type JsonObject = Record<string, unknown>;

export type DashboardStageMetrics = {
  stage: DashboardStage;
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  llmDurationMs: number | null;
  llmCalls: number | null;
  retryCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  candidateCount: number | null;
  groupCount: number | null;
  selectedEventCount: number | null;
  digestBeforeDedup: number | null;
  digestAfterDedup: number | null;
  longFormCount: number | null;
  enrichmentSuccessCount: number | null;
  enrichmentFailureCount: number | null;
  eventsCreated: number | null;
};

export type DashboardContentCompletionMetrics = {
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  candidateCount: number | null;
  selectedCount: number | null;
  successCount: number | null;
  failedCount: number | null;
  skippedCount: number | null;
  remainingCount: number | null;
  limit: number | null;
  perSourceLimit: number | null;
};

export type DashboardContentFunnel = {
  rawChars: number;
  selectedChars: number;
  processedSummaryChars: number;
  dailyBriefChars: number;
};

export function formatContentCompletionRatio(
  metrics: DashboardContentCompletionMetrics | null,
): string {
  if (metrics?.successCount === null || metrics?.successCount === undefined) {
    return "N/A";
  }
  if (metrics.selectedCount === null) {
    return "N/A";
  }
  return `${metrics.successCount.toLocaleString("en-US")} / ${metrics.selectedCount.toLocaleString("en-US")}`;
}

export type DashboardDay = {
  date: string;
  raw: {
    total: number;
    pending: number;
    selected: number;
    ignored: number;
    failed: number;
  };
  processed: Record<Routing, number> & { total: number };
  events: number;
  runtime: {
    contentCompletion: DashboardContentCompletionMetrics | null;
    stages: Record<DashboardStage, DashboardStageMetrics | null>;
    llmCalls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    durationMs: number | null;
  };
};

export type DashboardData = {
  timezone: "Asia/Shanghai";
  today: string;
  detailDate: string;
  totals: {
    rawArticles: number;
    processedContents: number;
    events: number;
  };
  days: DashboardDay[];
  details: {
    contentFunnel: DashboardContentFunnel;
    processedByCategory: Record<string, number>;
    digestByCategory: Record<string, number>;
    contentCompletion: DashboardContentCompletionMetrics | null;
    stages: Record<DashboardStage, DashboardStageMetrics | null>;
  };
};

export async function getDashboardData(
  pool: Pool,
  options: { detailDate?: string | null; rootDir?: string; now?: Date } = {},
): Promise<DashboardData> {
  const ranges = getRecentShanghaiDayRanges(options.now ?? new Date(), DASHBOARD_DAYS);
  const todayRange = ranges[0];
  if (!todayRange) {
    throw new Error("Dashboard date range is empty.");
  }

  const oldestRange = ranges.at(-1);
  if (!oldestRange) {
    throw new Error("Dashboard oldest date range is missing.");
  }
  const detailRange = parseBriefDate(options.detailDate ?? "") ?? todayRange;

  const [
    totalsResult,
    rawResult,
    processedResult,
    eventsResult,
    processedCategoriesResult,
    digestCategoriesResult,
    runtimeByDate,
    completionByDate,
    contentFunnel,
  ] = await Promise.all([
    pool.query<TotalRow>(`
      select
        (select count(*)::int from raw_articles) as raw_articles,
        (select count(*)::int from processed_contents) as processed_contents,
        (select count(*)::int from events) as events
    `),
    pool.query<CountRow>(
      `
        select
          to_char(collected_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as date,
          count(*)::int as total,
          count(*) filter (where stage1_status = 'pending')::int as pending,
          count(*) filter (where stage1_status = 'selected')::int as selected,
          count(*) filter (where stage1_status = 'ignored')::int as ignored,
          count(*) filter (where stage1_status = 'failed')::int as failed
        from raw_articles
        where collected_at >= $1::timestamptz
          and collected_at < $2::timestamptz
        group by 1
      `,
      [oldestRange.startUtc, todayRange.endUtc],
    ),
    pool.query<CountRow>(
      `
        select
          to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as date,
          count(*)::int as total,
          count(*) filter (where routing = 'event')::int as event,
          count(*) filter (where routing = 'digest')::int as digest,
          count(*) filter (where routing = 'long_form')::int as long_form,
          count(*) filter (where routing = 'inspiration')::int as inspiration
        from processed_contents
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
        group by 1
      `,
      [oldestRange.startUtc, todayRange.endUtc],
    ),
    pool.query<CountRow>(
      `
        select
          to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD') as date,
          count(*)::int as total
        from events
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
        group by 1
      `,
      [oldestRange.startUtc, todayRange.endUtc],
    ),
    pool.query<CategoryRow>(
      `
        select category, count(*)::int as count
        from processed_contents
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
        group by category
        order by count desc, category asc
      `,
      [detailRange.startUtc, detailRange.endUtc],
    ),
    pool.query<CategoryRow>(
      `
        select category, count(*)::int as count
        from processed_contents
        where created_at >= $1::timestamptz
          and created_at < $2::timestamptz
          and routing = 'digest'
        group by category
        order by count desc, category asc
      `,
      [detailRange.startUtc, detailRange.endUtc],
    ),
    loadRuntimeMetricsByDate(
      options.rootDir ?? process.cwd(),
      new Set([...ranges.map((range) => range.date), detailRange.date]),
    ),
    loadContentCompletionRuntimeByDate(
      options.rootDir ?? process.cwd(),
      new Set([...ranges.map((range) => range.date), detailRange.date]),
    ),
    loadContentFunnel(pool, detailRange),
  ]);

  const totals = totalsResult.rows[0];
  if (!totals) {
    throw new Error("Dashboard totals query returned no rows.");
  }

  const rawByDate = rowsByDate(rawResult.rows);
  const processedByDate = rowsByDate(processedResult.rows);
  const eventsByDate = rowsByDate(eventsResult.rows);

  const days = ranges.map((range) => {
    const raw = rawByDate.get(range.date);
    const processed = processedByDate.get(range.date);
    const event = eventsByDate.get(range.date);
    const stages = emptyStageMap();
    const runtimeStages = runtimeByDate.get(range.date);

    for (const stage of STAGES) {
      stages[stage] = runtimeStages?.get(stage) ?? null;
    }

    const availableStages = Object.values(stages).filter(
      (metrics): metrics is DashboardStageMetrics => metrics !== null,
    );

    return {
      date: range.date,
      raw: {
        total: count(raw?.total),
        pending: count(raw?.pending),
        selected: count(raw?.selected),
        ignored: count(raw?.ignored),
        failed: count(raw?.failed),
      },
      processed: {
        total: count(processed?.total),
        event: count(processed?.event),
        digest: count(processed?.digest),
        long_form: count(processed?.long_form),
        inspiration: count(processed?.inspiration),
      },
      events: count(event?.total),
      runtime: {
        contentCompletion: completionByDate.get(range.date) ?? null,
        stages,
        llmCalls: sumKnown(availableStages.map((stage) => stage.llmCalls)),
        inputTokens: sumKnown(availableStages.map((stage) => stage.inputTokens)),
        outputTokens: sumKnown(availableStages.map((stage) => stage.outputTokens)),
        totalTokens: sumKnown(availableStages.map((stage) => stage.totalTokens)),
        durationMs: sumKnown(availableStages.map((stage) => stage.durationMs)),
      },
    } satisfies DashboardDay;
  });

  const detailStages = emptyStageMap();
  const runtimeDetailStages = runtimeByDate.get(detailRange.date);
  for (const stage of STAGES) {
    detailStages[stage] = runtimeDetailStages?.get(stage) ?? null;
  }

  return {
    timezone: "Asia/Shanghai",
    today: todayRange.date,
    detailDate: detailRange.date,
    totals: {
      rawArticles: count(totals.raw_articles),
      processedContents: count(totals.processed_contents),
      events: count(totals.events),
    },
    days,
    details: {
      contentFunnel,
      processedByCategory: categoryCounts(processedCategoriesResult.rows),
      digestByCategory: categoryCounts(digestCategoriesResult.rows),
      contentCompletion: completionByDate.get(detailRange.date) ?? null,
      stages: detailStages,
    },
  };
}

async function loadContentFunnel(
  pool: Pool,
  briefRange: ShanghaiDayRange,
): Promise<DashboardContentFunnel> {
  const scope = resolveDailyScope(briefRange.date);
  const [rawResult, processedResult, brief] = await Promise.all([
    pool.query<ContentFunnelRow>(
      `
        select
          coalesce(sum(
            char_length(coalesce(title, ''))
            + char_length(coalesce(content_text, ''))
          ), 0)::bigint as raw_chars,
          coalesce(sum(
            char_length(coalesce(title, ''))
            + char_length(coalesce(content_text, ''))
          ) filter (where stage1_status = 'selected'), 0)::bigint as selected_chars
        from raw_articles
        where collected_at >= $1::timestamptz
          and collected_at < $2::timestamptz
      `,
      [scope.startAt, scope.endAt],
    ),
    pool.query<ContentFunnelRow>(
      `
        select
          coalesce(sum(
            char_length(coalesce(pc.title_zh, ''))
            + char_length(coalesce(pc.summary_zh, ''))
          ), 0)::bigint as processed_summary_chars
        from processed_contents pc
        join raw_articles ra on ra.id = pc.raw_article_id
        where ra.collected_at >= $1::timestamptz
          and ra.collected_at < $2::timestamptz
      `,
      [scope.startAt, scope.endAt],
    ),
    getDailyBrief(pool, briefRange),
  ]);

  const raw = rawResult.rows[0];
  const processed = processedResult.rows[0];
  return {
    rawChars: count(raw?.raw_chars),
    selectedChars: count(raw?.selected_chars),
    processedSummaryChars: count(processed?.processed_summary_chars),
    dailyBriefChars: countDailyBriefCharacters(brief),
  };
}

function countDailyBriefCharacters(brief: DailyBriefResponse): number {
  const events = brief.events.reduce(
    (sum, item) => sum + characterLength(item.title_zh) + characterLength(item.summary_zh),
    0,
  );
  const digests = Object.values(brief.digests)
    .flat()
    .reduce(
      (sum, item) => sum + characterLength(item.title_zh) + characterLength(item.summary_zh),
      0,
    );
  const longForm = brief.long_form.reduce(
    (sum, item) => sum + characterLength(item.title_zh) + characterLength(item.summary_zh),
    0,
  );
  return events + digests + longForm;
}

function characterLength(value: string | null): number {
  return value === null ? 0 : Array.from(value).length;
}

export async function loadContentCompletionRuntimeByDate(
  rootDir: string,
  requestedDates: Set<string>,
): Promise<Map<string, DashboardContentCompletionMetrics>> {
  const completionDir = join(rootDir, "runtime", "content-completion");
  let runNames: string[];
  try {
    runNames = await readdir(completionDir);
  } catch (error) {
    if (isMissingFile(error)) {
      return new Map();
    }
    throw error;
  }

  const runs = await Promise.all(
    runNames.map(async (runName) => {
      const runDir = join(completionDir, runName);
      try {
        const artifact = asObject(
          JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
        );
        if (!artifact) {
          throw new Error("Content Completion run.json must contain a JSON object.");
        }

        const startedAt = stringValue(artifact.started_at) ?? parseRunName(runName);
        if (!startedAt) {
          throw new Error("Content Completion run.json has no valid started_at timestamp.");
        }
        const date = formatShanghaiDate(new Date(startedAt));
        if (!requestedDates.has(date)) {
          return null;
        }

        return {
          date,
          metrics: contentCompletionMetricsFromArtifact(artifact, startedAt),
        };
      } catch (error) {
        if (!isMissingFile(error)) {
          console.error(
            `Failed to read dashboard Content Completion runtime artifact ${runDir}.`,
            error,
          );
        }
        return null;
      }
    }),
  );

  const byDate = new Map<string, DashboardContentCompletionMetrics>();
  for (const run of runs) {
    if (!run) {
      continue;
    }
    const previous = byDate.get(run.date);
    if (!previous || compareStartedAt(run.metrics.startedAt, previous.startedAt) > 0) {
      byDate.set(run.date, run.metrics);
    }
  }
  return byDate;
}

function contentCompletionMetricsFromArtifact(
  artifact: JsonObject,
  startedAt: string,
): DashboardContentCompletionMetrics {
  const finishedAt = stringValue(artifact.finished_at);
  return {
    status: stringValue(artifact.status),
    startedAt,
    durationMs:
      numberFrom(artifact, "duration_ms") ?? durationBetween(startedAt, finishedAt),
    candidateCount: numberFrom(artifact, "candidate_count"),
    selectedCount: numberFrom(artifact, "selected_count"),
    successCount: numberFrom(artifact, "success_count"),
    failedCount: numberFrom(artifact, "failed_count"),
    skippedCount: numberFrom(artifact, "skipped_count"),
    remainingCount: numberFrom(artifact, "remaining_count"),
    limit: numberFrom(artifact, "limit"),
    perSourceLimit: numberFrom(artifact, "per_source_limit"),
  };
}

function getRecentShanghaiDayRanges(now: Date, days: number): ShanghaiDayRange[] {
  const today = parseBriefDate(formatShanghaiDate(now));
  if (!today) {
    throw new Error("Unable to determine today's Asia/Shanghai date.");
  }

  return Array.from({ length: days }, (_, index) => {
    const date = formatShanghaiDate(new Date(today.startUtc.getTime() - index * DAY_MS));
    const range = parseBriefDate(date);
    if (!range) {
      throw new Error(`Unable to build dashboard date range for ${date}.`);
    }
    return range;
  });
}

function formatShanghaiDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

async function loadRuntimeMetricsByDate(
  rootDir: string,
  requestedDates: Set<string>,
): Promise<Map<string, Map<DashboardStage, DashboardStageMetrics>>> {
  const byDate = new Map<string, Map<DashboardStage, DashboardStageMetrics>>();

  await Promise.all(
    STAGES.map(async (stage) => {
      const stageDir = join(rootDir, "runtime", stage);
      let runNames: string[];
      try {
        runNames = await readdir(stageDir);
      } catch (error) {
        if (isMissingFile(error)) {
          return;
        }
        throw error;
      }

      const runs = await Promise.all(
        runNames.map(async (runName) => {
          const runDir = join(stageDir, runName);
          try {
            const artifact = asObject(
              JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
            );
            if (!artifact) {
              throw new Error("run.json must contain a JSON object.");
            }

            const startedAt = stringValue(artifact.started_at) ?? parseRunName(runName);
            if (!startedAt) {
              throw new Error("run.json has no valid started_at timestamp.");
            }

            const date = formatShanghaiDate(new Date(startedAt));
            if (!requestedDates.has(date)) {
              return null;
            }

            return {
              date,
              metrics: await parseStageMetrics(stage, runDir, artifact, startedAt),
            };
          } catch (error) {
            if (!isMissingFile(error)) {
              console.error(`Failed to read dashboard runtime artifact ${runDir}.`, error);
            }
            return null;
          }
        }),
      );

      for (const run of runs) {
        if (!run) {
          continue;
        }
        const dateStages = byDate.get(run.date) ?? new Map();
        const previous = dateStages.get(stage);
        if (!previous || compareStartedAt(run.metrics.startedAt, previous.startedAt) > 0) {
          dateStages.set(stage, run.metrics);
          byDate.set(run.date, dateStages);
        }
      }
    }),
  );

  const dailyStage1Runs = await loadDailyStage1Metrics(rootDir, requestedDates);
  for (const run of dailyStage1Runs) {
    const dateStages = byDate.get(run.date) ?? new Map();
    const previous = dateStages.get("stage1");
    if (!previous || compareStartedAt(run.metrics.startedAt, previous.startedAt) > 0) {
      dateStages.set("stage1", run.metrics);
      byDate.set(run.date, dateStages);
    }
  }

  return byDate;
}

async function loadDailyStage1Metrics(
  rootDir: string,
  requestedDates: Set<string>,
): Promise<Array<{ date: string; metrics: DashboardStageMetrics }>> {
  const dailyDir = join(rootDir, "runtime", "daily");
  let runNames: string[];
  try {
    runNames = await readdir(dailyDir);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }

  const runs = await Promise.all(
    runNames.map(async (runName) => {
      const runDir = join(dailyDir, runName);
      try {
        const artifact = asObject(
          JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
        );
        if (!artifact) {
          throw new Error("Daily run.json must contain a JSON object.");
        }
        const steps = Array.isArray(artifact.steps) ? artifact.steps : [];
        const stage1Step = steps
          .map(asObject)
          .find((step) => step && stringValue(step.name) === "process:stage1");
        if (!stage1Step) {
          return null;
        }

        const startedAt = stringValue(stage1Step.started_at);
        if (!startedAt) {
          throw new Error("Daily Stage 1 step has no valid started_at timestamp.");
        }
        const date = formatShanghaiDate(new Date(startedAt));
        if (!requestedDates.has(date)) {
          return null;
        }

        return {
          date,
          metrics: stage1MetricsFromDailyStep(stage1Step, startedAt),
        };
      } catch (error) {
        if (!isMissingFile(error)) {
          console.error(`Failed to read dashboard daily runtime artifact ${runDir}.`, error);
        }
        return null;
      }
    }),
  );

  return runs.filter(
    (run): run is { date: string; metrics: DashboardStageMetrics } => run !== null,
  );
}

function stage1MetricsFromDailyStep(
  step: JsonObject,
  startedAt: string,
): DashboardStageMetrics {
  return {
    stage: "stage1",
    status: stringValue(step.status),
    startedAt,
    durationMs: numberFrom(step, "duration_ms"),
    llmDurationMs: null,
    llmCalls: null,
    retryCount: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    candidateCount: null,
    groupCount: null,
    selectedEventCount: null,
    digestBeforeDedup: null,
    digestAfterDedup: null,
    longFormCount: null,
    enrichmentSuccessCount: null,
    enrichmentFailureCount: null,
    eventsCreated: null,
  };
}

async function parseStageMetrics(
  stage: DashboardStage,
  runDir: string,
  artifact: JsonObject,
  startedAt: string,
): Promise<DashboardStageMetrics> {
  const selectedEventCount = numberFrom(artifact, "selected_event_count", "event_selected_count");
  const enrichmentSuccessCount = numberFrom(artifact, "enrichment_success_count");
  const diagnosticTokens =
    stage === "stage3" ? await loadStage3DiagnosticTokens(runDir) : null;
  const finishedAt = stringValue(artifact.finished_at);

  return {
    stage,
    status: stringValue(artifact.status),
    startedAt,
    durationMs:
      numberFrom(artifact, "total_duration_ms", "duration_ms") ??
      durationBetween(startedAt, finishedAt),
    llmDurationMs: numberFrom(artifact, "llm_duration_ms"),
    llmCalls: numberFrom(artifact, "llm_calls", "llm_call_count"),
    retryCount: numberFrom(artifact, "retry_count"),
    inputTokens: numberFrom(artifact, "input_tokens") ?? diagnosticTokens?.inputTokens ?? null,
    outputTokens:
      numberFrom(artifact, "output_tokens") ?? diagnosticTokens?.outputTokens ?? null,
    totalTokens: numberFrom(artifact, "total_tokens") ?? diagnosticTokens?.totalTokens ?? null,
    candidateCount: numberFrom(artifact, "candidate_count"),
    groupCount: numberFrom(artifact, "final_group_count", "event_group_count"),
    selectedEventCount,
    digestBeforeDedup: numberFrom(artifact, "digest_before_dedup"),
    digestAfterDedup: numberFrom(artifact, "digest_after_dedup"),
    longFormCount: numberFrom(artifact, "long_form_count"),
    enrichmentSuccessCount,
    enrichmentFailureCount:
      selectedEventCount !== null && enrichmentSuccessCount !== null
        ? Math.max(0, selectedEventCount - enrichmentSuccessCount)
        : null,
    eventsCreated: numberFrom(artifact, "events_created"),
  };
}

async function loadStage3DiagnosticTokens(runDir: string): Promise<{
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null> {
  const digestDir = join(runDir, "digest");
  let names: string[];
  try {
    names = await readdir(digestDir);
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }

  const diagnostics = await Promise.all(
    names
      .filter((name) => name.endsWith("-ranking-diagnostics.json"))
      .map(async (name) => {
        const value = asObject(JSON.parse(await readFile(join(digestDir, name), "utf8")));
        if (!value) {
          throw new Error(`${name} must contain a JSON object.`);
        }
        return value;
      }),
  );
  const inputTokens = sumKnown(
    diagnostics.flatMap((value) => [
      numberFrom(value, "initial_input_tokens"),
      numberFrom(value, "repair_input_tokens"),
    ]),
  );
  const outputTokens = sumKnown(
    diagnostics.flatMap((value) => [
      numberFrom(value, "initial_output_tokens"),
      numberFrom(value, "repair_output_tokens"),
    ]),
  );
  const totalTokens = sumKnown(
    diagnostics.flatMap((value) => [
      numberFrom(value, "initial_total_tokens"),
      numberFrom(value, "repair_total_tokens"),
    ]),
  );

  return inputTokens === null || outputTokens === null || totalTokens === null
    ? null
    : { inputTokens, outputTokens, totalTokens };
}

function emptyStageMap(): Record<DashboardStage, DashboardStageMetrics | null> {
  return { stage1: null, stage2: null, stage3: null, stage4: null };
}

function rowsByDate(rows: CountRow[]): Map<string, CountRow> {
  return new Map(rows.map((row) => [row.date, row]));
}

function categoryCounts(rows: CategoryRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.category, count(row.count)]));
}

function count(value: number | string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? known.reduce((sum, value) => sum + value, 0) : null;
}

function numberFrom(value: JsonObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function durationBetween(startedAt: string, finishedAt: string | null): number | null {
  if (!finishedAt) {
    return null;
  }
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function parseRunName(runName: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(runName);
  return match
    ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
    : null;
}

function compareStartedAt(left: string | null, right: string | null): number {
  return Date.parse(left ?? "") - Date.parse(right ?? "");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
