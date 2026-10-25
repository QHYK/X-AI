import { selectReadMoreSourceText } from './read-more-eligibility.js';
import { productionPrompt, withPromptBindings, databasePromptBinder } from './prompts/runtime.js';
/**
 * Read More 的按需服务：优先复用已验证的持久化摘要；缓存未命中时才读取正文并调用 LLM。
 * 原始正文只在服务端读取，永不返回客户端。
 */
import type { Pool } from 'pg';
import { createLlmClient, resolveLlmModel, resolveLlmProvider } from '../processing/llm-client.js';

export type ReadMoreResponse =
  { status: 'success'; summary_zh: string } | { status: 'not_available' };
type CachedSummaryRow = { summaryZh: string | null };
type ContentRow = { rawId?: string; fullContentText: string | null; contentText: string | null };
export type ReadMoreGenerator = (sourceText: string) => Promise<string>;

const READ_MORE_TIMEOUT_MS = Number(process.env.READ_MORE_LLM_TIMEOUT_MS ?? 120_000);

const readMoreOutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary_zh'],
  properties: { summary_zh: { type: 'string' } },
} as const;

/** Cache lookup intentionally precedes eligibility: validated past output remains readable. */
export async function generateReadMoreSummary(
  pool: Pool,
  contentId: string,
  options: { generate?: ReadMoreGenerator } = {},
): Promise<ReadMoreResponse> {
  const cached = await pool.query<CachedSummaryRow>(
    `select summary_zh as "summaryZh" from content_read_more
      where content_id = $1::uuid and nullif(btrim(summary_zh), '') is not null limit 1`,
    [contentId],
  );
  const cachedSummary = cached.rows[0]?.summaryZh?.trim();
  if (cachedSummary) return { status: 'success', summary_zh: cachedSummary };

  const result = await pool.query<ContentRow>(
    `select ra.id as "rawId", ra.full_content_text as "fullContentText", ra.content_text as "contentText"
       from processed_contents pc join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = $1::uuid and pc.routing in ('digest', 'long_form') limit 1`,
    [contentId],
  );
  const sourceText = result.rows[0] ? selectReadMoreSourceText(result.rows[0]) : null;
  if (!sourceText) return { status: 'not_available' };

  const summaryZh = await (options.generate
    ? options.generate(sourceText)
    : withPromptBindings(
        pool,
        databasePromptBinder(pool, 'raw', result.rows[0]!.rawId!, { fresh: true }),
        () => generateReadMoreWithLlm(sourceText),
        { binding: 'active' },
      ));
  const persisted = await pool.query<CachedSummaryRow>(
    `insert into content_read_more (content_id, summary_zh) values ($1::uuid, $2)
     on conflict (content_id) do update set summary_zh = excluded.summary_zh, updated_at = now()
     returning summary_zh as "summaryZh"`,
    [contentId, summaryZh],
  );
  const persistedSummary = persisted.rows[0]?.summaryZh?.trim();
  if (!persistedSummary) throw new Error('Read More cache upsert did not return a valid summary.');
  return { status: 'success', summary_zh: persistedSummary };
}

async function generateReadMoreWithLlm(sourceText: string): Promise<string> {
  const prompt = await productionPrompt('daily.read_more.detailed_summary', sourceText);
  const provider = resolveLlmProvider();
  const model = resolveLlmModel(undefined, provider);
  const client = createLlmClient({ provider, timeoutMs: READ_MORE_TIMEOUT_MS, maxRetries: 0 });
  try {
    const response = await client.structured.create(
      {
        model,
        ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
        input: prompt.input,
        max_output_tokens: 2_000,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: 'read_more_summary',
            description: 'Structured Chinese detailed article summary.',
            schema: readMoreOutputJsonSchema,
            strict: true,
          },
        },
      },
      { timeout: READ_MORE_TIMEOUT_MS },
    );
    return parseReadMoreSummary(response.output_text);
  } finally {
    await client.close();
  }
}

function parseReadMoreSummary(rawText: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Read More structured output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed) || typeof parsed.summary_zh !== 'string' || !parsed.summary_zh.trim()) {
    throw new Error('Read More structured output must contain a non-empty summary_zh string.');
  }
  return parsed.summary_zh.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
