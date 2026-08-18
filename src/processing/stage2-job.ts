import type { Pool } from "pg";
import { STAGE2_PROMPT_VERSION } from "../prompts/stage2-event-merge.js";
import { STAGE2_RECONCILIATION_PROMPT_VERSION } from "../prompts/stage2-event-reconciliation.js";
import {
  loadStage2EventCandidates,
  prepareStage2Input,
  type Stage2CandidateRow,
  type Stage2IdMap,
  type Stage2Input,
  type Stage2InputCandidate,
} from "./stage2-candidates.js";
import {
  validateStage2Assignments,
  type Stage2AssignmentValidation,
  type Stage2Output,
} from "./stage2-contract.js";
import { runStage2MergeLlm, type Stage2LlmOptions } from "./stage2-llm.js";
import {
  validateStage2ReconciliationAssignments,
  type Stage2ReconciliationAssignment,
  type Stage2ReconciliationInput,
  type Stage2ReconciliationInputGroup,
  type Stage2ReconciliationOutput,
} from "./stage2-reconciliation-contract.js";
import { runStage2ReconciliationLlm } from "./stage2-reconciliation-llm.js";

export type Stage2JobOptions = Stage2LlmOptions & {
  collectedWithinHours?: number;
  batchSize?: number;
  concurrency?: number;
};

export type Stage2EventGroup = {
  event_hint: string;
  sources: Array<{
    temp_id: string;
    processed_content_id: string;
  }>;
};

export type Stage2LocalBatchRun = {
  batchIndex: number;
  bucketCategory: string;
  candidateCount: number;
  input: Stage2Input;
  output: Stage2Output | null;
  assignment: Stage2AssignmentValidation | null;
  model: string;
  promptVersion: string;
  responseId: string | null;
  attempts: number;
  elapsedMs: number;
  success: boolean;
  error: string | null;
};

export type Stage2PreliminaryGroup = Stage2ReconciliationInputGroup & {
  batch_indexes: number[];
};

export type Stage2CrossBatchMergeExample = {
  eventHint: string;
  groupIds: string[];
  categories: string[];
  preliminaryHints: string[];
  candidateTitles: string[];
};

type Stage2JobBase = {
  input: Stage2Input;
  idMap: Stage2IdMap;
  candidateRows: Stage2CandidateRow[];
  localBatches: Stage2LocalBatchRun[];
  preliminaryGroups: Stage2PreliminaryGroup[];
  reconciliationInput: Stage2ReconciliationInput | null;
  reconciliationOutput: Stage2ReconciliationOutput | null;
  reconciliationAssignment: Stage2ReconciliationAssignment | null;
  assignment: Stage2AssignmentValidation | null;
  model: string;
  promptVersion: string;
  reconciliationPromptVersion: string;
  llmCallCount: number;
  retryCount: number;
  llmDurationMs: number;
  elapsedMs: number;
  crossBatchMergeCount: number;
  crossCategoryMergeCount: number;
  crossBatchMergeExamples: Stage2CrossBatchMergeExample[];
};

export type Stage2JobSuccess = Stage2JobBase & {
  success: true;
  output: Stage2Output;
  eventGroups: Stage2EventGroup[];
  error: null;
};

export type Stage2JobFailure = Stage2JobBase & {
  success: false;
  error: string;
};

export type Stage2JobResult = Stage2JobSuccess | Stage2JobFailure;

type Stage2LocalBatchDefinition = {
  batchIndex: number;
  bucketCategory: string;
  input: Stage2Input;
};

export const DEFAULT_STAGE2_BATCH_SIZE = 40;
export const DEFAULT_STAGE2_CONCURRENCY = 2;

const DEFAULT_MODEL = "gpt-5.4-mini";
const CATEGORY_ORDER = [
  "Finance & Economy",
  "Technology",
  "Science",
  "Policy",
  "Company",
  "General",
  "Long-form",
];
const MAX_REPRESENTATIVE_TITLES = 3;
const MAX_GROUP_ENTITIES = 5;
const MAX_GROUP_TAGS = 5;
const MAX_TAG_KEYS_PER_LOCAL_BATCH = 12;

