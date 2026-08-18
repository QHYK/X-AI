import { config } from "dotenv";
import { Pool } from "pg";
import {
  validateStage1Assignments,
  type Stage1ArticleRow,
  type Stage1Routing,
} from "../src/processing/stage1-contract.js";
import {
  createStage1MicroBatches,
  DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS,
  DEFAULT_STAGE1_BATCH_MAX_TOTAL_CHARS,
  DEFAULT_STAGE1_BATCH_SIZE,
  stage1ArticleContentLength,
  type Stage1BatchConfig,
} from "../src/processing/stage1-job.js";
import {
  runStage1BatchLlm,
  type Stage1TokenUsage,
} from "../src/processing/stage1-llm.js";
import { STAGE1_PROMPT_VERSION } from "../src/prompts/stage1-content-understanding.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type ValidationArticle = Stage1ArticleRow & {
  previousRouting: string;
  contentChars: number;
};

type ValidationCall = {
  batch: number;
  articleCount: number;
  contentChars: number;
  attempts: number;
  retryCount: number;
  durationMs: number;
  tokenUsage: Stage1TokenUsage | null;
  assignment: {
    passed: boolean;
    missingTempIds: string[];
    duplicateTempIds: string[];
    inventedTempIds: string[];
  };
};

type RoutingComparison = {
  article: string;
  tempId: string;
  previousRouting: Stage1Routing;
  batchRouting: Stage1Routing;
  tags: string[];
  entities: string[];
  summary: string;
  summaryZh: string;
};

