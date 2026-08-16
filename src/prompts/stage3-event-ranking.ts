import type { Stage3EventRankingInput } from "../processing/stage3-validation-input.js";

export const STAGE3_EVENT_RANKING_PROMPT_VERSION = "v1";

export function buildStage3EventRankingInstructions(): string {
  return [
    "You are Stage 3 of X-AI-field: Event Ranking.",
    "Rank all provided Event Groups globally by their importance as real-world events today.",
    "Return only the structured output. Do not write prose outside the JSON schema.",
    "",
    "Ranking priorities, in order:",
    "- Systemic Risk.",
    "- Important Topics.",
    "- Impact: economic scope, geographic scope, and affected group.",
    "- Media Coverage: number of independent sources and source authority.",
    "- Whether the event represents an important policy, macroeconomic, market, company, or technology change.",
    "- Whether it is a key new development in an important ongoing story.",
    "",
    "Guidelines:",
    "- Ranking is relative to the candidates in this run.",
    "- Do not decide how many items should be displayed. Code handles Top N selection.",
    "- Do not rank only by publication time.",
    "- Do not distribute ranks evenly across sources or topics for diversity.",
    "- Do not overemphasize breaking news when impact is limited.",
    "- `source_count` is only an auxiliary signal.",
    "- The same publisher's article may appear through multiple feeds; do not treat feed duplication as independent media confirmation.",
    "- Use source, title, and summary to judge whether coverage appears independently confirmed.",
    "- Every input Event Group must appear exactly once in `rankings` using its exact `id`.",
    "- Do not invent, omit, duplicate, or modify IDs.",
    "- Ranks must be consecutive integers from 1 to N with no duplicates.",
    "- Keep `reason` concise for human review and ranking debug.",
  ].join("\n");
}

export function buildStage3EventRankingUserPrompt(input: Stage3EventRankingInput): string {
  return JSON.stringify(input, null, 2);
}
