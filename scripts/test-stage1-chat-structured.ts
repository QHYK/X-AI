import { config } from "dotenv";
import OpenAI from "openai";
import { Pool } from "pg";
import {
  buildStage1BatchInput,
  parseAndValidateStage1BatchOutput,
  stage1BatchOutputJsonSchema,
  validateStage1Assignments,
  type Stage1ArticleRow,
} from "../src/processing/stage1-contract.js";
import {
  buildStage1Instructions,
  buildStage1UserPrompt,
} from "../src/prompts/stage1-content-understanding.js";
import { resolveLlmConfig } from "../src/processing/llm-client.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const RUN_COUNT = 3;
const ARTICLE_LIMIT = 2;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the Stage 1 Chat smoke test.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  });
  const llm = resolveLlmConfig({ provider: "openai" });
  const client = new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl, maxRetries: 0 });

  try {
    const articles = await loadRecentArticles(pool);
    if (articles.length === 0) {
      throw new Error("No raw articles with content were available for the Stage 1 Chat smoke test.");
    }

    const input = buildStage1BatchInput(articles);
    const runs = [];
    for (let iteration = 1; iteration <= RUN_COUNT; iteration += 1) {
      const startedAt = Date.now();
      const response = await client.chat.completions.create({
        model: llm.model,
        messages: [
          { role: "system", content: buildStage1Instructions() },
          { role: "user", content: buildStage1UserPrompt(input) },
        ],
        max_tokens: 1_200 * input.articles.length,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "stage1_content_understanding_batch",
            description: "Independent Stage 1 results for a batch of articles.",
            schema: stage1BatchOutputJsonSchema,
            strict: true,
          },
        },
      });
      const rawOutputText = response.choices[0]?.message.content ?? "";
      const validation = parseAndValidateStage1BatchOutput(rawOutputText);
      const assignment = validation.success
        ? validateStage1Assignments(validation.output, input)
        : null;
      if (!validation.success || !assignment?.passed) {
        throw new Error(
          `Stage 1 Chat smoke test failed on iteration ${iteration}: ${[
            ...(validation.success ? [] : validation.errors),
            ...(assignment?.errors ?? []),
          ].join("; ")}`,
        );
      }

      runs.push({
        iteration,
        responseId: response.id,
        elapsedMs: Date.now() - startedAt,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : null,
        results: validation.output.results.map((result) => ({
          tempId: result.temp_id,
          routing: result.routing,
          category: result.category,
          chineseTitlePresent: result.generated_content.title_zh.length > 0,
          chineseSummaryPresent: result.generated_content.summary_zh.length > 0,
        })),
      });
    }

    console.log(JSON.stringify({
      ok: true,
      provider: "openai",
      baseUrl: llm.baseUrl,
      model: llm.model,
      apiMode: "chat-completions",
      articleCount: input.articles.length,
      tempIds: input.articles.map((article) => article.temp_id),
      runs,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

async function loadRecentArticles(pool: Pool): Promise<Stage1ArticleRow[]> {
  const result = await pool.query<Stage1ArticleRow>(`
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
    where length(trim(coalesce(ra.content_text, ''))) >= 500
    order by ra.published_at desc nulls last, ra.id
    limit ${ARTICLE_LIMIT}
  `);
  return result.rows;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
