import { productionPrompt } from '../lib/prompts/runtime.js';
/**
 * Stage 1 Content Understanding 的 LLM 调用层。
 * 将 batch 输入、Prompt 和严格 Schema 校验串联，并在可恢复错误上执行有限重试。
 */
import {
  buildStage1BatchInput,
  parseAndValidateStage1BatchOutput,
  stage1BatchOutputJsonSchema,
  validateStage1Assignments,
  type Stage1ArticleRow,
  type Stage1BatchInput,
  type Stage1BatchOutput,
} from './stage1-contract.js';
import {
  buildStage1UserPrompt,
} from '../prompts/stage1-content-understanding.js';
import {
  createLlmClient,
  resolveLlmModel,
  resolveStageLlmModel,
  resolveStageLlmProvider,
  type LlmProvider,
} from './llm-client.js';
import { resolveStageLlmRuntimeConfig } from './stage-llm-runtime-config.js';
import {
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  missingLlmTokenUsage,
  usageFromProvider,
  type LlmTokenUsage,
} from './llm-token-usage.js';

export type Stage1LlmOptions = {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  onAttempt?: (event: {
    attempt: number;
    provider: LlmProvider;
    status: 'success' | 'failed';
    errorType: string | null;
    error: string | null;
    durationMs: number;
  }) => void | Promise<void>;
};

export type Stage1LlmSuccess = {
  success: true;
  input: Stage1BatchInput;
  output: Stage1BatchOutput;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage1TokenUsage | null;
  rawOutputText: string;
};

export type Stage1LlmFailure = {
  success: false;
  input: Stage1BatchInput;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage1TokenUsage | null;
  error: string;
  rawOutputText: string | null;
};

export type Stage1LlmResult = Stage1LlmSuccess | Stage1LlmFailure;

export type Stage1TokenUsage = LlmTokenUsage;

const HTTP_503_RETRY_DELAY_MS = 10_000;
const MAX_OUTPUT_TOKENS_PER_ARTICLE = 1_200;

/**
 * 处理一个 Stage 1 micro-batch，累计 token 与尝试次数后返回可持久化的验证结果。
 * 明确的 HTTP 503 使用更长等待，但仍受既有 maxRetries 上限约束。
 */
export async function runStage1BatchLlm(
  articles: Stage1ArticleRow[],
  options: Stage1LlmOptions = {},
): Promise<Stage1LlmResult> {
  if (articles.length === 0) {
    throw new Error('Stage 1 LLM batch must contain at least one article.');
  }

  return runStage1BatchLlmForInput(buildStage1BatchInput(articles), options);
}

/**
 * 使用已冻结的 Stage 1 batch 输入执行正式的 Prompt、LLM 与校验流程。
 * Evaluation 通过此入口避免重新读取数据库或复制生产调用逻辑。
 */
