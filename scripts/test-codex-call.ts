/**
 *  默认测试 responses
 *  npx tsx scripts/test-codex-call.ts

 *  测试 Structured Output：
 *  npx tsx scripts/test-codex-call.ts chat-completions-structured
 */
import { config } from "dotenv";
import OpenAI from "openai";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const DEFAULT_BASE_URL = "http://127.0.0.1:8317/v1";
const DEFAULT_MODEL = "gpt-5.6-terra";

type ApiMode = "responses" | "chat-completions" | "chat-completions-structured";

async function main() {
  const apiMode = resolveApiMode(process.argv[2]);
  const baseURL = process.env.CODEX_BASE_URL ?? DEFAULT_BASE_URL;
  const apiKey = process.env.CODEX_API_KEY;
  const model = process.env.CODEX_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = Number(process.env.TEST_CODEX_TIMEOUT_MS ?? 30_000);

  if (!apiKey) {
    throw new Error("CODEX_API_KEY is required.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs,
    maxRetries: 0,
  });

  const startedAt = Date.now();

  try {
    const result =
      apiMode === "responses"
        ? await runResponsesSmokeTest(client, model, timeoutMs)
        : await runChatCompletionsSmokeTest(
            client,
            model,
            timeoutMs,
            apiMode === "chat-completions-structured",
          );

    const output =
      apiMode === "chat-completions"
        ? result.outputText
        : parseSmokeOutput(result.outputText);

    console.log(
      JSON.stringify(
        {
          ok: true,
          provider: "codex-proxy",
          baseUrl: baseURL,
          model,
          apiMode,
          responseId: result.responseId,
          elapsedMs: Date.now() - startedAt,
          usage: result.usage,
          output,
        },
        null,
        2,
      ),
    );
  } finally {
    // OpenAI SDK 当前不需要显式 close。
  }
}

async function runResponsesSmokeTest(
  client: OpenAI,
  model: string,
  timeoutMs: number,
) {
  const response = await client.responses.create(
    {
      model,
      instructions: "Return only the requested structured JSON.",
      input: 'Return {"ok":true,"message":"model call ok"}.',
      max_output_tokens: 64,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: smokeTestJsonSchema.name,
          description: smokeTestJsonSchema.description,
          strict: smokeTestJsonSchema.strict,
          schema: smokeTestJsonSchema.schema,
        },
      },
    },
    { timeout: timeoutMs },
  );

  return {
    responseId: response.id,
    outputText: response.output_text,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : null,
  };
}

async function runChatCompletionsSmokeTest(
  client: OpenAI,
  model: string,
  timeoutMs: number,
  structured: boolean,
) {
  const response = await client.chat.completions.create(
    {
      model,
      messages: [
        {
          role: "system",
          content: structured
            ? "Return only the requested JSON."
            : "Reply with exactly: model call ok",
        },
        {
          role: "user",
          content: structured
            ? 'Return {"ok":true,"message":"model call ok"}.'
            : "Confirm the model call.",
        },
      ],
      max_tokens: 64,
      ...(structured
        ? {
            response_format: {
              type: "json_schema" as const,
              json_schema: smokeTestJsonSchema,
            },
          }
        : {}),
    },
    { timeout: timeoutMs },
  );

  return {
    responseId: response.id,
    outputText: response.choices[0]?.message.content ?? "",
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : null,
  };
}

const smokeTestJsonSchema = {
  name: "provider_smoke_test",
  description: "Minimal Codex proxy structured-output smoke test.",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["ok", "message"],
    properties: {
      ok: { type: "boolean" },
      message: { type: "string" },
    },
  },
};

function resolveApiMode(value: string | undefined): ApiMode {
  if (!value || value === "responses") {
    return "responses";
  }

  if (
    value === "chat-completions" ||
    value === "chat-completions-structured"
  ) {
    return value;
  }

  throw new Error(
    `Unsupported API mode "${value}". Expected responses, chat-completions, or chat-completions-structured.`,
  );
}

function parseSmokeOutput(rawText: string): { ok: true; message: string } {
  const parsed = JSON.parse(rawText) as { ok?: unknown; message?: unknown };

  if (parsed.ok !== true || parsed.message !== "model call ok") {
    throw new Error(
      `Codex proxy returned an unexpected structured response: ${rawText}`,
    );
  }

  return { ok: true, message: parsed.message };
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        provider: "codex-proxy",
        error: sanitizeError(
          error instanceof Error ? error.message : String(error),
        ),
      },
      null,
      2,
    ),
  );

  process.exitCode = 1;
});

function sanitizeError(errorMessage: string): string {
  return errorMessage
    .replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted_api_key]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}
