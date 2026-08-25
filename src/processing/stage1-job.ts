/**
 * Stage 1 Workflow job：加载可重试原始文章、分批调用模型并写入处理结果。
 * 通过 raw_articles 状态与 processed_contents 的唯一约束保证重复运行安全。
 */
import type { Pool, PoolClient, QueryResult } from "pg";
import {
  runStage1BatchLlm,
  type Stage1LlmOptions,
  type Stage1TokenUsage,
} from "./stage1-llm.js";
import type {
  Stage1ArticleRow,
  Stage1BatchOutputResult,
  Stage1Output,
  Stage1Routing,
} from "./stage1-contract.js";
import { resolveStageLlmModel } from "./llm-client.js";
import type { PublishedAtScope } from "../lib/daily-scope.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage1JobOptions = Stage1LlmOptions & {
  limit?: number;
  concurrency?: number;
  publishedWithinHours?: number;
  publishedAtScope?: PublishedAtScope;
  batchSize?: number;
  batchMaxContentChars?: number;
  batchMaxTotalChars?: number;
};

export type Stage1JobArticleResult = {
  rawArticleId: string;
  sourceName: string;
  title: string;
  status: "selected" | "ignored" | "failed";
  routing: Stage1Routing | null;
  processedContentInserted: boolean;
  attempts: number;
  error: string | null;
};

export type Stage1JobSummary = {
  startedAt: string;
  finishedAt: string;
  model: string;
  publishedWithinHours: number | null;
  scopeStartAt: string | null;
  scopeEndAt: string | null;
  requestedLimit: number | null;
  loadedCount: number;
  selectedCount: number;
  ignoredCount: number;
  failedCount: number;
  processedContentInsertedCount: number;
  batchCount: number;
  fallbackBatchCount: number;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  tokenUsage: Stage1TokenUsage | null;
  results: Stage1JobArticleResult[];
};

export type Stage1BatchConfig = {
  batchSize: number;
  batchMaxContentChars: number;
  batchMaxTotalChars: number;
};

type Stage1MicroBatchResult = {
  results: Stage1JobArticleResult[];
  fallbackUsed: boolean;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  tokenUsage: Stage1TokenUsage | null;
};

const DEFAULT_STAGE1_CONCURRENCY = 3;
const DEFAULT_STAGE1_LOOKBACK_HOURS = 24;
export const DEFAULT_STAGE1_BATCH_SIZE = 8;
export const DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS = 12_000;
export const DEFAULT_STAGE1_BATCH_MAX_TOTAL_CHARS = 40_000;

/** 执行一次 Stage 1，支持默认滑动窗口或 Daily 传入的固定 published_at scope。 */
export async function processStage1Batch(
  pool: Pool,
  options: Stage1JobOptions = {},
): Promise<Stage1JobSummary> {
  const startedAt = new Date();
  const publishedWithinHours = options.publishedWithinHours ?? DEFAULT_STAGE1_LOOKBACK_HOURS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_STAGE1_CONCURRENCY);
  const batchConfig = resolveStage1BatchConfig(options);
  const articles = await loadPendingStage1Articles(pool, {
    limit: options.limit,
    publishedWithinHours,
    publishedAtScope: options.publishedAtScope,
  });
  const batches = createStage1MicroBatches(articles, batchConfig);

  const batchResults = await runWithConcurrency(batches, concurrency, async (batch) =>
    processStage1MicroBatch(pool, batch, options),
  );
  const results = batchResults.flatMap((result) => result.results);
  const tokenUsage = sumTokenUsage(batchResults.map((result) => result.tokenUsage));

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    model: resolveStageLlmModel("stage1", options.model),
    publishedWithinHours: options.publishedAtScope ? null : publishedWithinHours,
    scopeStartAt: options.publishedAtScope?.startAt ?? null,
    scopeEndAt: options.publishedAtScope?.endAt ?? null,
    requestedLimit: options.limit ?? null,
    loadedCount: articles.length,
    selectedCount: results.filter((result) => result.status === "selected").length,
    ignoredCount: results.filter((result) => result.status === "ignored").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    processedContentInsertedCount: results.filter((result) => result.processedContentInserted)
      .length,
    batchCount: batches.length,
    fallbackBatchCount: batchResults.filter((result) => result.fallbackUsed).length,
    llmCallCount: batchResults.reduce((sum, result) => sum + result.llmCallCount, 0),
    retryCount: batchResults.reduce((sum, result) => sum + result.retryCount, 0),
    llmDurationMs: batchResults.reduce((sum, result) => sum + result.llmDurationMs, 0),
    tokenUsage,
    results,
  };
}

