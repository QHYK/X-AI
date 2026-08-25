/**
 * Stage 3 Source Digest 排名与单次修复调用层。
 * 初次结果不完整时仅修复 ID 排列，避免第二次调用把已完成的相对排序整体推翻。
 */
import {
  createLlmClient,
  resolveStageLlmModel,
  resolveStageLlmProvider,
} from "./llm-client.js";
import {
  parseAndValidateStage3DigestOrderedIdsOutput,
  rebuildStage3DigestRankingFromOrderedIds,
  stage3DigestOrderedIdsOutputJsonSchema,
  validateStage3DigestRankingIntegrity,
  type Stage3RankingIntegrity,
  type Stage3RankingOutput,
} from "./stage3-contract.js";
import {
  buildStage3DigestRankingInstructions,
  buildStage3DigestRankingUserPrompt,
  STAGE3_DIGEST_RANKING_PROMPT_VERSION,
  type Stage3DigestRankingCandidate,
  type Stage3DigestRankingInput,
} from "../prompts/stage3-digest-ranking.js";
import {
  buildStage3DigestRepairInstructions,
  buildStage3DigestRepairUserPrompt,
  type Stage3DigestRepairInput,
} from "../prompts/stage3-digest-repair.js";

export type Stage3DigestRankingLlmOptions = {
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

const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE3_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE3_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE3_LLM_RETRY_DELAY_MS ?? 1_000);

/** 执行分类 Digest 排名；必要时进行一次针对遗漏或重复 ID 的轻量修复。 */
export async function runStage3DigestRankingLlm(
  input: Stage3DigestRankingInput,
  options: Stage3DigestRankingLlmOptions = {},
): Promise<Stage3DigestRankingResult> {
  const provider = resolveStageLlmProvider("stage3");
  const model = resolveStageLlmModel("stage3", options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
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
    // Phase 1: initial full ranking. Retries are reserved for schema / transport
    // failures only; an integrity failure is handed off to a single repair pass.
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
        const response = await client.responses.create(
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
            await sleep(RETRY_DELAY_MS * attempt);
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
          await sleep(RETRY_DELAY_MS * attempt);
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

  const noRepairSummary: Stage3DigestRepairSummary = {
    attempted: false,
    success: null,
    before: initial.assignment,
    beforeReturnedCount: initial.output.rankings.length,
    after: null,
  };

  if (initial.assignment.passed) {
  return {
      success: true,
      input,
      output: initial.output,
      assignment: initial.assignment,
      repair: noRepairSummary,
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
    };
  }

  // Phase 2: a single lightweight repair pass. It only fixes the permutation
  // (missing / duplicate IDs); it does not re-rank the candidates.
  const repair = await runStage3DigestRepair(client, model, timeoutMs, expectedIds, input, initial);
  attemptsUsed += 1;

  if (repair.success) {
    return {
      success: true,
      input,
      output: repair.output,
      assignment: repair.assignment,
      repair: {
        attempted: true,
        success: true,
        before: initial.assignment,
        beforeReturnedCount: initial.output.rankings.length,
        after: repair.assignment,
      },
      model,
      promptVersion: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
      responseId: initial.responseId,
      attempts: attemptsUsed,
      elapsedMs: Date.now() - startedAt,
      rawOutputText: repair.rawOutputText,
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
        repair: buildStage3DigestRepairDiagnostics(
          input.category,
          startedAt,
          repair.rankedCandidatesCount,
          repair.missingCandidatesCount,
          repair.finishReason,
          repair.usage,
          repair.orderedIds,
          repair.assignment,
        ),
      },
    };
  }

  return {
      success: false,
      input,
      assignment: repair.assignment ?? initial.assignment,
      repair: {
        attempted: true,
        success: false,
        before: initial.assignment,
        beforeReturnedCount: initial.output.rankings.length,
        after: repair.assignment,
      },
      model,
      promptVersion: STAGE3_DIGEST_RANKING_PROMPT_VERSION,
      attempts: attemptsUsed,
      elapsedMs: Date.now() - startedAt,
      error: repair.error,
      rawOutputText: repair.rawOutputText ?? initial.rawOutputText,
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
        repair: buildStage3DigestRepairDiagnostics(
          input.category,
          startedAt,
          repair.rankedCandidatesCount,
          repair.missingCandidatesCount,
          repair.finishReason,
          repair.usage,
          repair.orderedIds,
          repair.assignment,
        ),
      },
    };
  } finally {
    await client.close();
  }
}

type Stage3DigestRepairCallResult =
  | {
      success: true;
      output: Stage3RankingOutput;
      assignment: Stage3RankingIntegrity;
      rawOutputText: string;
      orderedIds: string[];
      finishReason: string | null;
      usage: Stage3DigestLlmUsage;
      rankedCandidatesCount: number;
      missingCandidatesCount: number;
    }
  | {
      success: false;
      assignment: Stage3RankingIntegrity | null;
      error: string;
      rawOutputText: string | null;
      orderedIds: string[] | null;
      finishReason: string | null;
      usage: Stage3DigestLlmUsage;
      rankedCandidatesCount: number;
      missingCandidatesCount: number;
    };

