/**
 * Dashboard 的服务端数据聚合层。
 *
 * 数据库指标以 workflow daily_date 为业务归属；runtime 仅补充运行观测数据，不作为业务数据来源。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { parseBriefDate } from "./brief-date.js";
import {
  getDailyBriefForDailyScope,
  type DailyBriefResponse,
} from "./daily-brief.js";
import {
  isDailyScopeCompleted,
  resolveDailyScope,
  resolveRecentCompletedDailyScopes,
  type DailyScope,
} from "./daily-scope.js";

const DASHBOARD_DAYS = 7;
const STAGES = ["stage1", "stage2", "stage3", "stage4"] as const;
const CONTENT_COMPLETION_SHORT_CHARS = Number(
  process.env.CONTENT_COMPLETION_SHORT_CHARS ?? 80,
);

type Routing = "event" | "digest" | "long_form" | "inspiration";
export type DashboardStage = (typeof STAGES)[number];

type CountRow = {
  date: string;
  total: number | string;
  pending?: number | string;
  selected?: number | string;
  ignored?: number | string;
  failed?: number | string;
  completion_backlog?: number | string;
  event?: number | string;
  digest?: number | string;
  long_form?: number | string;
  inspiration?: number | string;
  published?: number | string;
  draft?: number | string;
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

type PipelineRunRow = {
  daily_date: string;
  step: string;
  status: string;
  provider: string | null;
  model: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  metrics: unknown;
  error_summary: string | null;
};

type Stage4BusinessRow = {
  date: string;
  status: string | null;
  ready: number | string;
  draft: number | string;
  published: number | string;
};

export type DashboardStageMetrics = {
  stage: DashboardStage;
  status: string | null;
  startedAt: string | null;
  model: string | null;
  promptVersion: string | null;
  promptVersions: {
    event: string | null;
    digest: string | null;
    longForm: string | null;
  } | null;
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
  webSearchEventCount: number | null;
  totalWebSearchCalls: number | null;
  batchCount: number | null;
  fallbackBatchCount: number | null;
  splitCount: number | null;
  singletonBatchCount: number | null;
  readyCount: number | null;
  draftCount: number | null;
  publishedCount: number | null;
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

export type DashboardDuplicateFilterMetrics = {
  inputCount: number;
  duplicateCount: number;
  outputCount: number;
  duplicateRate: number;
  sameUrlCount: number;
  sameTitleCount: number;
  sameUrlAndTitleCount: number;
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
  events: { published: number; draft: number };
  completionBacklog: number;
  runtime: {
    contentCompletion: DashboardContentCompletionMetrics | null;
    duplicateFilter: DashboardDuplicateFilterMetrics | null;
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
  latestDailyDate: string;
  detailDate: string;
  totals: {
    rawArticles: number;
    processedContents: number;
    events: number;
  };
  days: DashboardDay[];
  details: {
    scopeCompleted: boolean;
    contentFunnel: DashboardContentFunnel | null;
    processedByCategory: Record<string, number>;
    digestByCategory: Record<string, number>;
    contentCompletion: DashboardContentCompletionMetrics | null;
    duplicateFilter: DashboardDuplicateFilterMetrics | null;
    stages: Record<DashboardStage, DashboardStageMetrics | null>;
  };
};

/**
 * 组装最近已完成 Daily 的总览和一个可选日期的详情。
 * 尚未结束的 scope 不查询详情业务数据，防止展示不完整期次。
 */
