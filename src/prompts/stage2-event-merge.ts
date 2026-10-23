/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
import type { Stage2Input } from '../processing/stage2-contract.js';
export const STAGE2_PROMPT_VERSION = 'v4';
export function buildStage2UserPrompt(input: Stage2Input): string {
  return JSON.stringify(input, null, 2);
}
