import {
  shouldFallbackCodexBatch,
  stage1ProviderForLogicalBatch,
} from "../src/processing/stage1-job.js";

const providers = [1, 12, 13].map((batch) => stage1ProviderForLogicalBatch(batch, "deepseek"));
const passed =
  JSON.stringify(providers) === JSON.stringify(["codex", "codex", "deepseek"]) &&
  shouldFallbackCodexBatch(1, "codex", false) &&
  shouldFallbackCodexBatch(12, "codex", false) &&
  !shouldFallbackCodexBatch(13, "deepseek", false) &&
  !shouldFallbackCodexBatch(2, "codex", true) &&
  // Completion order is irrelevant because assignment only receives logical index.
  JSON.stringify([13, 1, 12, 2, 11].map((batch) => stage1ProviderForLogicalBatch(batch, "deepseek"))) ===
    JSON.stringify(["deepseek", "codex", "codex", "codex", "codex"]);

console.log(JSON.stringify({ success: passed, providers }, null, 2));
if (!passed) process.exitCode = 1;