export function resolveStage1BatchConfig(
  options: Pick<
    Stage1JobOptions,
    "batchSize" | "batchMaxContentChars" | "batchMaxTotalChars"
  > = {},
): Stage1BatchConfig {
  return {
    batchSize:
      options.batchSize ??
      readPositiveInteger(
        process.env.STAGE1_BATCH_SIZE,
        DEFAULT_STAGE1_BATCH_SIZE,
        "STAGE1_BATCH_SIZE",
      ),
    batchMaxContentChars:
      options.batchMaxContentChars ??
      readPositiveInteger(
        process.env.STAGE1_BATCH_MAX_CONTENT_CHARS,
        DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS,
        "STAGE1_BATCH_MAX_CONTENT_CHARS",
      ),
    batchMaxTotalChars:
      options.batchMaxTotalChars ??
      readPositiveInteger(
        process.env.STAGE1_BATCH_MAX_TOTAL_CHARS,
        DEFAULT_STAGE1_BATCH_MAX_TOTAL_CHARS,
        "STAGE1_BATCH_MAX_TOTAL_CHARS",
      ),
  };
}

/**
 * 依据文章正文大小拆分 micro-batch。
 * 长文独立处理，避免它挤占普通文章的上下文预算并影响批次稳定性。
 */
export function createStage1MicroBatches(
  articles: Stage1ArticleRow[],
  config: Stage1BatchConfig,
): Stage1ArticleRow[][] {
  const batches: Stage1ArticleRow[][] = [];
  let currentBatch: Stage1ArticleRow[] = [];
  let currentContentChars = 0;

  const flushCurrentBatch = () => {
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
      currentBatch = [];
      currentContentChars = 0;
    }
  };

  for (const article of articles) {
    const contentChars = stage1ArticleContentLength(article);
    const shouldProcessAlone =
      contentChars >= config.batchMaxContentChars || article.sourceCategory === "Long-form";

    if (shouldProcessAlone) {
      flushCurrentBatch();
      batches.push([article]);
      continue;
    }

    const wouldExceedCount = currentBatch.length >= config.batchSize;
    const wouldExceedTotal =
      currentBatch.length > 0 &&
      currentContentChars + contentChars > config.batchMaxTotalChars;
    if (wouldExceedCount || wouldExceedTotal) {
      flushCurrentBatch();
    }

    if (contentChars > config.batchMaxTotalChars) {
      batches.push([article]);
      continue;
    }

    currentBatch.push(article);
    currentContentChars += contentChars;
  }

  flushCurrentBatch();
  return batches;
}

export function stage1ArticleContentLength(article: Stage1ArticleRow): number {
  return article.contentText?.trim().length ?? 0;
}

/** 读取 pending 与 failed 文章；selected/ignored 是终态，不会在重跑中重新处理。 */
export async function loadPendingStage1Articles(
  queryable: Queryable,
  options: {
    limit?: number;
    publishedWithinHours?: number;
    publishedAtScope?: PublishedAtScope;
  } = {},
): Promise<Stage1ArticleRow[]> {
  const publishedWithinHours = options.publishedWithinHours ?? DEFAULT_STAGE1_LOOKBACK_HOURS;
  const publishedAtPredicate = options.publishedAtScope
    ? "ra.published_at >= $1::timestamptz and ra.published_at < $2::timestamptz"
    : "ra.published_at >= now() - ($1::int * interval '1 hour')";
  const limitParameter = options.publishedAtScope ? 3 : 2;
  const limitClause = options.limit ? `limit $${limitParameter}` : "";
  const values: Array<number | string> = options.publishedAtScope
    ? [options.publishedAtScope.startAt, options.publishedAtScope.endAt]
    : [publishedWithinHours];
  if (options.limit) {
    values.push(options.limit);
  }

  const result = await queryable.query<Stage1ArticleQueryRow>(
    `
      select
        ra.id,
        ra.title,
        ra.url,
        ra.author,
        ra.content_text as "contentText",
        ra.published_at as "publishedAt",
        ra.source_tags as "sourceTags",
        s.name as "sourceName",
        s.category as "sourceCategory",
        s.source_type as "sourceType",
        s.priority as "sourcePriority",
        s.event_candidate as "eventCandidate",
        s.source_digest_candidate as "sourceDigestCandidate",
        s.availability as "sourceAvailability",
        s.language as "sourceLanguage"
      from raw_articles ra
      join sources s on s.id = ra.source_id
      where ra.stage1_status in ('pending', 'failed')
        and ${publishedAtPredicate}
      order by
        case when s.priority = 'High' then 0 when s.priority = 'Medium' then 1 else 2 end,
        ra.published_at desc,
        ra.id
      ${limitClause}
    `,
    values,
  );

  return result.rows;
}

