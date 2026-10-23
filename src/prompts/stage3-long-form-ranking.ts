/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
export type Stage3LongFormRankingCandidate = {
  id: string;
  title: string;
  summary: string;
  source: string;
};
export type Stage3LongFormRankingInput = {
  candidates: Stage3LongFormRankingCandidate[];
};
export const STAGE3_LONG_FORM_RANKING_PROMPT_VERSION = 'v1';
export function buildStage3LongFormRankingUserPrompt(input: Stage3LongFormRankingInput): string {
  return JSON.stringify(input, null, 2);
}
