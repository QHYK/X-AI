/** Frozen pre-B3.4 request texts; never derives the legacy reference from Seed or the database. */
import baseline from './legacy-prompt-baseline.json' with { type: 'json' };
const requests = baseline.requests as Record<
  string,
  Record<string, { instructions?: string; user: string }>
>;
function instructions(key: string, variant = 'default'): string {
  const text = requests[key]?.[variant]?.instructions;
  if (text === undefined) throw new Error(`Missing legacy Prompt fixture: ${key}/${variant}`);
  return text;
}
export const buildStage1Instructions = () => instructions('daily.stage1.content_understanding');
export const buildStage2Instructions = () => instructions('daily.stage2.event_merge');
export const buildStage3EventRankingInstructions = () => instructions('daily.stage3.event_ranking');
export const buildStage3DigestRankingInstructions = (category: string) =>
  instructions('daily.stage3.digest_ranking', category);
export const buildStage3LongFormRankingInstructions = () =>
  instructions('daily.stage3.long_form_ranking');
export const buildStage4EventEnrichmentInstructions = (
  options: { webSearchAvailable?: boolean } = {},
) =>
  instructions(
    'daily.stage4.event_enrichment',
    options.webSearchAvailable ? 'with_search' : 'without_search',
  );
export const STAGE4_CONTEXT_DECISION_INSTRUCTIONS = instructions(
  'daily.stage4.external_context_decision',
);
export const buildDiscoveryD2Instructions = () => instructions('discovery.d2.topic_selection');
export const buildDiscoveryD3Instructions = () => instructions('discovery.d3.topic_discovery');
export const buildDiscoveryD4Instructions = () => instructions('discovery.d4.direct_verification');
export const buildDiscoveryD5Instructions = () => instructions('discovery.d5.open_discovery');
export const IN_DEPTH_INTRODUCTION_PROMPT = instructions('in_depth.editorial.introduction');
export const buildManualInDepthInstructions = () => instructions('in_depth.manual.generate');
export const DIGEST_PUT_BACK_PROMPT = instructions('daily.editorial.digest_put_back');
export const buildReadMoreInstructions = () => instructions('daily.read_more.detailed_summary');
export const buildReadMoreUserPrompt = (input: string) =>
  requests['daily.read_more.detailed_summary'].default.user.replace('{{input}}', () => input);
