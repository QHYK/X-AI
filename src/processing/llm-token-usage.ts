/**
 * Provider-reported token usage for one or more actual LLM requests.
 * Cached input tokens are already part of inputTokens and must never be added
 * to totalTokens.
 */
export type LlmTokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  /** False when any attempted request did not supply all required usage fields. */
  usageComplete: boolean;
};

type ProviderUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
  cached_input_tokens?: unknown;
};

export function usageFromProvider(usage: ProviderUsage | null | undefined): LlmTokenUsage {
  if (!usage) return missingLlmTokenUsage();
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const totalTokens = nonNegativeInteger(usage.total_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cached_input_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    usageComplete:
      inputTokens !== null &&
      outputTokens !== null &&
      totalTokens !== null &&
      cachedInputTokens !== null,
  };
}

/** A request was attempted, but no provider usage payload was available. */
export function missingLlmTokenUsage(): LlmTokenUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    usageComplete: false,
  };
}

export function emptyLlmTokenUsage(): LlmTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    usageComplete: true,
  };
}

/** Keeps known sums while marking a stage incomplete when any request is unknown. */
export function mergeLlmTokenUsage(left: LlmTokenUsage, right: LlmTokenUsage): LlmTokenUsage {
  return {
    inputTokens: sumKnown(left.inputTokens, right.inputTokens),
    outputTokens: sumKnown(left.outputTokens, right.outputTokens),
    totalTokens: sumKnown(left.totalTokens, right.totalTokens),
    cachedInputTokens:
      left.cachedInputTokens === null || right.cachedInputTokens === null
        ? null
        : left.cachedInputTokens + right.cachedInputTokens,
    usageComplete: left.usageComplete && right.usageComplete,
  };
}

export function cacheHitRate(usage: LlmTokenUsage | null): number | null {
  if (!usage?.usageComplete || usage.inputTokens === null || usage.cachedInputTokens === null) {
    return null;
  }
  return usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null;
}

function sumKnown(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
