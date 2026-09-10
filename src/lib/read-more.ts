/**
 * Read More 的按需服务：仅在用户点击后读取全文并调用共享 LLM client。
 * 不缓存结果，也不会把原文返回给客户端。
 */
import type { Pool } from "pg";
import {
  buildReadMoreInstructions,
  buildReadMoreUserPrompt,
} from "../prompts/read-more.js";
import {
  createLlmClient,
  resolveLlmModel,
  resolveLlmProvider,
} from "../processing/llm-client.js";

export type ReadMoreResponse =
  | { status: "success"; summary_zh: string }
  | { status: "not_available" };

type FullContentRow = {
  fullContentText: string | null;
};

const READ_MORE_TIMEOUT_MS = Number(process.env.READ_MORE_LLM_TIMEOUT_MS ?? 120_000);

const readMoreOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary_zh"],
  properties: {
    summary_zh: { type: "string" },
  },
} as const;

/** 根据 processed_contents.id 查找关联原文；空白全文与不存在的内容同样不可用。 */
export async function generateReadMoreSummary(
  pool: Pool,
  contentId: string,
): Promise<ReadMoreResponse> {
  const result = await pool.query<FullContentRow>(
    `
      select ra.full_content_text as "fullContentText"
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = $1
        and pc.routing in ('digest', 'long_form')
      limit 1
    `,
    [contentId],
  );
  const fullContentText = result.rows[0]?.fullContentText?.trim();

  if (!fullContentText) {
    return { status: "not_available" };
  }

  const provider = resolveLlmProvider();
  const model = resolveLlmModel(undefined, provider);
  const client = createLlmClient({
    provider,
    timeoutMs: READ_MORE_TIMEOUT_MS,
    maxRetries: 0,
  });

  try {
    const response = await client.structured.create(
      {
        model,
        instructions: buildReadMoreInstructions(),
        input: buildReadMoreUserPrompt(fullContentText),
        max_output_tokens: 2_000,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "read_more_summary",
            description: "Structured Chinese detailed article summary.",
            schema: readMoreOutputJsonSchema,
            strict: true,
          },
        },
      },
      { timeout: READ_MORE_TIMEOUT_MS },
    );
    const summaryZh = parseReadMoreSummary(response.output_text);

    return {
      status: "success",
      summary_zh: summaryZh,
    };
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

  if (!isRecord(parsed) || typeof parsed.summary_zh !== "string" || !parsed.summary_zh.trim()) {
    throw new Error("Read More structured output must contain a non-empty summary_zh string.");
  }

  return parsed.summary_zh.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
