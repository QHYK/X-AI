export type StageLlmName = "stage1" | "stage2" | "stage3" | "stage4";

export type StageLlmRuntimeConfig = {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
};

const defaults: Record<StageLlmName, StageLlmRuntimeConfig> = {
  stage1: { timeoutMs: 45_000, maxRetries: 2, retryDelayMs: 1_000 },
  stage2: { timeoutMs: 240_000, maxRetries: 0, retryDelayMs: 1_000 },
  stage3: { timeoutMs: 240_000, maxRetries: 2, retryDelayMs: 1_000 },
  stage4: { timeoutMs: 240_000, maxRetries: 2, retryDelayMs: 1_000 },
};

/** Resolves runtime-only LLM configuration when a request is about to run. */
export function resolveStageLlmRuntimeConfig(
  stage: StageLlmName,
  environment: NodeJS.ProcessEnv = process.env,
): StageLlmRuntimeConfig {
  const prefix = stage.toUpperCase();
  const fallback = defaults[stage];

  return {
    timeoutMs: Number(environment[`${prefix}_LLM_TIMEOUT_MS`] ?? fallback.timeoutMs),
    maxRetries: Number(environment[`${prefix}_LLM_MAX_RETRIES`] ?? fallback.maxRetries),
    retryDelayMs: Number(environment[`${prefix}_LLM_RETRY_DELAY_MS`] ?? fallback.retryDelayMs),
  };
}

export function resolveStage2MaxOutputTokens(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return Number(environment.STAGE2_LLM_MAX_OUTPUT_TOKENS ?? 64_000);
}
