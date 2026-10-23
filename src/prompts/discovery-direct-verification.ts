/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
export { DISCOVERY_EDITORIAL_PROMPT_VERSION } from './discovery-topic-selection.js';
export const DISCOVERY_D4_PROMPT_VERSION = 'v4';
export type DiscoveryD4PromptCandidate = {
  candidateId: string;
  title: string;
  author: string | null;
  publication: string;
  publishedAt: string | null;
  url: string;
  contentSource: 'full_content_text' | 'content_text';
  contentMayBeIncomplete: boolean;
  estimatedDurationMinutes: number | null;
  content: string;
};
export function buildDiscoveryD4UserPrompt(candidates: DiscoveryD4PromptCandidate[]): string {
  return JSON.stringify({ candidates });
}