export async function getDashboardData(
  pool: Pool,
  options: { detailDate?: string | null; rootDir?: string; now?: Date } = {},
): Promise<DashboardData> {
  const now = options.now ?? new Date();
  const scopes = resolveRecentCompletedDailyScopes(DASHBOARD_DAYS, now);
  const latestScope = scopes[0];
  if (!latestScope) {
    throw new Error("Dashboard Daily scope range is empty.");
  }

  const requestedDate = parseBriefDate(options.detailDate ?? "")?.date;
  const detailScope = resolveDailyScope(requestedDate ?? latestScope.dailyDate);
  const detailScopeCompleted = isDailyScopeCompleted(detailScope, now);

  const scopeDates = scopes.map((scope) => scope.dailyDate);
  const scopeStarts = scopes.map((scope) => scope.startAt);
  const scopeEnds = scopes.map((scope) => scope.endAt);
  const requestedRuntimeDates = new Set([
    ...scopeDates,
    ...(detailScopeCompleted ? [detailScope.dailyDate] : []),
  ]);

  const processedCategoriesPromise: Promise<{ rows: CategoryRow[] }> =
    detailScopeCompleted
      ? pool.query<CategoryRow>(
          `
            select category, count(*)::int as count
            from processed_contents pc
            where pc.daily_date = $1::date
            group by category
            order by count desc, category asc
          `,
          [detailScope.dailyDate],
        )
      : Promise.resolve({ rows: [] });
  const digestCategoriesPromise: Promise<{ rows: CategoryRow[] }> =
    detailScopeCompleted
      ? pool.query<CategoryRow>(
          `
            select category, count(*)::int as count
            from processed_contents pc
            where pc.daily_date = $1::date
              and pc.routing = 'digest'
            group by category
            order by count desc, category asc
          `,
          [detailScope.dailyDate],
        )
      : Promise.resolve({ rows: [] });
  const contentFunnelPromise = detailScopeCompleted
    ? loadContentFunnel(pool, detailScope)
    : Promise.resolve(null);

  const [
    totalsResult,
    rawResult,
    processedResult,
    eventsResult,
    processedCategoriesResult,
    digestCategoriesResult,
    runtimeByDate,
    completionByDate,
    duplicateFilterByDate,
    contentFunnel,
    stage4BusinessResult,
    pipelineRunsResult,
  ] = await Promise.all([
    pool.query<TotalRow>(`
      select
        (select count(*)::int from raw_articles) as raw_articles,
        (select count(*)::int from processed_contents) as processed_contents,
        (select count(*)::int from events) as events
    `),
    pool.query<CountRow>(
      `
        with scopes as (
          select *
          from unnest(
            $1::text[],
            $2::timestamptz[],
            $3::timestamptz[]
          ) as scope(date, start_at, end_at)
        )
        select
          scope.date,
          count(ra.id)::int as total,
          count(ra.id) filter (
            where ra.stage1_status = 'pending'
          )::int as pending,
          count(ra.id) filter (
            where ra.stage1_status = 'selected'
          )::int as selected,
          count(ra.id) filter (
            where ra.stage1_status = 'ignored'
          )::int as ignored,
          count(ra.id) filter (
            where ra.stage1_status = 'failed'
          )::int as failed,
          count(ra.id) filter (
            where ra.stage1_status = 'pending'
              and ra.url is not null
              and length(btrim(coalesce(ra.content_text, ''))) < $4
          )::int as completion_backlog
        from scopes scope
        left join raw_articles ra
          on ra.published_at >= scope.start_at
          and ra.published_at < scope.end_at
        group by scope.date
      `,
      [
        scopeDates,
        scopeStarts,
        scopeEnds,
        CONTENT_COMPLETION_SHORT_CHARS,
      ],
    ),
    pool.query<CountRow>(
      `
        with scopes as (
          select unnest($1::text[]) as date
        )
        select
          scope.date,
          count(pc.id)::int as total,
          count(pc.id) filter (where pc.routing = 'event')::int as event,
          count(pc.id) filter (where pc.routing = 'digest')::int as digest,
          count(pc.id) filter (where pc.routing = 'long_form')::int as long_form,
          count(pc.id) filter (where pc.routing = 'inspiration')::int as inspiration
        from scopes scope
        left join processed_contents pc on pc.daily_date = scope.date::date
        group by scope.date
      `,
      [scopeDates],
    ),
    pool.query<CountRow>(
      `
        with scopes as (
          select unnest($1::text[]) as date
        )
        select
          scope.date,
          count(e.id) filter (where e.publication_status = 'published')::int as published,
          count(e.id) filter (where e.publication_status = 'draft')::int as draft
        from scopes scope
        left join stage4_runs s4r on s4r.daily_date = scope.date::date
        left join events e on e.stage4_run_id = s4r.id
        group by scope.date
      `,
      [scopeDates],
    ),
    processedCategoriesPromise,
    digestCategoriesPromise,
    loadRuntimeMetricsByDate(options.rootDir ?? process.cwd(), requestedRuntimeDates),
    loadContentCompletionRuntimeByDate(
      options.rootDir ?? process.cwd(),
      requestedRuntimeDates,
    ),
    loadDuplicateFilterRuntimeByDate(options.rootDir ?? process.cwd(), requestedRuntimeDates),
    contentFunnelPromise,
    pool.query<Stage4BusinessRow>(`
      with dates as (select unnest($1::text[]) as date),
      latest_runs as (
        select dates.date, s.id, s.status, s.success_count
        from dates left join lateral (
          select id, status, success_count from stage4_runs
          where daily_date = dates.date::date
          order by created_at desc, id desc limit 1
        ) s on true
      )
      select latest_runs.date, latest_runs.status,
        coalesce(latest_runs.success_count, 0)::int as ready,
        count(e.id) filter (where e.stage4_run_id = latest_runs.id and e.publication_status = 'draft')::int as draft,
        count(e.id) filter (where e.publication_status = 'published')::int as published
      from latest_runs
      left join stage4_runs all_runs on all_runs.daily_date = latest_runs.date::date
      left join events e on e.stage4_run_id = all_runs.id
      group by latest_runs.date, latest_runs.status, latest_runs.id, latest_runs.success_count
    `, [[...requestedRuntimeDates]]),
    loadPipelineRunsByDate(pool, requestedRuntimeDates),
  ]);

  const totals = totalsResult.rows[0];
  if (!totals) {
    throw new Error("Dashboard totals query returned no rows.");
  }

  const rawByDate = rowsByDate(rawResult.rows);
  const processedByDate = rowsByDate(processedResult.rows);
  const eventsByDate = rowsByDate(eventsResult.rows);
  const stage4BusinessByDate = new Map(stage4BusinessResult.rows.map((row) => [row.date, row]));
  const pipelineRunsByDate = groupPipelineRunsByDate(pipelineRunsResult);

  const days = scopes.map((scope) => {
    const raw = rawByDate.get(scope.dailyDate);
    const processed = processedByDate.get(scope.dailyDate);
    const event = eventsByDate.get(scope.dailyDate);
    const stages = emptyStageMap();
    const runtimeStages = runtimeByDate.get(scope.dailyDate);
    const pipelineRuns = pipelineRunsByDate.get(scope.dailyDate);

    for (const stage of STAGES) {
      stages[stage] = pipelineRuns?.get(stage) ? stageMetricsFromPipelineRun(stage, pipelineRuns.get(stage)!) : runtimeStages?.get(stage) ?? null;
    }
    stages.stage4 = mergeStage4BusinessMetrics(stages.stage4, stage4BusinessByDate.get(scope.dailyDate));

    const availableStages = Object.values(stages).filter(
      (metrics): metrics is DashboardStageMetrics => metrics !== null,
    );

    return {
      date: scope.dailyDate,
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
      events: { published: count(event?.published), draft: count(event?.draft) },
      completionBacklog: count(raw?.completion_backlog),
      runtime: {
        contentCompletion: pipelineRuns?.get("content_completion") ? completionMetricsFromPipelineRun(pipelineRuns.get("content_completion")!) : completionByDate.get(scope.dailyDate) ?? null,
        duplicateFilter: pipelineRuns?.get("exact_duplicate_filter") ? duplicateMetricsFromPipelineRun(pipelineRuns.get("exact_duplicate_filter")!) : duplicateFilterByDate.get(scope.dailyDate) ?? null,
        stages,
        llmCalls: sumRequired(STAGES.map((stage) => stages[stage]?.llmCalls ?? null)),
        inputTokens: sumKnown(availableStages.map((stage) => stage.inputTokens)),
        outputTokens: sumKnown(availableStages.map((stage) => stage.outputTokens)),
        totalTokens: sumKnown(availableStages.map((stage) => stage.totalTokens)),
        durationMs: sumKnown(availableStages.map((stage) => stage.durationMs)),
      },
    } satisfies DashboardDay;
  });

  const detailStages = emptyStageMap();
  const runtimeDetailStages = detailScopeCompleted
    ? runtimeByDate.get(detailScope.dailyDate)
    : undefined;
  const detailPipelineRuns = pipelineRunsByDate.get(detailScope.dailyDate);
  for (const stage of STAGES) {
    detailStages[stage] = detailPipelineRuns?.get(stage) ? stageMetricsFromPipelineRun(stage, detailPipelineRuns.get(stage)!) : runtimeDetailStages?.get(stage) ?? null;
  }
  detailStages.stage4 = mergeStage4BusinessMetrics(
    detailStages.stage4,
    stage4BusinessByDate.get(detailScope.dailyDate),
  );

  return {
    timezone: "Asia/Shanghai",
    latestDailyDate: latestScope.dailyDate,
    detailDate: detailScope.dailyDate,
    totals: {
      rawArticles: count(totals.raw_articles),
      processedContents: count(totals.processed_contents),
      events: count(totals.events),
    },
    days,
    details: {
      scopeCompleted: detailScopeCompleted,
      contentFunnel,
      processedByCategory: categoryCounts(processedCategoriesResult.rows),
      digestByCategory: categoryCounts(digestCategoriesResult.rows),
      contentCompletion: detailScopeCompleted
        ? detailPipelineRuns?.get("content_completion") ? completionMetricsFromPipelineRun(detailPipelineRuns.get("content_completion")!) : completionByDate.get(detailScope.dailyDate) ?? null
        : null,
      duplicateFilter: detailScopeCompleted
        ? detailPipelineRuns?.get("exact_duplicate_filter") ? duplicateMetricsFromPipelineRun(detailPipelineRuns.get("exact_duplicate_filter")!) : duplicateFilterByDate.get(detailScope.dailyDate) ?? null
        : null,
      stages: detailStages,
    },
  };
}

