/**
 * Dashboard 的服务端数据聚合层。
 *
 * 数据库指标按 Daily raw input scope 归属；runtime 仅补充运行观测数据，不作为业务数据来源。
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
            join raw_articles ra on ra.id = pc.raw_article_id
            where ra.published_at >= $1::timestamptz
              and ra.published_at < $2::timestamptz
            group by category
            order by count desc, category asc
          `,
          [detailScope.startAt, detailScope.endAt],
        )
      : Promise.resolve({ rows: [] });
  const digestCategoriesPromise: Promise<{ rows: CategoryRow[] }> =
    detailScopeCompleted
      ? pool.query<CategoryRow>(
          `
            select category, count(*)::int as count
            from processed_contents pc
            join raw_articles ra on ra.id = pc.raw_article_id
            where ra.published_at >= $1::timestamptz
              and ra.published_at < $2::timestamptz
              and pc.routing = 'digest'
            group by category
            order by count desc, category asc
          `,
          [detailScope.startAt, detailScope.endAt],
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
          count(ra.id) filter (where ra.stage1_status = 'pending')::int as pending,
          count(ra.id) filter (where ra.stage1_status = 'selected')::int as selected,
          count(ra.id) filter (where ra.stage1_status = 'ignored')::int as ignored,
          count(ra.id) filter (where ra.stage1_status = 'failed')::int as failed
        from scopes scope
        left join raw_articles ra
          on ra.published_at >= scope.start_at
          and ra.published_at < scope.end_at
        group by scope.date
      `,
      [scopeDates, scopeStarts, scopeEnds],
    ),
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
          count(pc.id)::int as total,
          count(pc.id) filter (where pc.routing = 'event')::int as event,
          count(pc.id) filter (where pc.routing = 'digest')::int as digest,
          count(pc.id) filter (where pc.routing = 'long_form')::int as long_form,
          count(pc.id) filter (where pc.routing = 'inspiration')::int as inspiration
        from scopes scope
        left join raw_articles ra
          on ra.published_at >= scope.start_at
          and ra.published_at < scope.end_at
        left join processed_contents pc on pc.raw_article_id = ra.id
        group by scope.date
      `,
      [scopeDates, scopeStarts, scopeEnds],
    ),
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
          count(distinct e.id)::int as total
        from scopes scope
        left join raw_articles ra
          on ra.published_at >= scope.start_at
          and ra.published_at < scope.end_at
        left join processed_contents pc
          on pc.raw_article_id = ra.id
          and pc.event_id is not null
          and pc.routing = 'event'
        left join events e on e.id = pc.event_id
        group by scope.date
      `,
      [scopeDates, scopeStarts, scopeEnds],
    ),
    processedCategoriesPromise,
    digestCategoriesPromise,
    loadRuntimeMetricsByDate(options.rootDir ?? process.cwd(), requestedRuntimeDates),
    loadContentCompletionRuntimeByDate(
      options.rootDir ?? process.cwd(),
      requestedRuntimeDates,
    ),
    contentFunnelPromise,
  ]);

  const totals = totalsResult.rows[0];
  if (!totals) {
    throw new Error("Dashboard totals query returned no rows.");
  }

  const rawByDate = rowsByDate(rawResult.rows);
  const processedByDate = rowsByDate(processedResult.rows);
  const eventsByDate = rowsByDate(eventsResult.rows);

  const days = scopes.map((scope) => {
    const raw = rawByDate.get(scope.dailyDate);
    const processed = processedByDate.get(scope.dailyDate);
    const event = eventsByDate.get(scope.dailyDate);
    const stages = emptyStageMap();
    const runtimeStages = runtimeByDate.get(scope.dailyDate);

    for (const stage of STAGES) {
      stages[stage] = runtimeStages?.get(stage) ?? null;
    }

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
      events: count(event?.total),
      runtime: {
        contentCompletion: completionByDate.get(scope.dailyDate) ?? null,
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
  const runtimeDetailStages = detailScopeCompleted
    ? runtimeByDate.get(detailScope.dailyDate)
    : undefined;
  for (const stage of STAGES) {
    detailStages[stage] = runtimeDetailStages?.get(stage) ?? null;
  }

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
        ? completionByDate.get(detailScope.dailyDate) ?? null
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

            const date = dailyDateForRuntime(artifact, startedAt);
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
  const recordedDailyDate = stringValue(artifact.daily_date);
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
    webSearchEventCount: numberFrom(artifact, "web_search_event_count"),
    totalWebSearchCalls: numberFrom(artifact, "total_web_search_calls"),
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
