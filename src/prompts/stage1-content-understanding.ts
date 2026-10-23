/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
import type { Stage1BatchInput } from '../processing/stage1-contract.js';
export const STAGE1_PROMPT_VERSION = 'v5';
export function buildStage1UserPrompt(input: Stage1BatchInput): string {
  return JSON.stringify(input, null, 2);
}
