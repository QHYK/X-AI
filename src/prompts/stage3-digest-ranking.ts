/**
 * Stage 3 分类 Digest 排名 Prompt builder。
 * 输入由 Stage 3 job 按类别构造，输出顺序随后会接受完整性校验与必要的 repair。
 */
export type Stage3DigestRankingCandidate = {
  id: string;
  title: string;
  summary: string;
  source: string;
  publication?: string | null;
};

export type Stage3DigestRankingInput = {
  category: string;
  candidates: Stage3DigestRankingCandidate[];
};

export const STAGE3_DIGEST_RANKING_PROMPT_VERSION = "v3";

/** 为指定类别构造独立排名指令，避免模型进行跨类别比较。 */
export function buildStage3DigestRankingInstructions(category: string): string {
  return [
    "You are Stage 3 of X-AI-field: Source Digest Ranking.",
    `Rank all provided Source Digest candidates within the "${category}" category.`,
    "Return only the structured output. Do not write prose outside the JSON schema.",
    "",
    "Goal:",
    "- Answer: within this category, which Source Digest items are most worth paying attention to today?",
    "- Produce a relative ranking of the candidates you return.",
    "- Do not decide how many items should be displayed. Code handles Top N selection later.",
    "",
    "Prioritize by:",
    "- Source or publication significance.",
    "- Novelty.",
    "- Information value.",
    "- Whether the item contains important new information, represents a meaningful trend, or has high learning value.",
    "",
    "Category-specific interpretation:",
    "- Finance & Economy: prioritize important macro, market, financial, and institutional changes.",
    "- Technology: prioritize important technical shifts, industry trends, and major company technology developments.",
    "- Science: prioritize important research findings, method breakthroughs, application value, or broad scientific significance.",
    "- Policy: prioritize important policy, regulatory, and institutional changes.",
    "- Company: prioritize major company changes over ordinary company updates.",
    "- General: prioritize broad public value and important international or social information.",
    "",
    "Science source semantics:",
    "- For Science candidates, `source` is the collection/feed source.",
    "- For Science candidates, `publication` is the actual publication or journal only when reliably identified.",
    "- If `publication` is non-null, treat it as the more reliable publication signal.",
    "- If `publication` is null, do not guess journal prestige.",
    "- Do not treat Nature subject feed names, such as Nature: Chemistry or Nature: Biotechnology, as the article's true journal.",
    "",
    "Do not:",
    "- Compare candidates across categories.",
    "- Rank only by publication time.",
    "- Rank solely because a source is authoritative.",
    "- Rank solely because a title sounds important.",
    "- Overemphasize breaking-news tone when information value is limited.",
    "- Distribute ranks for source diversity.",
    "",
    "Output rules:",
    "- Return a single `ordered_ids` array; its order is the final ranking.",
    "- `ordered_ids[0]` is rank 1, `ordered_ids[1]` is rank 2, and so on.",
    "- Use exact input candidate IDs; do not invent or modify IDs.",
    "- Include every input candidate ID exactly once.",
    "- Do not duplicate IDs.",
    "- Do not output `reason`, prose, or any field other than `ordered_ids`.",
  ].join("\n");
}

export function buildStage3DigestRankingUserPrompt(input: Stage3DigestRankingInput): string {
  return JSON.stringify(input, null, 2);
}
