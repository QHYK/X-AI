import { createOpenAiClient } from "./openai-client.js";
import {
  parseAndValidateStage2Output,
  stage2OutputJsonSchema,
  validateStage2Assignments,
  type Stage2Input,
  type Stage2Output,
} from "./stage2-contract.js";
import {
  buildStage2Instructions,
  buildStage2UserPrompt,
  STAGE2_PROMPT_VERSION,
} from "../prompts/stage2-event-merge.js";

export type Stage2LlmOptions = {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
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
  rawOutputText: string;
};

export type Stage2LlmFailure = {
  success: false;
  input: Stage2Input;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  error: string;
  rawOutputText: string | null;
};

export type Stage2LlmResult = Stage2LlmSuccess | Stage2LlmFailure;

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE2_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE2_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE2_LLM_RETRY_DELAY_MS ?? 1_000);

export async function runStage2MergeLlm(
  input: Stage2Input,
  options: Stage2LlmOptions = {},
): Promise<Stage2LlmResult> {
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createOpenAiClient({ timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 2 LLM failure.";
  let attemptsUsed = 0;

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
          max_output_tokens: 4_000,
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
      const validation = parseAndValidateStage2Output(rawOutputText);
      if (!validation.success) {
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const assignment = validateStage2Assignments(validation.output, input);
      if (!assignment.passed) {
        lastError = `Candidate assignment validation failed: ${assignment.errors.join("; ")}`;
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
        promptVersion: STAGE2_PROMPT_VERSION,
        responseId: response.id,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
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