async function processStage1MicroBatch(
  pool: Pool,
  articles: Stage1ArticleRow[],
  options: Stage1LlmOptions = {},
): Promise<Stage1MicroBatchResult> {
  const llmResult = await runStage1BatchLlm(articles, options);
  const metrics = createBatchMetrics(llmResult);

  if (llmResult.success) {
    return {
      ...metrics,
      fallbackUsed: false,
      results: await persistSuccessfulBatch(pool, articles, llmResult.output.results, {
        attempts: llmResult.attempts,
      }),
    };
  }

  if (articles.length === 1) {
    return {
      ...metrics,
      fallbackUsed: false,
      results: [
        await persistFailedArticle(pool, articles[0], llmResult.error, llmResult.attempts),
      ],
    };
  }

  const results: Stage1JobArticleResult[] = [];
  let fallbackMetrics = metrics;
  for (const article of articles) {
    const singleResult = await runStage1BatchLlm([article], options);
    fallbackMetrics = mergeBatchMetrics(fallbackMetrics, createBatchMetrics(singleResult));

    if (!singleResult.success) {
      results.push(
        await persistFailedArticle(
          pool,
          article,
          singleResult.error,
          llmResult.attempts + singleResult.attempts,
        ),
      );
      continue;
    }

    results.push(
      ...(await persistSuccessfulBatch(pool, [article], singleResult.output.results, {
        attempts: llmResult.attempts + singleResult.attempts,
      })),
    );
  }

  return {
    ...fallbackMetrics,
    fallbackUsed: true,
    results,
  };
}

async function persistSuccessfulBatch(
  pool: Pool,
  articles: Stage1ArticleRow[],
  outputResults: Stage1BatchOutputResult[],
  options: { attempts: number },
): Promise<Stage1JobArticleResult[]> {
  const outputByTempId = new Map(outputResults.map((result) => [result.temp_id, result]));

  return Promise.all(
    articles.map((article, index) => {
      const tempId = `A${String(index + 1).padStart(3, "0")}`;
      const outputResult = outputByTempId.get(tempId);
      if (!outputResult) {
        throw new Error(`Validated Stage 1 output is missing ${tempId}.`);
      }

      return persistStage1Output(pool, article, toStage1Output(outputResult), options.attempts);
    }),
  );
}

async function persistFailedArticle(
  pool: Pool,
  article: Stage1ArticleRow,
  error: string,
  attempts: number,
): Promise<Stage1JobArticleResult> {
  await persistStage1Failure(pool, article.id, error);
  return {
    rawArticleId: article.id,
    sourceName: article.sourceName,
    title: article.title,
    status: "failed",
    routing: null,
    processedContentInserted: false,
    attempts,
    error,
  };
}

async function persistStage1Output(
  pool: Pool,
  article: Stage1ArticleRow,
  output: Stage1Output,
  attempts: number,
): Promise<Stage1JobArticleResult> {
  try {
    if (output.routing === "Ignore") {
      await persistStage1Ignored(pool, article.id);
      return {
        rawArticleId: article.id,
        sourceName: article.sourceName,
        title: article.title,
        status: "ignored",
        routing: output.routing,
        processedContentInserted: false,
        attempts,
        error: null,
      };
    }

    const processedContentInserted = await persistStage1Selected(pool, article.id, output);
    return {
      rawArticleId: article.id,
      sourceName: article.sourceName,
      title: article.title,
      status: "selected",
      routing: output.routing,
      processedContentInserted,
      attempts,
      error: null,
    };
  } catch (error) {
    const errorMessage = sanitizeProcessingError(error);
    await persistStage1Failure(pool, article.id, errorMessage);
    return {
      rawArticleId: article.id,
      sourceName: article.sourceName,
      title: article.title,
      status: "failed",
      routing: output.routing,
      processedContentInserted: false,
      attempts,
      error: errorMessage,
    };
  }
}

