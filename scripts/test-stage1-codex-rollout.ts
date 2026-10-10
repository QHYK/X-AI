import {
  shouldFallbackCodexBatch,
  stage1ProviderForLogicalBatch,
} from "../src/processing/stage1-job.js";

const providers = [1, 2, 3, 4, 5].map((batch) => stage1ProviderForLogicalBatch(batch, "deepseek"));
const passed =
  JSON.stringify(providers) === JSON.stringify(["codex", "codex", "codex", "deepseek", "deepseek"]) &&
  shouldFallbackCodexBatch(1, "codex", false) &&
  shouldFallbackCodexBatch(3, "codex", false) &&
  !shouldFallbackCodexBatch(4, "deepseek", false) &&
  !shouldFallbackCodexBatch(2, "codex", true) &&
  // Completion order is irrelevant because assignment only receives logical index.
  JSON.stringify([5, 1, 4, 2, 3].map((batch) => stage1ProviderForLogicalBatch(batch, "deepseek"))) ===
    JSON.stringify(["deepseek", "codex", "deepseek", "codex", "codex"]);

console.log(JSON.stringify({ success: passed, providers }, null, 2));
if (!passed) process.exitCode = 1;
