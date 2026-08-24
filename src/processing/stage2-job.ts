import type { Pool } from "pg";
import { STAGE2_PROMPT_VERSION } from "../prompts/stage2-event-merge.js";
import {
  loadStage2EventCandidates,
  prepareStage2Input,
  type Stage2CandidateRow,
  type Stage2IdMap,
  type Stage2Input,
} from "./stage2-candidates.js";
import {
  validateStage2Assignments,
  type Stage2AssignmentValidation,
  type Stage2Output,
} from "./stage2-contract.js";
import {
  runStage2MergeLlm,
  type Stage2LlmOptions,
  type Stage2TokenUsage,
} from "./stage2-llm.js";
import { resolveStageLlmModel } from "./llm-client.js";
import type { CollectedAtScope } from "../lib/daily-scope.js";

export type Stage2JobOptions = Stage2LlmOptions & {
  collectedWithinHours?: number;
  collectedAtScope?: CollectedAtScope;
};

export type Stage2EventGroup = {
  event_hint: string;
  sources: Array<{
    temp_id: string;
    processed_content_id: string | null;
  }>;
};

type Stage2JobBase = {
  input: Stage2Input;
  idMap: Stage2IdMap;
  candidateRows: Stage2CandidateRow[];
  assignment: Stage2AssignmentValidation | null;
  model: string;
  promptVersion: string;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  elapsedMs: number;
  tokenUsage: Stage2TokenUsage | null;
  finishReason: string | null;
};

export type Stage2JobSuccess = Stage2JobBase & {
  success: true;
  output: Stage2Output;
  eventGroups: Stage2EventGroup[];
  error: null;
};

export type Stage2JobFailure = Stage2JobBase & {
  success: false;
  output: null;
  eventGroups: [];
  error: string;
};

export type Stage2JobResult = Stage2JobSuccess | Stage2JobFailure;

export async function processStage2Merge(
  pool: Pool,
  options: Stage2JobOptions = {},
): Promise<Stage2JobResult> {
  const startedAt = Date.now();
  const model = resolveStageLlmModel("stage2", options.model);
  const candidateRows = await loadStage2EventCandidates(pool, {
    collectedWithinHours: options.collectedWithinHours,
    collectedAtScope: options.collectedAtScope,
  });
  const { input, idMap } = prepareStage2Input(candidateRows);

  if (input.event_candidates.length === 0) {
    const output: Stage2Output = { events: [] };
    return {
      success: true,
      input,
      idMap,
      candidateRows,
      output,
      eventGroups: [],
      assignment: validateStage2Assignments(output, input),
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      llmCallCount: 0,
      retryCount: 0,
      llmDurationMs: 0,
      elapsedMs: Date.now() - startedAt,
      tokenUsage: null,
      finishReason: null,
      error: null,
    };
  }

  const llmResult = await runStage2MergeLlm(input, {
    ...options,
    maxRetries: options.maxRetries ?? 0,
  });
  if (!llmResult.success) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      output: null,
      eventGroups: [],
      assignment: null,
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      llmCallCount: llmResult.attempts,
      retryCount: Math.max(0, llmResult.attempts - 1),
      llmDurationMs: llmResult.elapsedMs,
      elapsedMs: Date.now() - startedAt,
      tokenUsage: llmResult.tokenUsage,
      finishReason: llmResult.finishReason,
      error: llmResult.error,
    };
  }

  const output = llmResult.output;
  const assignment = validateStage2Assignments(output, input);
  return {
    success: true,
    input,
    idMap,
    candidateRows,
    output,
    eventGroups: output.events.map((event) => ({
      event_hint: event.event_hint,
      sources: event.sources.map((tempId) => ({
        temp_id: tempId,
        processed_content_id: idMap[tempId] ?? null,
      })),
    })),
    // Temporary diagnostic mode: record assignment issues without rejecting output.
    assignment,
    model: llmResult.model,
    promptVersion: llmResult.promptVersion,
    llmCallCount: llmResult.attempts,
    retryCount: Math.max(0, llmResult.attempts - 1),
    llmDurationMs: llmResult.elapsedMs,
    elapsedMs: Date.now() - startedAt,
    tokenUsage: llmResult.tokenUsage,
    finishReason: llmResult.finishReason,
    error: null,
  };
}

export function summarizeStage2Result(result: Stage2JobResult) {
  const eventGroupCount = result.eventGroups.length;
  const multiSourceGroupCount = result.eventGroups.filter(
    (group) => group.sources.length > 1,
  ).length;
  const singleSourceGroupCount = result.eventGroups.filter(
    (group) => group.sources.length === 1,
  ).length;

  return {
    success: result.success,
    eventCandidateCount: result.input.event_candidates.length,
    eventGroupCount,
    multiSourceGroupCount,
    singleSourceGroupCount,
    missingTempIds: result.assignment?.missingTempIds ?? [],
    duplicateTempIds: result.assignment?.duplicateTempIds ?? [],
    inventedTempIds: result.assignment?.inventedTempIds ?? [],
    assignmentValidationPassed: result.assignment?.passed ?? false,
    model: result.model,
    promptVersion: result.promptVersion,
    llmCallCount: result.llmCallCount,
    retryCount: result.retryCount,
    llmDurationMs: result.llmDurationMs,
    elapsedMs: result.elapsedMs,
    tokenUsage: result.tokenUsage,
    finishReason: result.finishReason,
    error: result.success ? null : result.error,
  };
}
