/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
export type Stage4EventSourceInput = {
  title: string;
  summary: string;
  entities: string[];
  source: string;
  url: string | null;
};
export type Stage4EventEnrichmentInput = {
  recent_events?: Array<{ title: string; summary: string }>;
  event_hint: string;
  sources: Stage4EventSourceInput[];
};
export const STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION = 'v7';
export function buildStage4EventEnrichmentUserPrompt(input: Stage4EventEnrichmentInput): string {
  return JSON.stringify(
    {
      recent_events: input.recent_events ?? [],
      event_hint: input.event_hint,
      sources: input.sources,
    },
    null,
    2,
  );
}
