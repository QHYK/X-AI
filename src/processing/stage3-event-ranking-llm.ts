import { createOpenAiClient } from "./openai-client.js";
import {
  parseAndValidateStage3RankingOutput,
  stage3RankingOutputJsonSchema,
  validateStage3RankingIntegrity,
  type Stage3RankingIntegrity,
  type Stage3RankingOutput,
} from "./stage3-contract.js";
import type { Stage3EventRankingInput } from "./stage3-validation-input.js";
import {
  buildStage3EventRankingInstructions,
  buildStage3EventRankingUserPrompt,
  STAGE3_EVENT_RANKING_PROMPT_VERSION,
} from "../prompts/stage3-event-ranking.js";

export type Stage3EventRankingLlmOptions = {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type Stage3EventRankingSuccess = {
  success: true;
  input: Stage3EventRankingInput;
  output: Stage3RankingOutput;
  assignment: Stage3RankingIntegrity;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  rawOutputText: string;
};

export type Stage3EventRankingFailure = {
  success: false;
  input: Stage3EventRankingInput;
  assignment: Stage3RankingIntegrity | null;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  error: string;
  rawOutputText: string | null;
};

export type Stage3EventRankingResult =
  | Stage3EventRankingSuccess
  | Stage3EventRankingFailure;

const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE3_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE3_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE3_LLM_RETRY_DELAY_MS ?? 1_000);

export async function runStage3EventRankingLlm(
  input: Stage3EventRankingInput,
  options: Stage3EventRankingLlmOptions = {},
): Promise<Stage3EventRankingResult> {
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createOpenAiClient({ timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  const expectedIds = input.events.map((event) => event.id);

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 3 Event Ranking LLM failure.";
  let lastAssignment: Stage3RankingIntegrity | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const response = await client.responses.create(
        {
          model,
          instructions: buildStage3EventRankingInstructions(),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildStage3EventRankingUserPrompt(input),
                },
              ],
            },
          ],
          max_output_tokens: 6_000,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage3_event_ranking",
              description: "Structured Stage 3 event ranking output.",
              schema: stage3RankingOutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      rawOutputText = response.output_text;
      const validation = parseAndValidateStage3RankingOutput(rawOutputText);
      if (!validation.success) {
        lastAssignment = null;
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const assignment = validateStage3RankingIntegrity(validation.output, expectedIds);
      lastAssignment = assignment;
      if (!assignment.passed) {
        lastError = `Ranking integrity validation failed: ${assignment.errors.join("; ")}`;
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
        assignment,
        model,
        promptVersion: STAGE3_EVENT_RANKING_PROMPT_VERSION,
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
    assignment: lastAssignment,
    model,
    promptVersion: STAGE3_EVENT_RANKING_PROMPT_VERSION,
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
