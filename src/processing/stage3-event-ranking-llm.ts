import {
  createLlmClient,
  resolveStageLlmModel,
  resolveStageLlmProvider,
} from "./llm-client.js";
import {
  deduplicateStage3EventRankingOutput,
  deriveStage3EventRankings,
  parseAndValidateStage3EventRankingOutput,
  stage3EventRankingOutputJsonSchema,
  validateStage3EventRankingIntegrity,
  type Stage3EventRankedOutput,
  type Stage3EventRankingIntegrity,
  type Stage3EventRankingOutput,
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

export type Stage3EventRankingTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type Stage3EventRankingSuccess = {
  success: true;
  input: Stage3EventRankingInput;
  output: Stage3EventRankingOutput;
  rankings: Stage3EventRankedOutput;
  assignment: Stage3EventRankingIntegrity;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage3EventRankingTokenUsage | null;
  rawOutputText: string;
};

export type Stage3EventRankingFailure = {
  success: false;
  input: Stage3EventRankingInput;
  assignment: Stage3EventRankingIntegrity | null;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  tokenUsage: Stage3EventRankingTokenUsage | null;
  error: string;
  rawOutputText: string | null;
};

export type Stage3EventRankingResult =
  | Stage3EventRankingSuccess
  | Stage3EventRankingFailure;

const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE3_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE3_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE3_LLM_RETRY_DELAY_MS ?? 1_000);

export async function runStage3EventRankingLlm(
  input: Stage3EventRankingInput,
  options: Stage3EventRankingLlmOptions = {},
): Promise<Stage3EventRankingResult> {
  const provider = resolveStageLlmProvider("stage3");
  const model = resolveStageLlmModel("stage3", options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  const expectedIds = input.events.map((event) => event.id);
  const tokenUsage: Stage3EventRankingTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let hasTokenUsage = false;

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 3 Event Ranking LLM failure.";
  let lastAssignment: Stage3EventRankingIntegrity | null = null;
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
          max_output_tokens: 8_000,
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage3_event_ranking",
              description: "Up to 50 most important Stage 3 Event IDs in ranked order.",
              schema: stage3EventRankingOutputJsonSchema,
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
      const validation = parseAndValidateStage3EventRankingOutput(rawOutputText);
      if (!validation.success) {
        lastAssignment = null;
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const assignment = validateStage3EventRankingIntegrity(
        validation.output,
        expectedIds,
      );
      lastAssignment = assignment;
      if (!assignment.passed) {
        lastError = `Ranking integrity validation failed: ${assignment.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const deduplicatedOutput = deduplicateStage3EventRankingOutput(validation.output);
      return {
        success: true,
        input,
        output: deduplicatedOutput,
        rankings: deriveStage3EventRankings(deduplicatedOutput),
        assignment,
        model,
        promptVersion: STAGE3_EVENT_RANKING_PROMPT_VERSION,
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
    assignment: lastAssignment,
    model,
    promptVersion: STAGE3_EVENT_RANKING_PROMPT_VERSION,
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
