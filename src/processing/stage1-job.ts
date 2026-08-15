import type { Pool, PoolClient, QueryResult } from "pg";
import { runStage1Llm, type Stage1LlmOptions } from "./stage1-llm.js";
import type { Stage1ArticleRow, Stage1Output, Stage1Routing } from "./stage1-contract.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage1JobOptions = Stage1LlmOptions & {
  limit?: number;
  concurrency?: number;
  collectedWithinHours?: number;
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
  collectedWithinHours: number;
  requestedLimit: number | null;
  loadedCount: number;
  selectedCount: number;
  ignoredCount: number;
  failedCount: number;
  processedContentInsertedCount: number;
  retryCount: number;
  results: Stage1JobArticleResult[];
};

const DEFAULT_STAGE1_CONCURRENCY = 3;
const DEFAULT_STAGE1_LOOKBACK_HOURS = 24;

export async function processStage1Batch(
  pool: Pool,
  options: Stage1JobOptions = {},
): Promise<Stage1JobSummary> {
  const startedAt = new Date();
  const collectedWithinHours = options.collectedWithinHours ?? DEFAULT_STAGE1_LOOKBACK_HOURS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_STAGE1_CONCURRENCY);
  const articles = await loadPendingStage1Articles(pool, {
    limit: options.limit,
    collectedWithinHours,
  });

  const results = await runWithConcurrency(articles, concurrency, async (article) =>
    processStage1Article(pool, article, options),
  );

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
    collectedWithinHours,
    requestedLimit: options.limit ?? null,
    loadedCount: articles.length,
    selectedCount: results.filter((result) => result.status === "selected").length,
    ignoredCount: results.filter((result) => result.status === "ignored").length,
    failedCount: results.filter((result) => result.status === "failed").length,
    processedContentInsertedCount: results.filter((result) => result.processedContentInserted)
      .length,
    retryCount: results.reduce((sum, result) => sum + Math.max(0, result.attempts - 1), 0),
    results,
  };
}

export async function loadPendingStage1Articles(
  queryable: Queryable,
  options: {
    limit?: number;
    collectedWithinHours?: number;
  } = {},
): Promise<Stage1ArticleRow[]> {
  const collectedWithinHours = options.collectedWithinHours ?? DEFAULT_STAGE1_LOOKBACK_HOURS;
  const limitClause = options.limit ? "limit $2" : "";
  const values: Array<number> = [collectedWithinHours];
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
      where ra.stage1_status = 'pending'
        and ra.collected_at >= now() - ($1::int * interval '1 hour')
      order by
        case when s.priority = 'High' then 0 when s.priority = 'Medium' then 1 else 2 end,
        coalesce(ra.published_at, ra.collected_at) desc,
        ra.id
      ${limitClause}
    `,
    values,
  );

  return result.rows;
}

export async function processStage1Article(
  pool: Pool,
  article: Stage1ArticleRow,
  options: Stage1LlmOptions = {},
): Promise<Stage1JobArticleResult> {
  const llmResult = await runStage1Llm(article, options);

  if (!llmResult.success) {
    await persistStage1Failure(pool, article.id, llmResult.error);
    return {
      rawArticleId: article.id,
      sourceName: article.sourceName,
      title: article.title,
      status: "failed",
      routing: null,
      processedContentInserted: false,
      attempts: llmResult.attempts,
      error: llmResult.error,
    };
  }

  if (llmResult.output.routing === "Ignore") {
    await persistStage1Ignored(pool, article.id);
    return {
      rawArticleId: article.id,
      sourceName: article.sourceName,
      title: article.title,
      status: "ignored",
      routing: llmResult.output.routing,
      processedContentInserted: false,
      attempts: llmResult.attempts,
      error: null,
    };
  }

  try {
    const processedContentInserted = await persistStage1Selected(pool, article.id, llmResult.output);
    return {
      rawArticleId: article.id,
      sourceName: article.sourceName,
      title: article.title,
      status: "selected",
      routing: llmResult.output.routing,
      processedContentInserted,
      attempts: llmResult.attempts,
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
      routing: llmResult.output.routing,
      processedContentInserted: false,
      attempts: llmResult.attempts,
      error: errorMessage,
    };
  }
}

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