export async function processStage2Merge(
  pool: Pool,
  options: Stage2JobOptions = {},
): Promise<Stage2JobResult> {
  const startedAt = Date.now();
  const model = options.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
  const batchSize =
    options.batchSize ??
    readPositiveInteger(
      process.env.STAGE2_BATCH_SIZE,
      DEFAULT_STAGE2_BATCH_SIZE,
      "STAGE2_BATCH_SIZE",
    );
  const concurrency =
    options.concurrency ??
    readPositiveInteger(
      process.env.STAGE2_CONCURRENCY,
      DEFAULT_STAGE2_CONCURRENCY,
      "STAGE2_CONCURRENCY",
    );
  const candidateRows = await loadStage2EventCandidates(pool, {
    collectedWithinHours: options.collectedWithinHours,
  });
  const { input, idMap } = prepareStage2Input(candidateRows);

  if (input.event_candidates.length === 0) {
    const output: Stage2Output = { events: [] };
    return {
      success: true,
      input,
      idMap,
      candidateRows,
      localBatches: [],
      preliminaryGroups: [],
      reconciliationInput: { groups: [] },
      reconciliationOutput: { merged_groups: [], single_group_ids: [] },
      reconciliationAssignment: validateStage2ReconciliationAssignments(
        { merged_groups: [], single_group_ids: [] },
        { groups: [] },
      ),
      output,
      eventGroups: [],
      assignment: validateStage2Assignments(output, input),
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      reconciliationPromptVersion: STAGE2_RECONCILIATION_PROMPT_VERSION,
      llmCallCount: 0,
      retryCount: 0,
      llmDurationMs: 0,
      elapsedMs: Date.now() - startedAt,
      crossBatchMergeCount: 0,
      crossCategoryMergeCount: 0,
      crossBatchMergeExamples: [],
      error: null,
    };
  }

  const localBatchDefinitions = createStage2LocalBatches(
    input,
    candidateRows,
    batchSize,
  );
  const localBatches = await runWithConcurrency(
    localBatchDefinitions,
    concurrency,
    (batch) => processLocalBatch(batch, options),
  );
  const localMetrics = summarizeLlmRuns(localBatches);
  const failedLocalBatch = localBatches.find((batch) => !batch.success);

  if (failedLocalBatch) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      localBatches,
      preliminaryGroups: [],
      reconciliationInput: null,
      reconciliationOutput: null,
      reconciliationAssignment: null,
      assignment: null,
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      reconciliationPromptVersion: STAGE2_RECONCILIATION_PROMPT_VERSION,
      ...localMetrics,
      elapsedMs: Date.now() - startedAt,
      crossBatchMergeCount: 0,
      crossCategoryMergeCount: 0,
      crossBatchMergeExamples: [],
      error: `Stage 2A batch ${formatBatchNumber(failedLocalBatch.batchIndex)} failed: ${failedLocalBatch.error}`,
    };
  }

  const preliminaryGroups = buildPreliminaryGroups(localBatches, input, candidateRows);
  const reconciliationInput: Stage2ReconciliationInput = {
    groups: preliminaryGroups.map(toReconciliationInputGroup),
  };
  const reconciliationResult = await runStage2ReconciliationLlm(
    reconciliationInput,
    options,
  );
  const reconciliationMetrics = {
    llmCallCount: reconciliationResult.attempts,
    retryCount: Math.max(0, reconciliationResult.attempts - 1),
    llmDurationMs: reconciliationResult.elapsedMs,
  };
  const allMetrics = addLlmMetrics(localMetrics, reconciliationMetrics);

  if (!reconciliationResult.success) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      localBatches,
      preliminaryGroups,
      reconciliationInput,
      reconciliationOutput: null,
      reconciliationAssignment: null,
      assignment: null,
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      reconciliationPromptVersion: reconciliationResult.promptVersion,
      ...allMetrics,
      elapsedMs: Date.now() - startedAt,
      crossBatchMergeCount: 0,
      crossCategoryMergeCount: 0,
      crossBatchMergeExamples: [],
      error: `Stage 2B reconciliation failed: ${reconciliationResult.error}`,
    };
  }

  const reconciliationAssignment = validateStage2ReconciliationAssignments(
    reconciliationResult.output,
    reconciliationInput,
  );
  if (!reconciliationAssignment.passed) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      localBatches,
      preliminaryGroups,
      reconciliationInput,
      reconciliationOutput: reconciliationResult.output,
      reconciliationAssignment,
      assignment: null,
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      reconciliationPromptVersion: reconciliationResult.promptVersion,
      ...allMetrics,
      elapsedMs: Date.now() - startedAt,
      crossBatchMergeCount: 0,
      crossCategoryMergeCount: 0,
      crossBatchMergeExamples: [],
      error: `Stage 2B group assignment validation failed: ${reconciliationAssignment.errors.join("; ")}`,
    };
  }

  const output = expandReconciliationOutput(
    reconciliationResult.output,
    preliminaryGroups,
  );
  const assignment = validateStage2Assignments(output, input);
  if (!assignment.passed) {
    return {
      success: false,
      input,
      idMap,
      candidateRows,
      localBatches,
      preliminaryGroups,
      reconciliationInput,
      reconciliationOutput: reconciliationResult.output,
      reconciliationAssignment,
      assignment,
      model,
      promptVersion: STAGE2_PROMPT_VERSION,
      reconciliationPromptVersion: reconciliationResult.promptVersion,
      ...allMetrics,
      elapsedMs: Date.now() - startedAt,
      crossBatchMergeCount: 0,
      crossCategoryMergeCount: 0,
      crossBatchMergeExamples: [],
      error: `Final candidate assignment validation failed: ${assignment.errors.join("; ")}`,
    };
  }

  const reconciliationMetricsSummary = summarizeReconciliationMerges(
    reconciliationResult.output,
    preliminaryGroups,
    input,
  );

  return {
    success: true,
    input,
    idMap,
    candidateRows,
    localBatches,
    preliminaryGroups,
    reconciliationInput,
    reconciliationOutput: reconciliationResult.output,
    reconciliationAssignment,
    output,
    eventGroups: output.events.map((event) => ({
      event_hint: event.event_hint,
      sources: event.sources.map((tempId) => ({
        temp_id: tempId,
        processed_content_id: idMap[tempId],
      })),
    })),
    assignment,
    model,
    promptVersion: STAGE2_PROMPT_VERSION,
    reconciliationPromptVersion: reconciliationResult.promptVersion,
    ...allMetrics,
    elapsedMs: Date.now() - startedAt,
    ...reconciliationMetricsSummary,
    error: null,
  };
}

