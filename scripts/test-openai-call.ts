import { config } from "dotenv";
import {
  createLlmClient,
  resolveLlmConfig,
  resolveLlmProvider,
} from "../src/processing/llm-client.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

async function main() {
  const provider = resolveLlmProvider(process.argv[2] ?? "openai");
  const llm = resolveLlmConfig({ provider });
  const timeoutMs = Number(
    process.env[`TEST_${provider.toUpperCase()}_TIMEOUT_MS`] ??
      process.env.TEST_LLM_TIMEOUT_MS ??
      30_000,
  );
  const client = createLlmClient({
    provider,
    timeoutMs,
    maxRetries: 0,
  });

  const startedAt = Date.now();
  const response = await client.responses.create(
    {
      model: llm.model,
      instructions: "Return only the requested structured JSON.",
      input: 'Return {"ok":true,"message":"model call ok"}.',
      max_output_tokens: 64,
      store: false,
      text: {
        format: {
          type: "json_schema",
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
        },
      },
    },
    {
      timeout: timeoutMs,
    },
  );
  const output = parseSmokeOutput(response.output_text);

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider,
        baseUrl: llm.baseUrl,
        model: llm.model,
        responseId: response.id,
        elapsedMs: Date.now() - startedAt,
        structuredOutput: output,
      },
      null,
      2,
    ),
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
