import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipelineEnvironment } from "../src/lib/pipeline-env.js";
import {
  resolveStage2MaxOutputTokens,
  resolveStageLlmRuntimeConfig,
} from "../src/processing/stage-llm-runtime-config.js";
import { resolveContentCompletionRuntimeConfig } from "../src/processing/content-completion.js";
import { resolveRssRuntimeConfig } from "../src/collectors/rss.js";
import { runStage2MergeLlm } from "../src/processing/stage2-llm.js";

// The imported modules above are evaluated before dotenv loading. Their values
// must still reflect `.env.local` once a pipeline operation starts.
const fixture = await mkdtemp(join(tmpdir(), "x-ai-field-env-"));
const keys = [
  "STAGE1_LLM_TIMEOUT_MS", "STAGE1_LLM_MAX_RETRIES", "STAGE2_LLM_TIMEOUT_MS",
  "STAGE2_LLM_MAX_RETRIES", "STAGE2_LLM_MAX_OUTPUT_TOKENS", "STAGE3_LLM_TIMEOUT_MS",
  "STAGE4_LLM_RETRY_DELAY_MS", "CONTENT_COMPLETION_CONCURRENCY", "RSS_FETCH_TIMEOUT_MS",
] as const;
const previous = new Map(keys.map((key) => [key, process.env[key]]));

try {
  await writeFile(join(fixture, ".env"), "STAGE1_LLM_TIMEOUT_MS=60000\nSTAGE2_LLM_TIMEOUT_MS=61000\n");
  await writeFile(join(fixture, ".env.local"), [
    "STAGE1_LLM_TIMEOUT_MS=120000", "STAGE1_LLM_MAX_RETRIES=4",
    "STAGE2_LLM_TIMEOUT_MS=130000", "STAGE2_LLM_MAX_RETRIES=3",
    "STAGE2_LLM_MAX_OUTPUT_TOKENS=32000", "STAGE3_LLM_TIMEOUT_MS=140000",
    "STAGE4_LLM_RETRY_DELAY_MS=250", "CONTENT_COMPLETION_CONCURRENCY=5",
    "RSS_FETCH_TIMEOUT_MS=26000",
  ].join("\n"));
  process.env.STAGE1_LLM_TIMEOUT_MS = "180000";
  loadPipelineEnvironment({ cwd: fixture });

  // Shell beats .env.local, while .env.local beats .env for non-shell values.
  assert.deepEqual(resolveStageLlmRuntimeConfig("stage1"), { timeoutMs: 180000, maxRetries: 4, retryDelayMs: 1000 });
  assert.deepEqual(resolveStageLlmRuntimeConfig("stage2"), { timeoutMs: 130000, maxRetries: 3, retryDelayMs: 1000 });
  assert.equal(resolveStage2MaxOutputTokens(), 32000);
  assert.equal(resolveStageLlmRuntimeConfig("stage3").timeoutMs, 140000);
  assert.equal(resolveStageLlmRuntimeConfig("stage4").retryDelayMs, 250);
  assert.equal(resolveContentCompletionRuntimeConfig().concurrency, 5);
  assert.equal(resolveRssRuntimeConfig().fetchTimeoutMs, 26000);

  // A Daily/Dashboard parent passes its resolved environment to a child CLI.
  // Repeating the bootstrap must preserve those inherited values.
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env };
  loadPipelineEnvironment({ cwd: fixture, environment: childEnvironment });
  assert.equal(childEnvironment.STAGE1_LLM_TIMEOUT_MS, "180000");
  assert.equal(childEnvironment.STAGE2_LLM_TIMEOUT_MS, "130000");

  let observedStage2Timeout: number | undefined;
  const stage2Result = await runStage2MergeLlm(
    { event_candidates: [{ temp_id: "E001", title: "Fixture" }] } as never,
    {
      request: async (_request, requestOptions) => {
        observedStage2Timeout = requestOptions.timeout;
        return {
          id: "response-1",
          output_text: JSON.stringify({ events: [{ event_hint: "Fixture", sources: ["E001"] }] }),
          output: [], api_mode: "responses", finish_reason: "stop",
        };
      },
    },
  );
  assert.equal(stage2Result.success, true);
  assert.equal(observedStage2Timeout, 130000);

  const emptyEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  assert.equal(resolveStageLlmRuntimeConfig("stage1", emptyEnvironment).timeoutMs, 45000);
  assert.equal(resolveStageLlmRuntimeConfig("stage2", emptyEnvironment).maxRetries, 0);
  await runStage2MergeLlm(
    { event_candidates: [{ temp_id: "E001", title: "Fixture" }] } as never,
    {
      timeoutMs: 77777,
      request: async (_request, requestOptions) => {
        assert.equal(requestOptions.timeout, 77777);
        return {
          id: "response-2",
          output_text: JSON.stringify({ events: [{ event_hint: "Fixture", sources: ["E001"] }] }),
          output: [], api_mode: "responses", finish_reason: "stop",
        };
      },
    },
  );
} finally {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}

console.log("Pipeline dotenv bootstrap and call-time runtime configuration tests passed");
