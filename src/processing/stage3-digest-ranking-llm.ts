/**
 * Stage 3 Source Digest 排名调用层。
 * ID 异常由确定性 normalization 修复，不额外发起 repair 请求。
 */
import {
  createLlmClient,
  resolveLlmModel,
  resolveStageLlmModel,
  resolveStageLlmProvider,
  type LlmProvider,
} from "./llm-client.js";
import {
  parseAndValidateStage3DigestOrderedIdsOutput,
  rebuildStage3DigestRankingFromOrderedIds,
  normalizeStage3RankingOutput,
  stage3DigestOrderedIdsOutputJsonSchema,
  validateStage3DigestRankingIntegrity,
  type Stage3RankingIntegrity,
  type Stage3RankingOutput,
  type Stage3RankingWarnings,
} from "./stage3-contract.js";
import {
  buildStage3DigestRankingInstructions,
  buildStage3DigestRankingUserPrompt,
  STAGE3_DIGEST_RANKING_PROMPT_VERSION,
  type Stage3DigestRankingInput,
} from "../prompts/stage3-digest-ranking.js";
import { resolveStageLlmRuntimeConfig } from "./stage-llm-runtime-config.js";

export type Stage3DigestRankingLlmOptions = {
  provider?: LlmProvider;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type Stage3DigestLlmUsage = {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
};

export type Stage3DigestInitialCallDiagnostics = {
  category: string;
  candidate_count: number;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  returned_count: number | null;
  unique_valid_ids: number | null;
  missing_count: number | null;
  duplicate_count: number | null;
  invalid_count: number | null;
  duration_ms: number;
};

export type Stage3DigestRepairCallDiagnostics = {
  category: string;
  ranked_candidates_count: number;
  missing_candidates_count: number;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  returned_count: number | null;
  missing_count: number | null;
  duplicate_count: number | null;
  invalid_count: number | null;
  duration_ms: number;
};

export type Stage3DigestDiagnostics = {
  initial: Stage3DigestInitialCallDiagnostics;
  repair: Stage3DigestRepairCallDiagnostics | null;
};

export type Stage3DigestRepairSummary = {
  attempted: boolean;
  success: boolean | null;
  before: Stage3RankingIntegrity;
  beforeReturnedCount: number;
  after: Stage3RankingIntegrity | null;
};

export type Stage3DigestRankingSuccess = {
  success: true;
  input: Stage3DigestRankingInput;
  output: Stage3RankingOutput;
  assignment: Stage3RankingIntegrity;
  repair: Stage3DigestRepairSummary;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  rawOutputText: string;
  diagnostics: Stage3DigestDiagnostics;
  warnings: Stage3RankingWarnings;
};

export type Stage3DigestRankingFailure = {
  success: false;
  input: Stage3DigestRankingInput;
  assignment: Stage3RankingIntegrity | null;
  repair: Stage3DigestRepairSummary | null;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  error: string;
  rawOutputText: string | null;
  diagnostics: Stage3DigestDiagnostics;
};

export type Stage3DigestRankingResult =
  | Stage3DigestRankingSuccess
  | Stage3DigestRankingFailure;

/** 执行分类 Digest 排名；必要时进行一次针对遗漏或重复 ID 的轻量修复。 */
export async function runStage3DigestRankingLlm(
  input: Stage3DigestRankingInput,
  options: Stage3DigestRankingLlmOptions = {},
): Promise<Stage3DigestRankingResult> {
  const provider = options.provider ?? resolveStageLlmProvider("stage3");
  const model = options.model ?? (
    options.provider
      ? resolveLlmModel(undefined, provider)
      : resolveStageLlmModel("stage3")
  );
  const runtimeConfig = resolveStageLlmRuntimeConfig("stage3");
  const timeoutMs = options.timeoutMs ?? runtimeConfig.timeoutMs;
  const maxRetries = options.maxRetries ?? runtimeConfig.maxRetries;
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  const expectedIds = input.candidates.map((candidate) => candidate.id);

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 3 Digest Ranking LLM failure.";
  let lastAssignment: Stage3RankingIntegrity | null = null;
  let attemptsUsed = 0;
  let lastFinishReason: string | null = null;
  let lastUsage: Stage3DigestLlmUsage = {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
  };

  try {
    // Retries are reserved for schema / transport failures. ID anomalies are
    // normalized deterministically after a structurally valid response.
    let initial: {
      output: Stage3RankingOutput;
      assignment: Stage3RankingIntegrity;
      responseId: string;
      rawOutputText: string;
      orderedIds: string[];
      finishReason: string | null;
      usage: Stage3DigestLlmUsage;
    } | null = null;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
      attemptsUsed = attempt;
      try {
        const response = await client.structured.create(
          {
            model,
            instructions: buildStage3DigestRankingInstructions(input.category),
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: buildStage3DigestRankingUserPrompt(input),
                  },
                ],
              },
            ],
            max_output_tokens: 6_000,
            store: false,
            text: {
              format: {
                type: "json_schema",
                name: "stage3_digest_ranking",
                description: "Structured Stage 3 Source Digest ranking output.",
                schema: stage3DigestOrderedIdsOutputJsonSchema,
                strict: true,
              },
            },
          },
          {
            timeout: timeoutMs,
          },
        );

        rawOutputText = response.output_text;
        lastFinishReason = response.finish_reason ?? null;
        lastUsage = {
          input_tokens: response.usage?.input_tokens ?? null,
          output_tokens: response.usage?.output_tokens ?? null,
          total_tokens: response.usage?.total_tokens ?? null,
        };

        const validation = parseAndValidateStage3DigestOrderedIdsOutput(rawOutputText);
        if (!validation.success) {
          lastAssignment = null;
          lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
          if (attempt <= maxRetries) {
            await sleep(runtimeConfig.retryDelayMs * attempt);
            continue;
          }

          break;
        }

        const orderedIds = validation.output.ordered_ids;
        const output = rebuildStage3DigestRankingFromOrderedIds(orderedIds);
        const assignment = validateStage3DigestRankingIntegrity(output, expectedIds);
        lastAssignment = assignment;
        initial = {
          output,
          assignment,
          responseId: response.id,
          rawOutputText,
          orderedIds,
          finishReason: lastFinishReason,
          usage: lastUsage,
        };
        break;
      } catch (error) {
        lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
        if (isNonRetryableLlmError(lastError)) {
          break;
        }

        if (attempt <= maxRetries) {
          await sleep(runtimeConfig.retryDelayMs * attempt);
          continue;
        }
      }
    }

    if (!initial) {
      return {
        success: false,
        input,
        assignment: lastAssignment,
        repair: null,
        model,
        promptVersion: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
        attempts: attemptsUsed,
        elapsedMs: Date.now() - startedAt,
        error: lastError,
        rawOutputText,
        diagnostics: {
          initial: buildStage3DigestInitialDiagnostics(
            input.category,
            expectedIds.length,
            startedAt,
            lastFinishReason,
            lastUsage,
            null,
            expectedIds,
            lastAssignment,
          ),
          repair: null,
        },
      };
    }

    const normalized = normalizeStage3RankingOutput(initial.output, expectedIds);
    if (!normalized.success) {
      return {
        success: false,
        input,
        assignment: normalized.integrity,
        repair: null,
        model,
        promptVersion: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
        attempts: attemptsUsed,
        elapsedMs: Date.now() - startedAt,
        error: `Ranking integrity validation failed: ${normalized.integrity.errors.join("; ")}`,
        rawOutputText: initial.rawOutputText,
        diagnostics: {
          initial: buildStage3DigestInitialDiagnostics(
            input.category, expectedIds.length, startedAt, initial.finishReason,
            initial.usage, initial.orderedIds, expectedIds, normalized.integrity,
          ),
          repair: null,
        },
      };
    }

    return {
      success: true,
      input,
      output: normalized.output,
      assignment: initial.assignment,
      repair: {
        attempted: false,
        success: null,
        before: initial.assignment,
        beforeReturnedCount: initial.output.rankings.length,
        after: null,
      },
      model,
      promptVersion: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
      responseId: initial.responseId,
      attempts: attemptsUsed,
      elapsedMs: Date.now() - startedAt,
      rawOutputText: initial.rawOutputText,
      diagnostics: {
        initial: buildStage3DigestInitialDiagnostics(
          input.category,
          expectedIds.length,
          startedAt,
          initial.finishReason,
          initial.usage,
          initial.orderedIds,
          expectedIds,
          initial.assignment,
        ),
        repair: null,
      },
      warnings: normalized.warnings,
    };
  } finally {
    await client.close();
  }
}

function buildStage3DigestInitialDiagnostics(
  category: string,
  candidateCount: number,
  startedAt: number,
  finishReason: string | null,
  usage: Stage3DigestLlmUsage,
  orderedIds: string[] | null,
  expectedIds: string[],
  assignment: Stage3RankingIntegrity | null,
): Stage3DigestInitialCallDiagnostics {
  let uniqueValidIds: number | null = null;
  if (orderedIds !== null) {
    const valid = new Set(expectedIds);
    const seen = new Set<string>();
    for (const id of orderedIds) {
      if (valid.has(id)) {
        seen.add(id);
      }
    }
    uniqueValidIds = seen.size;
  }

  return {
    category,
    candidate_count: candidateCount,
    finish_reason: finishReason,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    returned_count: orderedIds === null ? null : orderedIds.length,
    unique_valid_ids: uniqueValidIds,
    missing_count: assignment === null ? null : assignment.missingIds.length,
    duplicate_count: assignment === null ? null : assignment.duplicateIds.length,
    invalid_count: assignment === null ? null : assignment.inventedIds.length,
    duration_ms: Date.now() - startedAt,
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
