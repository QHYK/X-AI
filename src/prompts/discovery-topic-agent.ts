/** Dynamic business input and historical metadata only; Prompt text is loaded from the database. */
import type { DiscoveryTopicLead } from '../discovery/topic-selection.js';
export { DISCOVERY_EDITORIAL_PROMPT_VERSION } from './discovery-topic-selection.js';
export const DISCOVERY_D3_PROMPT_VERSION = 'v3';
export function buildDiscoveryD3UserPrompt(
  topicLeads: DiscoveryTopicLead[],
  memory: unknown = null,
): string {
  return JSON.stringify({
    topics: topicLeads.map((lead) => ({
      leadId: lead.leadId,
      question: lead.question,
      newsContext: lead.newsContext,
      sourceContentIds: lead.sourceContentIds,
    })),
    memory,
  });
}
