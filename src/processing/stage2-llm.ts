/**
 * Stage 2 Event Merge 的 LLM 调用层。
 * 负责 Provider 调用、重试与运行诊断；分组完整性由 job 层记录并交给后续 Stage 使用。
 */
import {
  createLlmClient,
  resolveLlmModel,
  resolveStageLlmModel,
  resolveStageLlmProvider,
  type LlmProvider,
  type LlmResponse,
} from './llm-client.js';
import { stage2OutputJsonSchema, type Stage2Input, type Stage2Output } from './stage2-contract.js';
import {
  buildStage2Instructions,
  buildStage2UserPrompt,
  STAGE2_PROMPT_VERSION,
} from '../prompts/stage2-event-merge.js';
import {
  resolveStage2MaxOutputTokens,
  resolveStageLlmRuntimeConfig,
} from './stage-llm-runtime-config.js';
import {
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  missingLlmTokenUsage,
  usageFromProvider,
  type LlmTokenUsage,
} from './llm-token-usage.js';

export type Stage2LlmOptions = {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Test seam; production callers use the configured LLM client. */
  request?: (request: Stage2ResponseRequest, options: { timeout?: number }) => Promise<LlmResponse>;
};

type Stage2ResponseRequest = {
  model: string;
  instructions: string;
  input: Array<{ role: string; content: Array<{ type: 'input_text'; text: string }> }>;
  max_output_tokens: number;
  store: boolean;
  text: {
    format: {
      type: 'json_schema';
      name: string;
      description: string;
      schema: typeof stage2OutputJsonSchema;
      strict: boolean;
    };
  };
};

export type Stage2LlmAttempt = {
  attempt: number;
  provider: LlmProvider;
  durationMs: number;
  statusCode: number | null;
  errorCode: string | null;
  errorType: string | null;
  error: string | null;
};

export type Stage2TokenUsage = LlmTokenUsage;

export type Stage2LlmSuccess = {
  success: true;
  input: Stage2Input;
  output: Stage2Output;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage2TokenUsage | null;
  finishReason: string | null;
  rawOutputText: string;
  attemptLog: Stage2LlmAttempt[];
};

export type Stage2LlmFailure = {
  success: false;
  input: Stage2Input;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage2TokenUsage | null;
  finishReason: string | null;
  error: string;
  rawOutputText: string | null;
  attemptLog: Stage2LlmAttempt[];
};

export type Stage2LlmResult = Stage2LlmSuccess | Stage2LlmFailure;

/** Stable fallback value; environment overrides are resolved per request. */
export const DEFAULT_STAGE2_MAX_OUTPUT_TOKENS = 64_000;

