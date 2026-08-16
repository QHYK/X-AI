import type { Pool } from "pg";
import {
  loadStage2EventCandidates,
  prepareStage2Input,
  type Stage2CandidateRow,
  type Stage2IdMap,
  type Stage2Input,
} from "./stage2-candidates.js";
import { runStage2MergeLlm, type Stage2LlmOptions } from "./stage2-llm.js";
import {
  validateStage2Assignments,
  type Stage2AssignmentValidation,
  type Stage2Output,
} from "./stage2-contract.js";

export type Stage2JobOptions = Stage2LlmOptions & {
  collectedWithinHours?: number;
};

export type Stage2EventGroup = {
  event_hint: string;
  sources: Array<{
    temp_id: string;
    processed_content_id: string;
  }>;
};

export type Stage2JobSuccess = {
  success: true;
  input: Stage2Input;
  idMap: Stage2IdMap;
  candidateRows: Stage2CandidateRow[];
  output: Stage2Output;
  eventGroups: Stage2EventGroup[];
  assignment: Stage2AssignmentValidation;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
};

export type Stage2JobFailure = {
  success: false;
  input: Stage2Input;
  idMap: Stage2IdMap;
  candidateRows: Stage2CandidateRow[];
  assignment: Stage2AssignmentValidation | null;
  model: string | null;
  promptVersion: string | null;
  attempts: number;
  elapsedMs: number;
  error: string;
};

export type Stage2JobResult = Stage2JobSuccess | Stage2JobFailure;

export async function processStage2Merge(
  pool: Pool,
  options: Stage2JobOptions = {},
): Promise<Stage2JobResult> {
  const candidateRows = await loadStage2EventCandidates(pool, {
    collectedWithinHours: options.collectedWithinHours,
  });
  const { input, idMap } = prepareStage2Input(candidateRows);

  if (input.event_candidates.length === 0) {
    return {
      success: true,
      input,
      idMap,
      candidateRows,
      output: { events: [] },
      eventGroups: [],
      assignment: validateStage2Assignments({ events: [] }, input),
      model: options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
      promptVersion: "v1",
      responseId: "",
      attempts: 0,
      elapsedMs: 0,
    };
  }

  const llmResult = await runStage2MergeLlm(input, options);
  if (!llmResult.success) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      assignment: null,
      model: llmResult.model,
      promptVersion: llmResult.promptVersion,
      attempts: llmResult.attempts,
      elapsedMs: llmResult.elapsedMs,
      error: llmResult.error,
    };
  }

  const assignment = validateStage2Assignments(llmResult.output, input);
  if (!assignment.passed) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      assignment,
      model: llmResult.model,
      promptVersion: llmResult.promptVersion,
      attempts: llmResult.attempts,
      elapsedMs: llmResult.elapsedMs,
      error: `Candidate assignment validation failed: ${assignment.errors.join("; ")}`,
    };
  }

  return {
    success: true,
    input,
    idMap,
    candidateRows,
    output: llmResult.output,
    eventGroups: llmResult.output.events.map((event) => ({
      event_hint: event.event_hint,
      sources: event.sources.map((tempId) => ({
        temp_id: tempId,
        processed_content_id: idMap[tempId],
      })),
    })),
    assignment,
    model: llmResult.model,
    promptVersion: llmResult.promptVersion,
    responseId: llmResult.responseId,
    attempts: llmResult.attempts,
    elapsedMs: llmResult.elapsedMs,
  };
}

export function summarizeStage2Result(result: Stage2JobResult) {
  const eventGroupCount = result.success ? result.eventGroups.length : 0;
  const multiSourceGroupCount = result.success
    ? result.eventGroups.filter((group) => group.sources.length > 1).length
    : 0;
  const singleSourceGroupCount = result.success
    ? result.eventGroups.filter((group) => group.sources.length === 1).length
    : 0;

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
    attempts: result.attempts,
    retryCount: Math.max(0, result.attempts - 1),
    elapsedMs: result.elapsedMs,
    error: result.success ? null : result.error,
  };
}