export function createStage2LocalBatches(
  input: Stage2Input,
  candidateRows: Stage2CandidateRow[],
  batchSize: number,
): Stage2LocalBatchDefinition[] {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`Stage 2 batch size must be a positive integer, got ${batchSize}.`);
  }
  if (input.event_candidates.length !== candidateRows.length) {
    throw new Error("Stage 2 candidate rows do not match prepared input length.");
  }

  const candidatesByCategory = new Map<
    string,
    Array<{ candidate: Stage2InputCandidate; row: Stage2CandidateRow; index: number }>
  >();
  input.event_candidates.forEach((candidate, index) => {
    const row = candidateRows[index];
    const entries = candidatesByCategory.get(row.category) ?? [];
    entries.push({ candidate, row, index });
    candidatesByCategory.set(row.category, entries);
  });

  const definitions: Stage2LocalBatchDefinition[] = [];
  const categories = [...candidatesByCategory.keys()].sort(compareCategories);
  for (const category of categories) {
    const entries = candidatesByCategory.get(category) ?? [];
    entries.sort((left, right) => {
      const tagComparison = bucketTagKey(left.row.tags).localeCompare(
        bucketTagKey(right.row.tags),
      );
      return tagComparison !== 0 ? tagComparison : left.index - right.index;
    });

    let currentEntries: typeof entries = [];
    let currentTagKeys = new Set<string>();
    const flush = () => {
      if (currentEntries.length === 0) {
        return;
      }
      definitions.push({
        batchIndex: definitions.length + 1,
        bucketCategory: category,
        input: {
          event_candidates: currentEntries.map((entry) => entry.candidate),
        },
      });
      currentEntries = [];
      currentTagKeys = new Set<string>();
    };

    for (const entry of entries) {
      const tagKey = bucketTagKey(entry.row.tags);
      const wouldExceedCount = currentEntries.length >= batchSize;
      const wouldExceedTagKeys =
        !currentTagKeys.has(tagKey) &&
        currentTagKeys.size >= MAX_TAG_KEYS_PER_LOCAL_BATCH;
      if (wouldExceedCount || wouldExceedTagKeys) {
        flush();
      }
      currentEntries.push(entry);
      currentTagKeys.add(tagKey);
    }
    flush();
  }

  return definitions;
}

