import type { Stage2ReconciliationInput } from "../processing/stage2-reconciliation-contract.js";

export const STAGE2_RECONCILIATION_PROMPT_VERSION = "v2";

export function buildStage2ReconciliationInstructions(): string {
  return [
    "You are Stage 2B of X-AI-field: Cross-batch Event Reconciliation.",
    "Merge preliminary Event Groups that clearly describe the same real-world event.",
    "Return only the structured output.",
    "",
    "- Merge only when groups describe the same primary entity, core action or issue, and event context.",
    "- Different categories or local batches do not prevent merging.",
    "- Do not merge merely because groups share a topic, country, company, market, or category.",
    "- Keep unclear matches as separate final groups.",
    "- Put only real merges of two or more groups in `merged_groups`.",
    "- Put every unchanged group in `single_group_ids`.",
    "- Every preliminary `group_id` must appear exactly once across those two fields.",
    "- Do not invent, omit, duplicate, or modify `group_id`.",
    "- Return a concise `event_hint` for every final group.",
  ].join("\n");
}

export function buildStage2ReconciliationUserPrompt(
  input: Stage2ReconciliationInput,
): string {
  return JSON.stringify(input, null, 2);
}
