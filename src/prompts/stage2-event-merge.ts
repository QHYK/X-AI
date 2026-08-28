/**
 * Stage 2 Event Merge Prompt builder。
 * 将候选组装规则保持在 prompt 层，输出契约由 stage2-contract 独立校验。
 */
import type { Stage2Input } from "../processing/stage2-contract.js";

export const STAGE2_PROMPT_VERSION = "v4";

/** 构造 Stage 2 的固定合并指令。 */
export function buildStage2Instructions(): string {
  return [
    "You are Stage 2 of X-AI-field: Merge Events.",
    "Group Event Candidates into coherent real-world Events for a daily news brief.",
    "An Event may represent either a single concrete occurrence or a closely connected set of developments within the same active event thread.", 
    "Return exactly one structured JSON object, then stop. Do not write prose outside the schema.",
    "",
    "## Merge Rules",
    "Merge candidates when they describe either:",
    "1. The same concrete real-world occurrence; or",
    "2. Closely connected developments in the same active event thread, when they collectively answer the same specific real-world question, decision, conflict, negotiation, policy path, or major ongoing development.",
    "Candidates in the same event thread may involve different people or actions if they provide closely related signals, reactions, or developments that naturally belong under one specific Event headline.",
    "Examples:",
    "- Multiple Federal Reserve officials giving related signals about the near-term interest-rate path may form one Event.",
    "- Different statements or proposals within the same active ceasefire or trade negotiation may form one Event.",
    "",
    "## Do Not Over-Merge",
    "A shared entity or broad topic alone is not enough.",
    "Keep candidates separate when they concern different decisions, issues, or developments.",
    "Examples:",
    "- A Fed interest-rate outlook story should not merge with an unrelated Fed banking-regulation action.",
    "- Separate developments involving the same company, politician, or country should not merge unless they belong to the same specific event thread.",
    "",
    "## Output Rules",
    "",
    "- Every input candidate must appear in exactly one Event's `sources` using its exact `temp_id`.",
    "- Do not invent, omit, duplicate, or modify `temp_id`.",
    "- `event_hint` should concisely describe the shared concrete event or active event thread.",
    "- For an event thread, write `event_hint` around the shared development or question, not around one individual source.",
  ].join("\n");
}

export function buildStage2UserPrompt(input: Stage2Input): string {
  return JSON.stringify(input, null, 2);
}