/** 调用模型将 Event candidates 归并为真实世界事件组。 */
export async function runStage2MergeLlm(
  input: Stage2Input,
  options: Stage2LlmOptions = {},
): Promise<Stage2LlmResult> {
  const provider = options.provider ?? resolveStageLlmProvider('stage2');
  const model =
    options.model ??
    (options.provider ? resolveLlmModel(undefined, provider) : resolveStageLlmModel('stage2'));
  const runtimeConfig = resolveStageLlmRuntimeConfig('stage2');
  const timeoutMs = options.timeoutMs ?? runtimeConfig.timeoutMs;
  const maxRetries = options.maxRetries ?? runtimeConfig.maxRetries;
  const maxOutputTokens = resolveStage2MaxOutputTokens();
  // SDK retries stay disabled: Stage 2 owns attempt accounting and retry policy.
  const client = options.request ? null : createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const request = options.request ?? client?.responses.create;
  if (!request) {
    throw new Error('Stage 2 LLM request function is unavailable.');
  }
  const startedAt = Date.now();

  let rawOutputText: string | null = null;
  let lastError = 'Unknown Stage 2 LLM failure.';
  let attemptsUsed = 0;
  let tokenUsage = emptyLlmTokenUsage();
  let finishReason: string | null = null;
  const attemptLog: Stage2LlmAttempt[] = [];

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    const attemptStartedAt = Date.now();
    try {
      const response = await request(
        {
          model,
          instructions: buildStage2Instructions(),
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: buildStage2UserPrompt(input),
                },
              ],
            },
          ],
          max_output_tokens: maxOutputTokens,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: 'stage2_event_merge',
              description: 'Structured Stage 2 event groups.',
              schema: stage2OutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      attemptLog.push({
        attempt,
        provider,
        durationMs: Date.now() - attemptStartedAt,
        statusCode: null,
        errorCode: null,
        errorType: null,
        error: null,
      });

      rawOutputText = response.output_text;
      tokenUsage = mergeLlmTokenUsage(tokenUsage, usageFromProvider(response.usage));
      finishReason = response.finish_reason ?? null;

      // Temporary diagnostic mode: keep the provider's Stage 2 grouping even when
      // schema or assignment completeness checks would reject it.
      const output = JSON.parse(rawOutputText) as Stage2Output;

      return {
        success: true,
        input,
        output,
        model,
        promptVersion: STAGE2_PROMPT_VERSION,
        responseId: response.id,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        tokenUsage: attemptsUsed > 0 ? tokenUsage : null,
        finishReason,
        rawOutputText,
        attemptLog,
      };
    } catch (error) {
      tokenUsage = mergeLlmTokenUsage(tokenUsage, missingLlmTokenUsage());
      lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
      const diagnostic = diagnoseLlmError(error, lastError);
      attemptLog.push({
        attempt,
        provider,
        durationMs: Date.now() - attemptStartedAt,
        ...diagnostic,
        error: lastError,
      });
      if (isNonRetryableLlmError(lastError)) {
        break;
      }

      if (attempt <= maxRetries) {
        await sleep(runtimeConfig.retryDelayMs * attempt);
        continue;
      }
    }
  }

  return {
    success: false,
    input,
    model,
    promptVersion: STAGE2_PROMPT_VERSION,
    attempts: attemptsUsed,
    elapsedMs: Date.now() - startedAt,
    tokenUsage: attemptsUsed > 0 ? tokenUsage : null,
    finishReason,
    error: `Attempts: ${attemptsUsed}, Retries: ${Math.max(0, attemptsUsed - 1)}. ${lastError}`,
    rawOutputText,
    attemptLog,
  };
}

function isNonRetryableLlmError(errorMessage: string): boolean {
  return (
    errorMessage.includes('401') ||
    errorMessage.includes('Incorrect API key') ||
    errorMessage.includes('invalid_api_key') ||
    /\bauthentication(?:\s+failed)?\b/i.test(errorMessage) ||
    /\bunauthorized\b/i.test(errorMessage)
  );
}

function diagnoseLlmError(
  error: unknown,
  fallbackMessage: string,
): Omit<Stage2LlmAttempt, 'attempt' | 'provider' | 'durationMs' | 'error'> {
  const message = error instanceof Error ? error.message : fallbackMessage;
  const prefix = 'LLM HTTP request failed: ';
  if (message.startsWith(prefix)) {
    try {
      const diagnostic = JSON.parse(message.slice(prefix.length)) as {
        response?: { status?: unknown; code?: unknown; type?: unknown };
      };
      return {
        statusCode:
          typeof diagnostic.response?.status === 'number' ? diagnostic.response.status : null,
        errorCode: typeof diagnostic.response?.code === 'string' ? diagnostic.response.code : null,
        errorType: typeof diagnostic.response?.type === 'string' ? diagnostic.response.type : null,
      };
    } catch {
      // Preserve the sanitized error even when a proxy returned malformed diagnostic data.
    }
  }

  const value =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; code?: unknown; status?: unknown })
      : {};
  return {
    statusCode: typeof value.status === 'number' ? value.status : null,
    errorCode: typeof value.code === 'string' ? value.code : null,
    errorType: typeof value.name === 'string' ? value.name : null,
  };
}

function sanitizeLlmError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, '[redacted_api_key]');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