function toStage1Output(result: Stage1BatchOutputResult): Stage1Output {
  return {
    category: result.category,
    tags: result.tags,
    entities: result.entities,
    entities_zh: result.entities_zh,
    routing: result.routing,
    generated_content: result.generated_content,
  };
}

function createBatchMetrics(result: {
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage1TokenUsage | null;
}): Omit<Stage1MicroBatchResult, "results" | "fallbackUsed"> {
  return {
    llmCallCount: result.attempts,
    retryCount: Math.max(0, result.attempts - 1),
    llmDurationMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
  };
}

function mergeBatchMetrics(
  left: Omit<Stage1MicroBatchResult, "results" | "fallbackUsed">,
  right: Omit<Stage1MicroBatchResult, "results" | "fallbackUsed">,
): Omit<Stage1MicroBatchResult, "results" | "fallbackUsed"> {
  return {
    llmCallCount: left.llmCallCount + right.llmCallCount,
    retryCount: left.retryCount + right.retryCount,
    llmDurationMs: left.llmDurationMs + right.llmDurationMs,
    tokenUsage: sumTokenUsage([left.tokenUsage, right.tokenUsage]),
  };
}

function sumTokenUsage(usages: Array<Stage1TokenUsage | null>): Stage1TokenUsage | null {
  const available = usages.filter((usage): usage is Stage1TokenUsage => usage !== null);
  if (available.length === 0) {
    return null;
  }

  return available.reduce(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}".`);
  }

  return parsed;
}

/**
 * 原子语义上先以唯一 raw_article_id 尝试插入结果，再更新 Stage 1 状态。
 * conflict do nothing 使已持久化文章在重跑时不会产生重复 processed_contents。
 */
export async function persistStage1Selected(
  queryable: Queryable,
  rawArticleId: string,
  output: Stage1Output,
): Promise<boolean> {
  const result = await queryable.query<{ id: string }>(
    `
      insert into processed_contents (
        raw_article_id,
        routing,
        category,
        tags,
        entities,
        entities_zh,
        title_zh,
        summary,
        summary_zh,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
      on conflict (raw_article_id) do nothing
      returning id
    `,
    [
      rawArticleId,
      toDatabaseRouting(output.routing),
      output.category,
      output.tags,
      output.entities,
      output.entities_zh,
      output.generated_content.title_zh,
      output.generated_content.summary,
      output.generated_content.summary_zh,
    ],
  );

  await markRawArticleStage1Status(queryable, rawArticleId, "selected", null);
  return result.rowCount === 1;
}

export async function persistStage1Ignored(
  queryable: Queryable,
  rawArticleId: string,
): Promise<QueryResult> {
  return markRawArticleStage1Status(queryable, rawArticleId, "ignored", null);
}

export async function persistStage1Failure(
  queryable: Queryable,
  rawArticleId: string,
  error: string,
): Promise<QueryResult> {
  return markRawArticleStage1Status(queryable, rawArticleId, "failed", truncateError(error));
}

function markRawArticleStage1Status(
  queryable: Queryable,
  rawArticleId: string,
  status: "selected" | "ignored" | "failed",
  processingError: string | null,
): Promise<QueryResult> {
  return queryable.query(
    `
      update raw_articles
      set
        stage1_status = $2,
        stage1_processed_at = now(),
        processing_error = $3
      where id = $1
    `,
    [rawArticleId, status, processingError],
  );
}

function toDatabaseRouting(routing: Stage1Routing): string {
  switch (routing) {
    case "Event":
      return "event";
    case "Digest":
      return "digest";
    case "Long-form":
      return "long_form";
    case "Inspiration":
      return "inspiration";
    case "Ignore":
      throw new Error("Ignore routing should not be persisted to processed_contents.");
  }
}

function sanitizeProcessingError(error: unknown): string {
  return truncateError(error instanceof Error ? error.message : String(error));
}

function truncateError(error: string): string {
  return error.slice(0, 2_000);
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await task(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

type Stage1ArticleQueryRow = Stage1ArticleRow;
