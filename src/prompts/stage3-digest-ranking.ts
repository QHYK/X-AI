/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
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
export const STAGE3_DIGEST_RANKING_PROMPT_VERSION = 'v3';
export function buildStage3DigestRankingUserPrompt(input: Stage3DigestRankingInput): string {
  return JSON.stringify(input, null, 2);
}
