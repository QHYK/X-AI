import {
  buildStage1BatchInput,
  parseAndValidateStage1BatchOutput,
  stage1BatchOutputJsonSchema,
  validateStage1Assignments,
  type Stage1ArticleRow,
  type Stage1BatchInput,
  type Stage1BatchOutput,
} from "./stage1-contract.js";
import {
  buildStage1Instructions,
  buildStage1UserPrompt,
  STAGE1_PROMPT_VERSION,
} from "../prompts/stage1-content-understanding.js";
import {
  createLlmClient,
  resolveStageLlmModel,
  resolveStageLlmProvider,
} from "./llm-client.js";

export type Stage1LlmOptions = {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
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

export type Stage1TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE1_LLM_TIMEOUT_MS ?? 45_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE1_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE1_LLM_RETRY_DELAY_MS ?? 1_000);
const MAX_OUTPUT_TOKENS_PER_ARTICLE = 1_200;

export async function runStage1BatchLlm(
  articles: Stage1ArticleRow[],
  options: Stage1LlmOptions = {},
): Promise<Stage1LlmResult> {
  if (articles.length === 0) {
    throw new Error("Stage 1 LLM batch must contain at least one article.");
  }

  const input = buildStage1BatchInput(articles);
  const provider = resolveStageLlmProvider("stage1");
  const model = resolveStageLlmModel("stage1", options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  const tokenUsage: Stage1TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let hasTokenUsage = false;

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 1 LLM failure.";
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const response = await client.responses.create(
        {
          model,
          instructions: buildStage1Instructions(),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildStage1UserPrompt(input),
                },
              ],
            },
          ],
          max_output_tokens: MAX_OUTPUT_TOKENS_PER_ARTICLE * articles.length,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage1_content_understanding_batch",
              description: "Independent Stage 1 results for a batch of articles.",
              schema: stage1BatchOutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      if (response.usage) {
        tokenUsage.inputTokens += response.usage.input_tokens;
        tokenUsage.outputTokens += response.usage.output_tokens;
        tokenUsage.totalTokens += response.usage.total_tokens;
        hasTokenUsage = true;
      }
      rawOutputText = response.output_text;
      const validation = parseAndValidateStage1BatchOutput(rawOutputText);
      if (!validation.success) {
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const assignment = validateStage1Assignments(validation.output, input);
      if (!assignment.passed) {
        lastError = `Assignment integrity validation failed: ${assignment.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      return {
        success: true,
        input,
        output: validation.output,
        model,
        promptVersion: STAGE1_PROMPT_VERSION,
        responseId: response.id,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        tokenUsage: hasTokenUsage ? tokenUsage : null,
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
    promptVersion: STAGE1_PROMPT_VERSION,
    attempts: attemptsUsed,
    elapsedMs: Date.now() - startedAt,
    tokenUsage: hasTokenUsage ? tokenUsage : null,
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
