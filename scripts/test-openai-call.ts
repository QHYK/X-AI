import { config } from "dotenv";
import OpenAI from "openai";
import {
  createLlmClient,
  resolveLlmConfig,
  resolveLlmProvider,
} from "../src/processing/llm-client.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const provider = resolveLlmProvider(process.argv[2] ?? "openai");
  const apiMode = resolveApiMode(process.argv[3]);
  const llm = resolveLlmConfig({ provider });
  const timeoutMs = Number(
    process.env[`TEST_${provider.toUpperCase()}_TIMEOUT_MS`] ??
      process.env.TEST_LLM_TIMEOUT_MS ??
      30_000,
  );
  const startedAt = Date.now();
  const result = apiMode === "responses"
    ? await runResponsesSmokeTest(provider, llm.model, timeoutMs)
    : await runChatCompletionsSmokeTest(llm, timeoutMs, apiMode === "chat-completions-structured");
  const output = apiMode === "chat-completions"
    ? result.outputText
    : parseSmokeOutput(result.outputText);

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider,
        baseUrl: llm.baseUrl,
        model: llm.model,
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
}

async function runResponsesSmokeTest(
  provider: ReturnType<typeof resolveLlmProvider>,
  model: string,
  timeoutMs: number,
) {
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const response = await client.responses.create(
    {
      model,
      instructions: "Return only the requested structured JSON.",
      input: 'Return {"ok":true,"message":"model call ok"}.',
      max_output_tokens: 64,
      store: false,
      text: { format: smokeTestJsonSchema },
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
  llm: ReturnType<typeof resolveLlmConfig>,
  timeoutMs: number,
  structured: boolean,
) {
  const client = new OpenAI({
    apiKey: llm.apiKey,
    baseURL: llm.baseUrl,
    timeout: timeoutMs,
    maxRetries: 0,
  });
  const response = await client.chat.completions.create(
    {
      model: llm.model,
      messages: [
        { role: "system", content: structured ? "Return only the requested JSON." : "Reply with exactly: model call ok" },
        { role: "user", content: structured ? 'Return {"ok":true,"message":"model call ok"}.' : "Confirm the model call." },
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
  type: "json_schema" as const,
  name: "provider_smoke_test",
  description: "Minimal provider structured-output smoke test.",
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

function resolveApiMode(
  value: string | undefined,
): "responses" | "chat-completions" | "chat-completions-structured" {
  if (!value || value === "responses") {
    return "responses";
  }
  if (value === "chat-completions") {
    return value;
  }
  if (value === "chat-completions-structured") {
    return value;
  }
  throw new Error(
    `Unsupported API mode "${value}". Expected responses, chat-completions, or chat-completions-structured.`,
  );
}

main().catch((error) => {
  const providerName = process.argv[2] ?? "openai";
  console.error(
    JSON.stringify(
      {
        ok: false,
        provider: providerName,
        error: sanitizeError(error instanceof Error ? error.message : String(error)),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});

function parseSmokeOutput(rawText: string): { ok: true; message: string } {
  const parsed = JSON.parse(rawText) as { ok?: unknown; message?: unknown };
  if (parsed.ok !== true || parsed.message !== "model call ok") {
    throw new Error(`Provider returned an unexpected structured response: ${rawText}`);
  }
  return { ok: true, message: parsed.message };
}

function sanitizeError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted_api_key]");
}
