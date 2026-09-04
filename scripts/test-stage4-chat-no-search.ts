import { config } from "dotenv";
import { readFile } from "node:fs/promises";
import { runStage4EventEnrichmentLlm } from "../src/processing/stage4-llm.js";
import type { Stage4EventEnrichmentInput } from "../src/prompts/stage4-event-enrichment.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

const INPUT_PATH = "runtime/stage4/2026-08-20T09-46-46-789Z/events/EV057/input.json";

async function main() {
  const input = JSON.parse(await readFile(INPUT_PATH, "utf8")) as Stage4EventEnrichmentInput;
  const result = await runStage4EventEnrichmentLlm(input, { maxRetries: 0 });
  if (!result.success) {
    throw new Error(result.error);
  }
  if (result.toolUsage.apiMode !== "chat_completions" || result.toolUsage.webSearchPerformed) {
    throw new Error("Expected the sufficient-context smoke test to use Chat Completions without Web Search.");
  }

  console.log(JSON.stringify({
    ok: true,
    apiMode: result.toolUsage.apiMode,
    webSearchPerformed: result.toolUsage.webSearchPerformed,
    responseId: result.responseId,
    elapsedMs: result.elapsedMs,
    usage: result.toolUsage.usage,
    title: result.output.event_title,
    chineseTitlePresent: result.output.event_title_zh.length > 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