/**
 * 统计同一 raw scope 在采集、选择、摘要和最终 Brief 各环节的
 * 字符量 */
async function loadContentFunnel(
  pool: Pool,
  scope: DailyScope,
): Promise<DashboardContentFunnel> {
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
        where published_at >= $1::timestamptz
          and published_at < $2::timestamptz
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
        where ra.published_at >= $1::timestamptz
          and ra.published_at < $2::timestamptz
      `,
      [scope.startAt, scope.endAt],
    ),
    getDailyBriefForDailyScope(pool, scope),
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

function toIsoString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * 读取每个日期最新一次 Content Completion runtime；
 * 缺失 artifact 时返回空映射。
 */
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
        const date = dailyDateForRuntime(artifact, startedAt);
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

function mergeStage4BusinessMetrics(
  runtime: DashboardStageMetrics | null,
  business: Stage4BusinessRow | undefined,
): DashboardStageMetrics | null {
  if (!runtime && !business) return null;
  const base = runtime ?? emptyStageMetrics("stage4");
  return {
    ...base,
    status: business?.status ?? base.status,
    readyCount: business ? count(business.ready) : base.readyCount,
    draftCount: business ? count(business.draft) : base.draftCount,
    publishedCount: business ? count(business.published) : base.publishedCount,
  };
}

function groupPipelineRunsByDate(rows: PipelineRunRow[]): Map<string, Map<string, PipelineRunRow>> {
  const result = new Map<string, Map<string, PipelineRunRow>>();
  for (const row of rows) {
    const steps = result.get(row.daily_date) ?? new Map<string, PipelineRunRow>();
    steps.set(row.step, row);
    result.set(row.daily_date, steps);
  }
  return result;
}

/** The deployed schema may predate pipeline_runs; runtime remains the explicit compatibility path. */
async function loadPipelineRunsByDate(pool: Pool, dates: Set<string>): Promise<PipelineRunRow[]> {
  try {
    const result = await pool.query<PipelineRunRow>(`
      select distinct on (daily_date, step)
        daily_date::text, step, status, provider, model, started_at, finished_at, metrics, error_summary
      from pipeline_runs
      where daily_date = any($1::date[])
        and step = any($2::text[])
      order by daily_date, step, started_at desc, id desc
    `, [[...dates], ["content_completion", "exact_duplicate_filter", ...STAGES]]);
    return result.rows;
  } catch (error) {
    if (isMissingTable(error, "pipeline_runs")) return [];
    throw error;
  }
}

function isMissingTable(error: unknown, table: string): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code
      : undefined;
  return code === "42P01" ||
    (error instanceof Error && error.message.includes(`relation \"${table}\" does not exist`));
}