export async function runStage1BatchLlmForInput(
  input: Stage1BatchInput,
  options: Stage1LlmOptions = {},
): Promise<Stage1LlmResult> {
  if (input.articles.length === 0) {
    throw new Error('Stage 1 LLM batch must contain at least one article.');
  }

  const provider = options.provider ?? resolveStageLlmProvider('stage1');
  const model =
    options.model ??
    (options.provider ? resolveLlmModel(undefined, provider) : resolveStageLlmModel('stage1'));
  const runtimeConfig = resolveStageLlmRuntimeConfig('stage1');
  const timeoutMs = options.timeoutMs ?? runtimeConfig.timeoutMs;
  const maxRetries = options.maxRetries ?? runtimeConfig.maxRetries;
  const startedAt = Date.now();
  let tokenUsage = emptyLlmTokenUsage();

  let rawOutputText: string | null = null;
  let lastError = 'Unknown Stage 1 LLM failure.';
  let attemptsUsed = 0;
  const prompt = await productionPrompt(
    'daily.stage1.content_understanding',
    buildStage1UserPrompt(input),
  );
  let client: ReturnType<typeof createLlmClient>;
  try {
    client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  } catch (error) {
    lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
    await options.onAttempt?.({
      attempt: 0,
      provider,
      status: 'failed',
      errorType: 'configuration_error',
      error: lastError,
      durationMs: Date.now() - startedAt,
    });
    return {
      success: false,
      input,
      model,
      promptVersion: prompt.versionId,
      attempts: 0,
      elapsedMs: Date.now() - startedAt,
      tokenUsage: null,
      error: lastError,
      rawOutputText,
    };
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    const attemptStartedAt = Date.now();
    try {
      const response = await client.structured.create(
        {
          model,
          ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: prompt.input,
                },
              ],
            },
          ],
          max_output_tokens: MAX_OUTPUT_TOKENS_PER_ARTICLE * input.articles.length,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: 'stage1_content_understanding_batch',
              description: 'Independent Stage 1 results for a batch of articles.',
              schema: stage1BatchOutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      tokenUsage = mergeLlmTokenUsage(tokenUsage, usageFromProvider(response.usage));
      rawOutputText = response.output_text;
      const validation = parseAndValidateStage1BatchOutput(rawOutputText);
      if (!validation.success) {
        lastError = `Structured output validation failed: ${validation.errors.join('; ')}`;
        await options.onAttempt?.({
          attempt,
          provider,
          status: 'failed',
          errorType: 'structured_output_validation',
          error: lastError,
          durationMs: Date.now() - attemptStartedAt,
        });
        if (attempt <= maxRetries) {
          await sleep(runtimeConfig.retryDelayMs * attempt);
          continue;
        }

        break;
      }

      const assignment = validateStage1Assignments(validation.output, input);
      if (!assignment.passed) {
        lastError = `Assignment integrity validation failed: ${assignment.errors.join('; ')}`;
        await options.onAttempt?.({
          attempt,
          provider,
          status: 'failed',
          errorType: 'assignment_validation',
          error: lastError,
          durationMs: Date.now() - attemptStartedAt,
        });
        if (attempt <= maxRetries) {
          await sleep(runtimeConfig.retryDelayMs * attempt);
          continue;
        }

        break;
      }

      await options.onAttempt?.({
        attempt,
        provider,
        status: 'success',
        errorType: null,
        error: null,
        durationMs: Date.now() - attemptStartedAt,
      });

      return {
        success: true,
        input,
        output: validation.output,
        model,
        promptVersion: prompt.versionId,
        responseId: response.id,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        tokenUsage,
        rawOutputText,
      };
    } catch (error) {
      tokenUsage = mergeLlmTokenUsage(tokenUsage, missingLlmTokenUsage());
      lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
      await options.onAttempt?.({
        attempt,
        provider,
        status: 'failed',
        errorType: getHttpStatus(error)?.toString() ?? 'request_error',
        error: lastError,
        durationMs: Date.now() - attemptStartedAt,
      });
      if (isNonRetryableLlmError(lastError)) {
        break;
      }

      if (attempt <= maxRetries) {
        if (getHttpStatus(error) === 503) {
          console.warn('Stage 1 LLM returned 503; waiting 10s before retrying...');
          await sleep(HTTP_503_RETRY_DELAY_MS);
        } else {
          await sleep(runtimeConfig.retryDelayMs * attempt);
        }
        continue;
      }
    }
  }

  return {
    success: false,
    input,
    model,
    promptVersion: prompt.versionId,
    attempts: attemptsUsed,
    elapsedMs: Date.now() - startedAt,
    tokenUsage: attemptsUsed > 0 ? tokenUsage : null,
    error: lastError,
    rawOutputText,
  };
}

function isNonRetryableLlmError(errorMessage: string): boolean {
  return (
    errorMessage.includes('401') ||
    errorMessage.includes('Incorrect API key') ||
    errorMessage.includes('invalid_api_key')
  );
}

function sanitizeLlmError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, '[redacted_api_key]');
}

function getHttpStatus(error: unknown): number | null {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'object' && 'status' in current) {
      const status = (current as { status?: unknown }).status;
      if (typeof status === 'number') {
        return status;
      }
    }
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
