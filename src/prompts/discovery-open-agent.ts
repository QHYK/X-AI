/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
export { DISCOVERY_EDITORIAL_PROMPT_VERSION } from './discovery-topic-selection.js';
export const DISCOVERY_D5_PROMPT_VERSION = 'v2';
export function buildDiscoveryD5UserPrompt(memory: unknown = null, manualContext?: string): string {
  return JSON.stringify({
    memory,
    manualContext: manualContext?.trim() || null,
  });
}
