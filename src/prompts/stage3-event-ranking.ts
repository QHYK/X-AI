/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
import type { Stage3EventRankingInput } from '../processing/stage3-contract.js';
export const STAGE3_EVENT_RANKING_PROMPT_VERSION = 'v3';
export function buildStage3EventRankingUserPrompt(input: Stage3EventRankingInput): string {
  return JSON.stringify(input, null, 2);
}
