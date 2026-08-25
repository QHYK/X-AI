/**
 * Stage 3 Digest 排名修复 Prompt builder。
 * 仅在初次结果遗漏或重复候选 ID 时使用，目标是恢复完整排列而非重新排名全部内容。
 */
import type { Stage3DigestRankingCandidate } from "./stage3-digest-ranking.js";

export type Stage3DigestRepairInput = {
  category: string;
  ranked_candidates: Stage3DigestRankingCandidate[];
  missing_candidates: Stage3DigestRankingCandidate[];
  duplicate_ids: string[];
};

export const STAGE3_DIGEST_REPAIR_PROMPT_VERSION = "v2";

/** 构造保持既有相对顺序的轻量修复指令。 */
export function buildStage3DigestRepairInstructions(): string {
  return [
    "You are repairing an incomplete Source Digest ranking.",
    "Use the existing ranking as the baseline.",
    "Evaluate the missing candidates using the same ranking criteria,",
    "then insert them into their appropriate positions.",
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
    "- Use exact input candidate IDs; do not invent or modify IDs.",
    "- Include every ranked and missing candidate ID exactly once.",
    "- Remove duplicate occurrences.",
    "- Preserve the existing relative order unless moving an existing item is clearly necessary to produce a coherent ranking after inserting the missing candidates.",
    "- The primary goal is to repair completeness, not to re-rank the list from scratch.",
    "- Preserve the existing relative order as much as possible.",
    "- Insert missing IDs into the most appropriate positions.",
    "- Do not output `reason`, prose, or any field other than `ordered_ids`.",
  ].join("\n");
}

export function buildStage3DigestRepairUserPrompt(input: Stage3DigestRepairInput): string {
  return JSON.stringify(input, null, 2);
}
