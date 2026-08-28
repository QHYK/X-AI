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
} from "./llm-client.js";
import {
  stage2OutputJsonSchema,
  type Stage2Input,
  type Stage2Output,
} from "./stage2-contract.js";
import {
  buildStage2Instructions,
  buildStage2UserPrompt,
  STAGE2_PROMPT_VERSION,
} from "../prompts/stage2-event-merge.js";

export type Stage2LlmOptions = {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type Stage2TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

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
};

export type Stage2LlmResult = Stage2LlmSuccess | Stage2LlmFailure;

const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE2_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE2_LLM_MAX_RETRIES ?? 0);
const DEFAULT_MAX_OUTPUT_TOKENS = Number(
  process.env.STAGE2_LLM_MAX_OUTPUT_TOKENS ?? 32_000,
);
const RETRY_DELAY_MS = Number(process.env.STAGE2_LLM_RETRY_DELAY_MS ?? 1_000);

/** 调用模型将 Event candidates 归并为真实世界事件组。 */
export async function runStage2MergeLlm(
  input: Stage2Input,
  options: Stage2LlmOptions = {},
): Promise<Stage2LlmResult> {
  const provider = options.provider ?? resolveStageLlmProvider("stage2");
  const model = options.model ?? (
    options.provider
      ? resolveLlmModel(undefined, provider)
      : resolveStageLlmModel("stage2")
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 2 LLM failure.";
  let attemptsUsed = 0;
  let tokenUsage: Stage2TokenUsage | null = null;
  let finishReason: string | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const response = await client.responses.create(
        {
          model,
          instructions: buildStage2Instructions(),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildStage2UserPrompt(input),
                },
              ],
            },
          ],
          max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage2_event_merge",
              description: "Structured Stage 2 event groups.",
              schema: stage2OutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      rawOutputText = response.output_text;
      tokenUsage = response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : null;
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
        tokenUsage,
        finishReason,
        rawOutputText,
      };
    } catch (error) {
      lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
      if (isNonRetryableLlmError(lastError)) {
        break;
      }

      if (attempt <= maxRetries) {
        await sleep(RETRY_DELAY_MS * attempt);
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
    tokenUsage,
    finishReason,
    error: lastError,
    rawOutputText,
  };
}

function isNonRetryableLlmError(errorMessage: string): boolean {
  return (
    errorMessage.includes("401") ||
    errorMessage.includes("Incorrect API key") ||
    errorMessage.includes("invalid_api_key")
  );
}

function sanitizeLlmError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted_api_key]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
