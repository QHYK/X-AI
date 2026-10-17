import type {
  DiscoveryBranchExecutionState,
  DiscoveryStage,
  DiscoveryStageUsage,
} from '../db/schema.js';
import type { LlmResponse } from '../processing/llm-client.js';

export type DiscoveryStageMetadata = {
  provider: string | null;
  model: string | null;
  apiMode: string | null;
};

export function emptyDiscoveryStageUsage(): DiscoveryStageUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    usageComplete: true,
  };
}

export function unknownDiscoveryStageUsage(): DiscoveryStageUsage {
  return {
    requests: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    usageComplete: false,
  };
}

export function usageFromLlmResponse(
  usage: LlmResponse['usage'] | null | undefined,
): DiscoveryStageUsage {
  if (!usage) return missingDiscoveryStageUsage();
  const inputTokens = nonNegativeInteger(usage.input_tokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens);
  const cachedInputTokens = nonNegativeInteger(usage.cached_input_tokens);
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usageComplete: inputTokens !== null && outputTokens !== null && cachedInputTokens !== null,
  };
}

/** Normalizes the Responses/Agents SDK usage shape without treating absent fields as zero. */
export function usageFromAgentResponseUsage(usage: unknown): DiscoveryStageUsage {
  if (!isRecord(usage)) return missingDiscoveryStageUsage();
  const inputTokens = nonNegativeInteger(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = nonNegativeInteger(usage.output_tokens ?? usage.outputTokens);
  const details = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : isRecord(usage.inputTokensDetails)
      ? usage.inputTokensDetails
      : null;
  const cachedInputTokens = details
    ? nonNegativeInteger(details.cached_tokens ?? details.cachedTokens)
    : null;
  return {
    requests: 1,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usageComplete: inputTokens !== null && outputTokens !== null && cachedInputTokens !== null,
  };
}

/** A model request was started but the provider supplied no usable usage payload. */
export function missingDiscoveryStageUsage(): DiscoveryStageUsage {
  return {
    requests: 1,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    usageComplete: false,
  };
}

export function mergeDiscoveryStageUsage(
  prior: DiscoveryStageUsage,
  current: DiscoveryStageUsage,
): DiscoveryStageUsage {
  return {
    requests: sumMaybe(prior.requests, current.requests),
    inputTokens: sumKnown(prior.inputTokens, current.inputTokens),
    outputTokens: sumKnown(prior.outputTokens, current.outputTokens),
    cachedInputTokens:
      prior.cachedInputTokens === null || current.cachedInputTokens === null
        ? null
        : prior.cachedInputTokens + current.cachedInputTokens,
    usageComplete: prior.usageComplete && current.usageComplete,
  };
}

/** Cache rate is only meaningful when every request supplied complete usage. */
export function discoveryCacheHitRate(usage: DiscoveryStageUsage): number | null {
  if (!usage.usageComplete || usage.inputTokens === null || usage.cachedInputTokens === null) {
    return null;
  }
  return usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null;
}

export function initialDiscoveryStageState(
  existing: DiscoveryBranchExecutionState | undefined,
  hasHistoricConfig: boolean,
): Pick<DiscoveryBranchExecutionState, 'usage' | 'elapsedMs'> {
  if (existing) {
    return {
      usage: normalizeDiscoveryStageUsage(existing.usage),
      elapsedMs:
        typeof existing.elapsedMs === 'number' && existing.elapsedMs >= 0
          ? existing.elapsedMs
          : null,
    };
  }
  return {
    usage: hasHistoricConfig ? unknownDiscoveryStageUsage() : emptyDiscoveryStageUsage(),
    elapsedMs: hasHistoricConfig ? null : 0,
  };
}

export function buildDiscoveryStageState(input: {
  status: DiscoveryBranchExecutionState['status'];
  endReason: DiscoveryBranchExecutionState['endReason'];
  errorSummary: string | null;
  metadata: DiscoveryStageMetadata;
  prior: Pick<DiscoveryBranchExecutionState, 'usage' | 'elapsedMs'>;
  attemptUsage?: DiscoveryStageUsage;
  attemptElapsedMs?: number;
  completedAt?: string | null;
}): DiscoveryBranchExecutionState {
  return {
    status: input.status,
    endReason: input.endReason,
    completedAt: input.completedAt ?? null,
    errorSummary: input.errorSummary,
    provider: input.metadata.provider,
    model: input.metadata.model,
    apiMode: input.metadata.apiMode,
    elapsedMs:
      input.attemptElapsedMs === undefined
        ? input.prior.elapsedMs
        : sumMaybe(input.prior.elapsedMs, input.attemptElapsedMs),
    usage: input.attemptUsage
      ? mergeDiscoveryStageUsage(input.prior.usage, input.attemptUsage)
      : input.prior.usage,
  };
}

export function normalizeDiscoveryStageUsage(value: unknown): DiscoveryStageUsage {
  if (!isRecord(value)) return unknownDiscoveryStageUsage();
  const requests = nonNegativeInteger(value.requests);
  const inputTokens = nonNegativeInteger(value.inputTokens);
  const outputTokens = nonNegativeInteger(value.outputTokens);
  const cachedInputTokens = nonNegativeInteger(value.cachedInputTokens);
  return {
    requests,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    usageComplete:
      value.usageComplete === true &&
      requests !== null &&
      inputTokens !== null &&
      outputTokens !== null &&
      cachedInputTokens !== null,
  };
}

export function stageHasHistoricConfig(configSnapshot: unknown, stage: DiscoveryStage): boolean {
  return isRecord(configSnapshot) && Object.hasOwn(configSnapshot, stage);
}

function sumMaybe(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

/** Preserve known partial usage but flag it with usageComplete=false. */
function sumKnown(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
