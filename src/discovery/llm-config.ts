import { resolveLlmProvider, type LlmProvider } from '../processing/llm-client.js';

export type DiscoveryLlmStage = 'd2' | 'd4';

/**
 * Discovery selects only a provider. Model, endpoint and credentials remain
 * the responsibility of the shared LLM provider configuration.
 */
export function resolveDiscoveryLlmProvider(
  stage: DiscoveryLlmStage,
  explicitProvider?: LlmProvider,
  environment: Record<string, string | undefined> = process.env,
): LlmProvider {
  if (explicitProvider) return explicitProvider;
  return resolveLlmProvider(
    configuredValue(environment[`DISCOVERY_${stage.toUpperCase()}_PROVIDER`]) ??
      configuredValue(environment.DISCOVERY_LLM_PROVIDER) ??
      environment.LLM_PROVIDER,
  );
}

/**
 * Discovery does not define its own timeout when no Discovery environment
 * variable (or explicit caller override) is configured. That deliberately
 * leaves timeout selection to the shared LLM client's SDK default.
 */
export function resolveDiscoveryLlmTimeout(
  stage: DiscoveryLlmStage,
  explicitTimeoutMs?: number,
  environment: Record<string, string | undefined> = process.env,
): number | undefined {
  if (explicitTimeoutMs !== undefined) {
    return requirePositiveIntegerTimeout(explicitTimeoutMs, 'explicit Discovery timeout');
  }

  return (
    parseConfiguredTimeout(
      environment[`DISCOVERY_${stage.toUpperCase()}_TIMEOUT_MS`],
      `DISCOVERY_${stage.toUpperCase()}_TIMEOUT_MS`,
    ) ?? parseConfiguredTimeout(environment.DISCOVERY_LLM_TIMEOUT_MS, 'DISCOVERY_LLM_TIMEOUT_MS')
  );
}

/**
 * The OpenAI SDK treats an explicitly-present `timeout: undefined` as an
 * invalid timeout. Omit it entirely when Discovery has no explicit timeout.
 */
export function toDiscoveryRequestOptions(timeoutMs?: number): { timeout?: number } {
  if (timeoutMs === undefined) return {};
  return { timeout: requirePositiveIntegerTimeout(timeoutMs, 'Discovery LLM timeout') };
}

function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseConfiguredTimeout(value: string | undefined, name: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer in milliseconds.`);
  }
  return requirePositiveIntegerTimeout(Number(trimmed), name);
}

function requirePositiveIntegerTimeout(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds.`);
  }
  return value;
}
