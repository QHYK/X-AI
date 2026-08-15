import { config } from "dotenv";
import { createOpenAiClient, getOpenAiBaseUrl } from "../src/processing/openai-client.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.TEST_OPENAI_TIMEOUT_MS ?? 30_000);

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to test a model call.");
  }

  const model = process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const client = createOpenAiClient({
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxRetries: 0,
  });

  const startedAt = Date.now();
  const response = await client.responses.create(
    {
      model,
      input: "Return exactly this short sentence: model call ok",
      max_output_tokens: 32,
      store: false,
    },
    {
      timeout: DEFAULT_TIMEOUT_MS,
    },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        baseUrl: getOpenAiBaseUrl(),
        model,
        responseId: response.id,
        elapsedMs: Date.now() - startedAt,
        outputText: response.output_text,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        baseUrl: getOpenAiBaseUrl(),
        model: process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
        error: sanitizeError(error instanceof Error ? error.message : String(error)),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});

function sanitizeError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted_api_key]");
}
