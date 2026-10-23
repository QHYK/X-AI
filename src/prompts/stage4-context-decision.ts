/** Static migration reference only; production reads the Registry. */
export const STAGE4_CONTEXT_DECISION_INSTRUCTIONS = [
  'Decide whether external web context is necessary before enriching this event.',
  'Return need_external_context=true only when a critical fact is missing from the provided reports and that gap would materially impair understanding: necessary background, a latest development that cannot be determined, important factual conflict, or needed authoritative confirmation.',
  'Do not request search merely because more facts may exist. If the reports already explain what happened, needed background, why it matters, and material source differences, return false.',
].join('\n');
