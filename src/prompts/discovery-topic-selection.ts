/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
import type { DiscoveryWindowInput } from '../discovery/daily-read-adapter.js';
export const DISCOVERY_EDITORIAL_PROMPT_VERSION = 'v1';
export const DISCOVERY_D2_PROMPT_VERSION = 'v2';
export function buildDiscoveryD2UserPrompt(
  input: DiscoveryWindowInput,
  memoryContext?: string,
): string {
  const contents = input.days.flatMap((day) =>
    [...day.events, ...day.digests, ...day.longForm].map((item) => ({
      contentId: item.id,
      contentType: item.kind === 'event' ? 'event' : 'processed_content',
      title: item.title,
      summary_zh: item.summaryZh ?? item.summary,
      tags: item.tagsZh.length > 0 ? item.tagsZh : item.tags,
      source_name: item.sources.join(', '),
      directEligible: item.directEligible,
    })),
  );
  return JSON.stringify({ contents, ...(memoryContext ? { memory: memoryContext } : {}) });
}