/** 从首次输出提取有效排序与遗漏候选，构造不需要重新理解全部数据的修复输入。 */
export function buildStage3DigestRepairInput(
  input: Stage3DigestRankingInput,
  initialOutput: Stage3RankingOutput,
  assignment: Stage3RankingIntegrity,
): Stage3DigestRepairInput {
  const candidateById = new Map<string, Stage3DigestRankingCandidate>(
    input.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const validIds = new Set(input.candidates.map((candidate) => candidate.id));

  const rankedCandidates: Stage3DigestRankingCandidate[] = [];
  const seenIds = new Set<string>();
  for (const ranking of initialOutput.rankings) {
    if (!validIds.has(ranking.id) || seenIds.has(ranking.id)) {
      continue;
    }
    seenIds.add(ranking.id);
    const candidate = candidateById.get(ranking.id);
    if (candidate) {
      rankedCandidates.push(candidate);
    }
  }

  const missingCandidates: Stage3DigestRankingCandidate[] = [];
  for (const id of assignment.missingIds) {
    const candidate = candidateById.get(id);
    if (candidate) {
      missingCandidates.push(candidate);
    }
  }

  return {
    category: input.category,
    ranked_candidates: rankedCandidates,
    missing_candidates: missingCandidates,
    duplicate_ids: assignment.duplicateIds,
  };
}

async function runStage3DigestRepair(
  client: ReturnType<typeof createLlmClient>,
  model: string,
  timeoutMs: number,
  expectedIds: string[],
  input: Stage3DigestRankingInput,
  initial: {
    output: Stage3RankingOutput;
    assignment: Stage3RankingIntegrity;
    responseId: string;
    rawOutputText: string;
  },
): Promise<Stage3DigestRepairCallResult> {
  const repairInput = buildStage3DigestRepairInput(input, initial.output, initial.assignment);
  const rankedCandidatesCount = repairInput.ranked_candidates.length;
  const missingCandidatesCount = repairInput.missing_candidates.length;

  try {
    const response = await client.responses.create(
      {
        model,
        instructions: buildStage3DigestRepairInstructions(),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildStage3DigestRepairUserPrompt(repairInput),
              },
            ],
          },
        ],
        max_output_tokens: 6_000,
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "stage3_digest_repair",
            description: "Structured Stage 3 Source Digest ranking repair output.",
            schema: stage3DigestOrderedIdsOutputJsonSchema,
            strict: true,
          },
        },
      },
      {
        timeout: timeoutMs,
      },
    );

    const rawOutputText = response.output_text;
    const finishReason = response.finish_reason ?? null;
    const usage: Stage3DigestLlmUsage = {
      input_tokens: response.usage?.input_tokens ?? null,
      output_tokens: response.usage?.output_tokens ?? null,
      total_tokens: response.usage?.total_tokens ?? null,
    };

    const validation = parseAndValidateStage3DigestOrderedIdsOutput(rawOutputText);
    if (!validation.success) {
      return {
        success: false,
        assignment: null,
        error: `Repair structured output validation failed: ${validation.errors.join("; ")}`,
        rawOutputText,
        orderedIds: null,
        finishReason,
        usage,
        rankedCandidatesCount,
        missingCandidatesCount,
      };
    }

    const orderedIds = validation.output.ordered_ids;
    const output = rebuildStage3DigestRankingFromOrderedIds(orderedIds);
    const assignment = validateStage3DigestRankingIntegrity(output, expectedIds);
    if (!assignment.passed) {
      return {
        success: false,
        assignment,
        error: `Repair integrity validation failed: ${assignment.errors.join("; ")}`,
        rawOutputText,
        orderedIds,
        finishReason,
        usage,
        rankedCandidatesCount,
        missingCandidatesCount,
      };
    }

    return {
      success: true,
      output,
      assignment,
      rawOutputText,
      orderedIds,
      finishReason,
      usage,
      rankedCandidatesCount,
      missingCandidatesCount,
    };
  } catch (error) {
    const message = sanitizeLlmError(error instanceof Error ? error.message : String(error));
    return {
      success: false,
      assignment: null,
      error: `Repair LLM call failed: ${message}`,
      rawOutputText: null,
      orderedIds: null,
      finishReason: null,
      usage: { input_tokens: null, output_tokens: null, total_tokens: null },
      rankedCandidatesCount,
      missingCandidatesCount,
    };
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

function buildStage3DigestRepairDiagnostics(
  category: string,
  startedAt: number,
  rankedCandidatesCount: number,
  missingCandidatesCount: number,
  finishReason: string | null,
  usage: Stage3DigestLlmUsage,
  orderedIds: string[] | null,
  assignment: Stage3RankingIntegrity | null,
): Stage3DigestRepairCallDiagnostics {
  return {
    category,
    ranked_candidates_count: rankedCandidatesCount,
    missing_candidates_count: missingCandidatesCount,
    finish_reason: finishReason,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    returned_count: orderedIds === null ? null : orderedIds.length,
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