async function processLocalBatch(
  definition: Stage2LocalBatchDefinition,
  options: Stage2LlmOptions,
): Promise<Stage2LocalBatchRun> {
  const result = await runStage2MergeLlm(definition.input, options);
  if (!result.success) {
    return {
      ...definition,
      candidateCount: definition.input.event_candidates.length,
      output: null,
      assignment: null,
      model: result.model,
      promptVersion: result.promptVersion,
      responseId: null,
      attempts: result.attempts,
      elapsedMs: result.elapsedMs,
      success: false,
      error: result.error,
    };
  }

  const assignment = validateStage2Assignments(result.output, definition.input);
  return {
    ...definition,
    candidateCount: definition.input.event_candidates.length,
    output: result.output,
    assignment,
    model: result.model,
    promptVersion: result.promptVersion,
    responseId: result.responseId,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
    success: assignment.passed,
    error: assignment.passed
      ? null
      : `Candidate assignment validation failed: ${assignment.errors.join("; ")}`,
  };
}

function buildPreliminaryGroups(
  localBatches: Stage2LocalBatchRun[],
  input: Stage2Input,
  candidateRows: Stage2CandidateRow[],
): Stage2PreliminaryGroup[] {
  const candidateById = new Map(
    input.event_candidates.map((candidate) => [candidate.temp_id, candidate]),
  );
  const rowById = new Map(
    input.event_candidates.map((candidate, index) => [
      candidate.temp_id,
      candidateRows[index],
    ]),
  );
  const preliminaryGroups: Stage2PreliminaryGroup[] = [];

  for (const batch of localBatches) {
    if (!batch.output) {
      throw new Error("Cannot build preliminary groups from a failed Stage 2A batch.");
    }
    for (const event of batch.output.events) {
      const candidates = event.sources.map((tempId) => {
        const candidate = candidateById.get(tempId);
        const row = rowById.get(tempId);
        if (!candidate || !row) {
          throw new Error(`Unknown Stage 2 candidate ${tempId} in preliminary group.`);
        }
        return { candidate, row };
      });

      preliminaryGroups.push({
        group_id: `G${String(preliminaryGroups.length + 1).padStart(3, "0")}`,
        event_hint: event.event_hint,
        candidate_ids: event.sources,
        representative_titles: uniqueStrings(
          candidates.map(({ candidate }) => candidate.title),
        ).slice(0, MAX_REPRESENTATIVE_TITLES),
        entities: uniqueStrings(
          candidates.flatMap(({ candidate }) => candidate.entities),
        ).slice(0, MAX_GROUP_ENTITIES),
        tags: uniqueStrings(candidates.flatMap(({ row }) => row.tags ?? [])).slice(
          0,
          MAX_GROUP_TAGS,
        ),
        categories: uniqueStrings(candidates.map(({ row }) => row.category)),
        batch_indexes: [batch.batchIndex],
      });
    }
  }

  return preliminaryGroups;
}

function toReconciliationInputGroup(
  group: Stage2PreliminaryGroup,
): Stage2ReconciliationInputGroup {
  return {
    group_id: group.group_id,
    event_hint: group.event_hint,
    candidate_ids: group.candidate_ids,
    representative_titles: group.representative_titles,
    entities: group.entities,
    tags: group.tags,
    categories: group.categories,
  };
}

function expandReconciliationOutput(
  reconciliationOutput: Stage2ReconciliationOutput,
  preliminaryGroups: Stage2PreliminaryGroup[],
): Stage2Output {
  const preliminaryById = new Map(
    preliminaryGroups.map((group) => [group.group_id, group]),
  );

  return {
    events: [
      ...reconciliationOutput.merged_groups.map((mergedGroup) => ({
        event_hint: mergedGroup.event_hint,
        sources: mergedGroup.group_ids.flatMap((groupId) => {
          const preliminary = preliminaryById.get(groupId);
          if (!preliminary) {
            throw new Error(`Unknown preliminary group ${groupId}.`);
          }
          return preliminary.candidate_ids;
        }),
      })),
      ...reconciliationOutput.single_group_ids.map((groupId) => {
        const preliminary = preliminaryById.get(groupId);
        if (!preliminary) {
          throw new Error(`Unknown preliminary group ${groupId}.`);
        }
        return {
          event_hint: preliminary.event_hint,
          sources: preliminary.candidate_ids,
        };
      }),
    ],
  };
}

function summarizeReconciliationMerges(
  output: Stage2ReconciliationOutput,
  preliminaryGroups: Stage2PreliminaryGroup[],
  input: Stage2Input,
): Pick<
  Stage2JobBase,
  "crossBatchMergeCount" | "crossCategoryMergeCount" | "crossBatchMergeExamples"
