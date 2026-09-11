import { classifyStage4LlmError } from "../src/processing/stage4-llm.js";

const scheduled: number[] = [];
for (let index = 1; index <= 15; index += 1) {
  scheduled.push(index);
  const error = index === 7 ? "403 insufficient_quota" : null;
  if (error && classifyStage4LlmError(error) === "quota_or_auth_unavailable") break;
}
if (JSON.stringify(scheduled) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7])) {
  throw new Error(`Expected fail-fast scheduling through Event 7 only, got ${scheduled.join(",")}.`);
}
if (classifyStage4LlmError("503 auth_unavailable") !== "quota_or_auth_unavailable" || classifyStage4LlmError("timeout") !== "transient" || classifyStage4LlmError("invalid request") !== "ordinary") {
  throw new Error("Stage 4 LLM error classification failed.");
}
console.log("Stage 4 quota/auth fail-fast focused test passed");