const VALIDATION_BATCH_CONFIG: Stage1BatchConfig = {
  batchSize: DEFAULT_STAGE1_BATCH_SIZE,
  batchMaxContentChars: DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS,
  batchMaxTotalChars: DEFAULT_STAGE1_BATCH_MAX_TOTAL_CHARS,
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to validate Stage 1 batching.");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to validate Stage 1 batching.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  try {
    const { shortArticles, largeArticle } = await loadValidationArticles(pool);
    const articles = [...shortArticles, largeArticle];
    const batches = createStage1MicroBatches(articles, VALIDATION_BATCH_CONFIG);
    assertExpectedBatches(batches, largeArticle.id);

    const startedAt = Date.now();
    const calls: ValidationCall[] = [];
    const comparisons: RoutingComparison[] = [];

    for (const [batchIndex, batch] of batches.entries()) {
      const result = await runStage1BatchLlm(batch, {
        model: process.env.OPENAI_MODEL,
      });
      if (!result.success) {
        console.log(
          JSON.stringify(
            {
              success: false,
              failedBatch: batchIndex + 1,
              articleCount: batch.length,
              attempts: result.attempts,
              retryCount: Math.max(0, result.attempts - 1),
              durationMs: result.elapsedMs,
              tokenUsage: result.tokenUsage,
              error: result.error,
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
        return;
      }

      const assignment = validateStage1Assignments(result.output, result.input);
      const outputByTempId = new Map(
        result.output.results.map((output) => [output.temp_id, output]),
      );

      calls.push({
        batch: batchIndex + 1,
        articleCount: batch.length,
        contentChars: batch.reduce(
          (sum, article) => sum + stage1ArticleContentLength(article),
          0,
        ),
        attempts: result.attempts,
        retryCount: Math.max(0, result.attempts - 1),
        durationMs: result.elapsedMs,
        tokenUsage: result.tokenUsage,
        assignment: {
          passed: assignment.passed,
          missingTempIds: assignment.missingTempIds,
          duplicateTempIds: assignment.duplicateTempIds,
          inventedTempIds: assignment.inventedTempIds,
        },
      });

      batch.forEach((article, index) => {
        const tempId = result.input.articles[index].temp_id;
        const output = outputByTempId.get(tempId);
        if (!output) {
          throw new Error(`Validated batch output is missing ${tempId}.`);
        }

        const validationArticle = article as ValidationArticle;
        comparisons.push({
          article: article.title,
          tempId,
          previousRouting: toPromptRouting(validationArticle.previousRouting),
          batchRouting: output.routing,
          tags: output.tags,
          entities: output.entities,
          summary: output.generated_content.summary,
          summaryZh: output.generated_content.summary_zh,
        });
      });
    }

    console.log(
      JSON.stringify(
        {
          success: true,
          promptVersion: STAGE1_PROMPT_VERSION,
          databaseWrites: 0,
          articleCount: articles.length,
          shortArticleCount: shortArticles.length,
          largeArticleCount: 1,
          largeArticleContentChars: largeArticle.contentChars,
          logicalLlmCallCount: calls.length,
          actualLlmCallCount: calls.reduce((sum, call) => sum + call.attempts, 0),
          retryCount: calls.reduce((sum, call) => sum + call.retryCount, 0),
          durationMs: Date.now() - startedAt,
          llmDurationMs: calls.reduce((sum, call) => sum + call.durationMs, 0),
          tokenUsage: sumTokenUsage(calls.map((call) => call.tokenUsage)),
          calls,
          comparisons,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

async function loadValidationArticles(pool: Pool): Promise<{
  shortArticles: ValidationArticle[];
  largeArticle: ValidationArticle;
}> {
  const shortMaxChars = Math.min(
    DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS - 1,
    Math.floor(DEFAULT_STAGE1_BATCH_MAX_TOTAL_CHARS / DEFAULT_STAGE1_BATCH_SIZE),
  );
  const shortResult = await pool.query<ValidationArticle>(
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
        s.language as "sourceLanguage",
        case
          when ra.stage1_status = 'ignored' then 'Ignore'
          else pc.routing
        end as "previousRouting",
        char_length(trim(coalesce(ra.content_text, '')))::int as "contentChars"
      from raw_articles ra
      join sources s on s.id = ra.source_id
      left join processed_contents pc on pc.raw_article_id = ra.id
      where ra.stage1_status in ('selected', 'ignored')
        and s.category <> 'Long-form'
        and char_length(trim(coalesce(ra.content_text, ''))) between 300 and $1
        and (ra.stage1_status = 'ignored' or pc.routing is not null)
      order by ra.stage1_processed_at desc, ra.id
      limit 5
    `,
    [shortMaxChars],
  );
  if (shortResult.rows.length !== 5) {
    throw new Error(`Expected 5 short validation articles, found ${shortResult.rows.length}.`);
  }

  const largeResult = await pool.query<ValidationArticle>(
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
        s.language as "sourceLanguage",
        case
          when ra.stage1_status = 'ignored' then 'Ignore'
          else pc.routing
        end as "previousRouting",
        char_length(trim(coalesce(ra.content_text, '')))::int as "contentChars"
      from raw_articles ra
      join sources s on s.id = ra.source_id
      left join processed_contents pc on pc.raw_article_id = ra.id
      where ra.stage1_status in ('selected', 'ignored')
        and char_length(trim(coalesce(ra.content_text, ''))) >= $1
        and (ra.stage1_status = 'ignored' or pc.routing is not null)
      order by char_length(trim(coalesce(ra.content_text, ''))) asc, ra.id
      limit 1
    `,
    [DEFAULT_STAGE1_BATCH_MAX_CONTENT_CHARS],
  );
  const largeArticle = largeResult.rows[0];
  if (!largeArticle) {
    throw new Error("Expected one large validation article, found none.");
  }

  return {
    shortArticles: shortResult.rows,
    largeArticle,
  };
}

function assertExpectedBatches(batches: Stage1ArticleRow[][], largeArticleId: string) {
  if (
    batches.length !== 2 ||
    batches[0].length !== 5 ||
    batches[1].length !== 1 ||
    batches[1][0].id !== largeArticleId
  ) {
    throw new Error(
      `Expected one five-article batch and one isolated large article, got ${batches
        .map((batch) => batch.length)
        .join(", ")}.`,
    );
  }
}

function toPromptRouting(value: string): Stage1Routing {
  switch (value) {
    case "event":
      return "Event";
    case "digest":
      return "Digest";
    case "long_form":
      return "Long-form";
    case "inspiration":
      return "Inspiration";
    case "Ignore":
      return "Ignore";
    default:
      throw new Error(`Unknown previous Stage 1 routing "${value}".`);
  }
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