function stageMetricsFromPipelineRun(stage: DashboardStage, row: PipelineRunRow): DashboardStageMetrics {
  const metrics = asObject(row.metrics) ?? {};
  const startedAt = toIsoString(row.started_at)!;
  const finishedAt = toIsoString(row.finished_at);
  const selectedEventCount = numberFrom(metrics, "selected_count", "event_selected_count");
  return {
    ...emptyStageMetrics(stage), stage, status: row.status, startedAt, model: row.model,
    durationMs: numberFrom(metrics, "duration_ms") ?? durationBetween(startedAt, finishedAt),
    llmDurationMs: numberFrom(metrics, "llm_duration_ms"),
    llmCalls: numberFrom(metrics, "llm_calls"), retryCount: numberFrom(metrics, "retry_count"),
    inputTokens: numberFrom(metrics, "input_tokens"), outputTokens: numberFrom(metrics, "output_tokens"),
    totalTokens: numberFrom(metrics, "total_tokens"), candidateCount: numberFrom(metrics, "candidate_count"),
    groupCount: numberFrom(metrics, "group_count", "event_group_count"), selectedEventCount,
    digestBeforeDedup: numberFrom(metrics, "digest_before_dedup"), digestAfterDedup: numberFrom(metrics, "digest_after_dedup"),
    longFormCount: numberFrom(metrics, "long_form_count"), enrichmentSuccessCount: numberFrom(metrics, "ready_count"),
    enrichmentFailureCount: numberFrom(metrics, "failed_count"), eventsCreated: numberFrom(metrics, "published_count"),
    webSearchEventCount: numberFrom(metrics, "web_search_event_count"), totalWebSearchCalls: numberFrom(metrics, "total_web_search_calls"),
    batchCount: numberFrom(metrics, "batch_count"), fallbackBatchCount: numberFrom(metrics, "fallback_batch_count"),
    splitCount: numberFrom(metrics, "split_count"), singletonBatchCount: numberFrom(metrics, "singleton_batch_count"),
    readyCount: numberFrom(metrics, "ready_count"), draftCount: numberFrom(metrics, "draft_count"), publishedCount: numberFrom(metrics, "published_count"),
  };
}

