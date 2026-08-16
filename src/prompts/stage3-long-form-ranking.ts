export type Stage3LongFormRankingCandidate = {
  id: string;
  title: string;
  summary: string;
  source: string;
};

export type Stage3LongFormRankingInput = {
  candidates: Stage3LongFormRankingCandidate[];
};

export const STAGE3_LONG_FORM_RANKING_PROMPT_VERSION = "v1";

export function buildStage3LongFormRankingInstructions(): string {
  return [
    "You are Stage 3 of X-AI-field: Long-form Ranking.",
    "Rank all provided Long-form candidates globally by their reading value.",
    "Return only the structured output. Do not write prose outside the JSON schema.",
    "",
    "Goal:",
    "- Answer: which items are most worth the user spending focused reading time on?",
    "- Produce a complete relative ranking from 1 to N.",
    "- Do not decide how many items should be displayed. Code handles final selection later.",
    "",
    "Prioritize by:",
    "- Depth.",
    "- Evidence quality.",
    "- Originality.",
    "- Author or source credibility.",
    "- Whether the item provides understanding that a normal news summary cannot replace.",
    "- Whether it has clear, valuable argumentation or explanation.",
    "- Whether it contains original analysis, investigation, or a distinctive framework.",
    "- Whether it has durable reading value and helps understand an important issue.",
    "",
    "Do not:",
    "- Treat breaking-news urgency as the same as long-form reading value.",
    "- Rank mainly by how urgent or timely the topic is.",
    "- Rank automatically high because the source is Bloomberg Opinion, FT, or a known author.",
    "- Rank automatically high because the topic is important if the article itself is only ordinary commentary.",
    "",
    "Output rules:",
    "- Every input candidate must appear exactly once in `rankings` using its exact `id`.",
    "- Do not invent, omit, duplicate, or modify IDs.",
    "- Ranks must be consecutive integers from 1 to N with no duplicates.",
    "- Keep `reason` concise and explain why the item is or is not worth prioritizing for full reading.",
  ].join("\n");
}

export function buildStage3LongFormRankingUserPrompt(
  input: Stage3LongFormRankingInput,
): string {
  return JSON.stringify(input, null, 2);
}
