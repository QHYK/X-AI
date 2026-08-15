import {
  buildStage1Input,
  parseAndValidateStage1Output,
  stage1OutputJsonSchema,
  type Stage1ArticleRow,
  type Stage1Input,
  type Stage1Output,
} from "./stage1-contract.js";
import {
  buildStage1Instructions,
  buildStage1UserPrompt,
  STAGE1_PROMPT_VERSION,
} from "../prompts/stage1-content-understanding.js";
import { createOpenAiClient } from "./openai-client.js";

export type Stage1LlmOptions = {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type Stage1LlmSuccess = {
  success: true;
  input: Stage1Input;
  output: Stage1Output;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  rawOutputText: string;
};

export type Stage1LlmFailure = {
  success: false;
  input: Stage1Input;
  model: string;
  promptVersion: string;
  attempts: number;
  error: string;
  rawOutputText: string | null;
};

export type Stage1LlmResult = Stage1LlmSuccess | Stage1LlmFailure;

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE1_LLM_TIMEOUT_MS ?? 45_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE1_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE1_LLM_RETRY_DELAY_MS ?? 1_000);

export async function runStage1Llm(
  article: Stage1ArticleRow,
  options: Stage1LlmOptions = {},
): Promise<Stage1LlmResult> {
  const input = buildStage1Input(article);
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createOpenAiClient({ timeoutMs, maxRetries: 0 });

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
          max_output_tokens: 1_200,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage1_content_understanding",
              description: "Structured Stage 1 content understanding and selection output.",
              schema: stage1OutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      rawOutputText = response.output_text;
      const validation = parseAndValidateStage1Output(rawOutputText);
      if (!validation.success) {
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
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
    error: lastError,
    rawOutputText,
  };
}

export const runStage1LlmValidation = runStage1Llm;

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