function completionMetricsFromPipelineRun(row: PipelineRunRow): DashboardContentCompletionMetrics {
  const metrics = asObject(row.metrics) ?? {};
  const startedAt = toIsoString(row.started_at)!;
  return {
    status: row.status, startedAt,
    durationMs: numberFrom(metrics, "duration_ms") ?? durationBetween(startedAt, toIsoString(row.finished_at)),
    candidateCount: numberFrom(metrics, "candidate_count"), selectedCount: numberFrom(metrics, "selected_count"),
    successCount: numberFrom(metrics, "success_count"), failedCount: numberFrom(metrics, "failed_count"),
    skippedCount: numberFrom(metrics, "skipped_count"), remainingCount: numberFrom(metrics, "remaining_count"),
    limit: numberFrom(metrics, "limit"), perSourceLimit: numberFrom(metrics, "per_source_limit"),
  };
}

function duplicateMetricsFromPipelineRun(row: PipelineRunRow): DashboardDuplicateFilterMetrics {
  const metrics = asObject(row.metrics) ?? {};
  return {
    inputCount: numberFrom(metrics, "input_count") ?? 0, duplicateCount: numberFrom(metrics, "duplicate_count") ?? 0,
    outputCount: numberFrom(metrics, "output_count") ?? 0, duplicateRate: numberFrom(metrics, "duplicate_rate") ?? 0,
    sameUrlCount: numberFrom(metrics, "same_url_count") ?? 0, sameTitleCount: numberFrom(metrics, "same_title_count") ?? 0,
    sameUrlAndTitleCount: numberFrom(metrics, "same_url_and_title_count") ?? 0,
  };
}

/** Daily run 记录 duplicate-filter runtime path；Dashboard 直接读取该 artifact，不查询业务表估算。 */
export async function loadDuplicateFilterRuntimeByDate(
  rootDir: string,
  requestedDates: Set<string>,
): Promise<Map<string, DashboardDuplicateFilterMetrics>> {
  const dailyDir = join(rootDir, "runtime", "daily");
  let names: string[];
  try { names = await readdir(dailyDir); } catch (error) {
    if (isMissingFile(error)) return new Map();
    throw error;
  }
  const metrics = new Map<string, DashboardDuplicateFilterMetrics>();
  for (const name of names) {
    try {
      const daily = asObject(JSON.parse(await readFile(join(dailyDir, name, "run.json"), "utf8")));
      const date = daily && stringValue(daily.daily_date);
      const artifactPath = daily && stringValue(daily.duplicate_filter_run);
      if (!date || !artifactPath || !requestedDates.has(date)) continue;
      const artifact = asObject(JSON.parse(await readFile(join(artifactPath, "run.json"), "utf8")));
      if (!artifact) continue;
      metrics.set(date, {
        inputCount: numberFrom(artifact, "inputCount") ?? 0,
        duplicateCount: numberFrom(artifact, "duplicateCount") ?? 0,
        outputCount: numberFrom(artifact, "outputCount") ?? 0,
        duplicateRate: numberFrom(artifact, "duplicateRate") ?? 0,
        sameUrlCount: numberFrom(artifact, "sameUrlCount") ?? 0,
        sameTitleCount: numberFrom(artifact, "sameTitleCount") ?? 0,
        sameUrlAndTitleCount: numberFrom(artifact, "sameUrlAndTitleCount") ?? 0,
      });
    } catch (error) {
      if (!isMissingFile(error)) console.error("Failed to read dashboard duplicate filter runtime artifact.", error);
    }
  }
  return metrics;
}

