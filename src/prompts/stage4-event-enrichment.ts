/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
export type Stage4EventSourceInput = {
  title: string;
  summary: string;
  entities: string[];
  source: string;
  url: string | null;
};
export type Stage4EventEnrichmentInput = {
  event_hint: string;
  sources: Stage4EventSourceInput[];
};
export const STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION = 'v7';
export function buildStage4EventEnrichmentUserPrompt(input: Stage4EventEnrichmentInput): string {
  return JSON.stringify(input, null, 2);
}