> {
  const preliminaryById = new Map(
    preliminaryGroups.map((group) => [group.group_id, group]),
  );
  const candidateById = new Map(
    input.event_candidates.map((candidate) => [candidate.temp_id, candidate]),
  );
  let crossBatchMergeCount = 0;
  let crossCategoryMergeCount = 0;
  const crossBatchMergeExamples: Stage2CrossBatchMergeExample[] = [];

  for (const mergedGroup of output.merged_groups) {
    const groups = mergedGroup.group_ids.map((groupId) => {
      const group = preliminaryById.get(groupId);
      if (!group) {
        throw new Error(`Unknown preliminary group ${groupId}.`);
      }
      return group;
    });
    const batchIndexes = new Set(groups.flatMap((group) => group.batch_indexes));
    const categories = uniqueStrings(groups.flatMap((group) => group.categories));
    const isCrossBatch = groups.length > 1 && batchIndexes.size > 1;
    const isCrossCategory = groups.length > 1 && categories.length > 1;

    if (isCrossBatch) {
      crossBatchMergeCount += 1;
      if (crossBatchMergeExamples.length < 10) {
        crossBatchMergeExamples.push({
          eventHint: mergedGroup.event_hint,
          groupIds: mergedGroup.group_ids,
          categories,
          preliminaryHints: groups.map((group) => group.event_hint),
          candidateTitles: uniqueStrings(
            groups.flatMap((group) =>
              group.candidate_ids.map(
                (candidateId) => candidateById.get(candidateId)?.title ?? candidateId,
              ),
            ),
          ),
        });
      }
    }
    if (isCrossCategory) {
      crossCategoryMergeCount += 1;
    }
  }

  return {
    crossBatchMergeCount,
    crossCategoryMergeCount,
    crossBatchMergeExamples,
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
    stage2aBatchCount: result.localBatches.length,
    stage2aBatchCandidateCounts: result.localBatches.map((batch) => batch.candidateCount),
    stage2aAssignmentsPassed: result.localBatches.every(
      (batch) => batch.assignment?.passed === true,
    ),
    preliminaryGroupCount: result.preliminaryGroups.length,
    stage2bInputGroupCount: result.reconciliationInput?.groups.length ?? 0,
    eventGroupCount,
    multiSourceGroupCount,
    singleSourceGroupCount,
    crossBatchMergeCount: result.crossBatchMergeCount,
    crossCategoryMergeCount: result.crossCategoryMergeCount,
    missingTempIds: result.assignment?.missingTempIds ?? [],
    duplicateTempIds: result.assignment?.duplicateTempIds ?? [],
    inventedTempIds: result.assignment?.inventedTempIds ?? [],
    assignmentValidationPassed: result.assignment?.passed ?? false,
    model: result.model,
    promptVersion: result.promptVersion,
    reconciliationPromptVersion: result.reconciliationPromptVersion,
    llmCallCount: result.llmCallCount,
    retryCount: result.retryCount,
    llmDurationMs: result.llmDurationMs,
    elapsedMs: result.elapsedMs,
    crossBatchMergeExamples: result.crossBatchMergeExamples,
    error: result.success ? null : result.error,
  };
}

function summarizeLlmRuns(runs: Stage2LocalBatchRun[]) {
  return {
    llmCallCount: runs.reduce((sum, run) => sum + run.attempts, 0),
    retryCount: runs.reduce((sum, run) => sum + Math.max(0, run.attempts - 1), 0),
    llmDurationMs: runs.reduce((sum, run) => sum + run.elapsedMs, 0),
  };
}

function addLlmMetrics(
  left: { llmCallCount: number; retryCount: number; llmDurationMs: number },
  right: { llmCallCount: number; retryCount: number; llmDurationMs: number },
) {
  return {
    llmCallCount: left.llmCallCount + right.llmCallCount,
    retryCount: left.retryCount + right.retryCount,
    llmDurationMs: left.llmDurationMs + right.llmDurationMs,
  };
}

function bucketTagKey(tags: string[] | null): string {
  return tags?.[0]?.trim().toLocaleLowerCase("en-US") || "~untagged";
}

function compareCategories(left: string, right: string): number {
  const leftIndex = CATEGORY_ORDER.indexOf(left);
  const rightIndex = CATEGORY_ORDER.indexOf(right);
  if (leftIndex === -1 && rightIndex === -1) {
    return left.localeCompare(right);
  }
  if (leftIndex === -1) {
    return 1;
  }
  if (rightIndex === -1) {
    return -1;
  }
  return leftIndex - rightIndex;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase("en-US");
    if (!trimmed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

function formatBatchNumber(batchIndex: number): string {
  return String(batchIndex).padStart(3, "0");
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}".`);
  }
  return parsed;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await task(items[currentIndex]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