/**
 * 汇总各 Stage 的最新 runtime artifact。
 * runtime 中记录 daily_date 时优先使用它，兼容旧 artifact 才按启动时间回推。
 */
export async function loadRuntimeMetricsByDate(
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
          // Artifact names come from the runtime directory at request time. Avoid passing this
          // dynamic segment to path.join so Turbopack does not trace runtime/** during build.
          const runDir = `${stageDir}/${runName}`;
          try {
            const artifact = asObject(
              JSON.parse(await readFile(join(runDir, "run.json"), "utf8")),
            );
            if (!artifact) {
              throw new Error("run.json must contain a JSON object.");
            }

            const normalizedArtifact = await normalizeRuntimeArtifact(stage, runDir, artifact);
            const startedAt = stringValue(normalizedArtifact.started_at) ?? parseRunName(runName);
            if (!startedAt) {
              throw new Error("run.json has no valid started_at timestamp.");
            }

            const date = dailyDateForRuntime(normalizedArtifact, startedAt);
            if (!requestedDates.has(date)) {
              return null;
            }

            return {
              date,
              metrics: await parseStageMetrics(stage, runDir, normalizedArtifact, startedAt),
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

/** Normalize the two real historical runtime contracts once, before generic metric parsing. */
async function normalizeRuntimeArtifact(
  stage: DashboardStage,
  runDir: string,
  artifact: JsonObject,
): Promise<JsonObject> {
  if (stage === "stage1") {
    try {
      const summary = asObject(JSON.parse(await readFile(join(runDir, "summary.json"), "utf8")));
      if (!summary) return artifact;
      const tokenUsage = asObject(summary.tokenUsage);
      return {
        ...artifact,
        model: artifact.model ?? summary.model,
        total_duration_ms: artifact.total_duration_ms ?? artifact.duration_ms ?? summary.durationMs,
        candidate_count: artifact.candidate_count ?? summary.loadedCount,
        batch_count: artifact.batch_count ?? summary.batchCount,
        fallback_batch_count: artifact.fallback_batch_count ?? summary.fallbackBatchCount,
        split_count: artifact.split_count ?? summary.splitCount,
        singleton_batch_count: artifact.singleton_batch_count ?? summary.singletonBatchCount,
        llm_call_count: artifact.llm_call_count ?? summary.llmCallCount ?? summary.llmRequestCount,
        retry_count: artifact.retry_count ?? summary.retryCount,
        llm_duration_ms: artifact.llm_duration_ms ?? summary.llmDurationMs,
        input_tokens: artifact.input_tokens ?? tokenUsage?.inputTokens,
        output_tokens: artifact.output_tokens ?? tokenUsage?.outputTokens,
        total_tokens: artifact.total_tokens ?? tokenUsage?.totalTokens,
      };
    } catch (error) {
      if (!isMissingFile(error)) console.error(`Failed to read Stage1 summary artifact ${runDir}.`, error);
      return artifact;
    }
  }

  if (stage === "stage4") {
    return {
      ...artifact,
      daily_date: artifact.daily_date ?? artifact.dailyDate,
      started_at: artifact.started_at ?? artifact.startedAt,
      finished_at: artifact.finished_at ?? artifact.finishedAt,
      stage4_run_id: artifact.stage4_run_id ?? artifact.stage4RunId,
      selected_event_count: artifact.selected_event_count ?? artifact.selectedEventCount,
      enrichment_success_count: artifact.enrichment_success_count ?? artifact.enrichmentSuccessCount,
      enrichment_failure_count: artifact.enrichment_failure_count ?? artifact.enrichmentFailureCount,
      retry_count: artifact.retry_count ?? artifact.retryCount,
      llm_duration_ms: artifact.llm_duration_ms ?? artifact.llmDurationMs,
      web_search_event_count: artifact.web_search_event_count ?? artifact.webSearchEventCount,
      total_web_search_calls: artifact.total_web_search_calls ?? artifact.totalWebSearchCalls,
      events_created: artifact.events_created ?? artifact.eventsCreated,
    };
  }
  return artifact;
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
        const date = dailyDateForRuntime(artifact, startedAt);
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

function dailyDateForRuntime(artifact: JsonObject, startedAt: string): string {
  const recordedDailyDate = stringValue(artifact.daily_date) ?? stringValue(artifact.dailyDate);
  if (recordedDailyDate && parseBriefDate(recordedDailyDate)) {
    return recordedDailyDate;
  }
  return resolveDailyScope(undefined, new Date(startedAt)).dailyDate;
}

function stage1MetricsFromDailyStep(
  step: JsonObject,
  startedAt: string,
): DashboardStageMetrics {
  return {
    stage: "stage1",
    status: stringValue(step.status),
    startedAt,
    model: stringValue(step.model),
    promptVersion: stringValue(step.prompt_version),
    promptVersions: null,
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
    webSearchEventCount: null,
    totalWebSearchCalls: null,
    batchCount: null,
    fallbackBatchCount: null,
    splitCount: null,
    singletonBatchCount: null,
    readyCount: null,
    draftCount: null,
    publishedCount: null,
  };
}

function emptyStageMetrics(stage: DashboardStage): DashboardStageMetrics {
  return {
    stage, status: null, startedAt: null, model: null, promptVersion: null, promptVersions: null,
    durationMs: null, llmDurationMs: null, llmCalls: null, retryCount: null,
    inputTokens: null, outputTokens: null, totalTokens: null, candidateCount: null,
    groupCount: null, selectedEventCount: null, digestBeforeDedup: null,
    digestAfterDedup: null, longFormCount: null, enrichmentSuccessCount: null,
    enrichmentFailureCount: null, eventsCreated: null, webSearchEventCount: null,
    totalWebSearchCalls: null, batchCount: null, fallbackBatchCount: null, splitCount: null,
    singletonBatchCount: null, readyCount: null, draftCount: null, publishedCount: null,
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
  const stage3PromptVersions = asObject(artifact.prompt_versions);

  return {
    stage,
    status: stringValue(artifact.status),
    startedAt,
    model: stringValue(artifact.model),
    promptVersion: stringValue(artifact.prompt_version),
    promptVersions:
      stage === "stage3"
        ? {
            event: stringValue(stage3PromptVersions?.event),
            digest: stringValue(stage3PromptVersions?.digest),
            longForm: stringValue(stage3PromptVersions?.long_form),
          }
        : null,
    durationMs:
      numberFrom(artifact, "total_duration_ms", "duration_ms") ??
      durationBetween(startedAt, finishedAt),
    llmDurationMs: numberFrom(artifact, "llm_duration_ms"),
    // Older Stage 4 artifacts used llm_calls / llmCalls for completed enrichments,
    // not provider requests. The current llm_call_count includes the context
    // decision and every enrichment attempt, including retries.
    llmCalls:
      stage === "stage4"
        ? numberFrom(artifact, "llm_call_count")
        : numberFrom(artifact, "llm_calls", "llm_call_count"),
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
      numberFrom(artifact, "enrichment_failure_count"),
    eventsCreated: numberFrom(artifact, "events_created"),
    webSearchEventCount: numberFrom(artifact, "web_search_event_count"),
    totalWebSearchCalls: numberFrom(artifact, "total_web_search_calls"),
    batchCount: numberFrom(artifact, "batch_count"),
    fallbackBatchCount: numberFrom(artifact, "fallback_batch_count"),
    splitCount: numberFrom(artifact, "split_count"),
    singletonBatchCount: numberFrom(artifact, "singleton_batch_count"),
    readyCount: enrichmentSuccessCount,
    draftCount: null,
    publishedCount: null,
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

/** A Daily LLM total is meaningful only when every Stage reports actual provider requests. */
function sumRequired(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === values.length ? known.reduce((sum, value) => sum + value, 0) : null;
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
