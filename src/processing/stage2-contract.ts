/**
 * Stage 2 Event Merge 的 Structured Output 契约与完整性校验。
 * 校验 temp_id assignment，确保下游能够安全地把模型分组映射回 processed_contents。
 */
import type { Stage2Input } from "./stage2-candidates.js";

export type { Stage2Input, Stage2InputCandidate } from "./stage2-candidates.js";

export type Stage2EventGroup = {
  event_hint: string;
  sources: string[];
};

export type Stage2Output = {
  events: Stage2EventGroup[];
};

export type Stage2ValidationResult =
  | {
      success: true;
      output: Stage2Output;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage2AssignmentValidation = {
  /** Fatal only when the model names an ID that cannot be mapped to input. */
  passed: boolean;
  missingTempIds: string[];
  /** A candidate used by more than one distinct Event Group (warning). */
  crossGroupMemberships: Array<{ tempId: string; eventGroups: number[] }>;
  /** Repeated occurrences within one Event Group (warning; normalized before persistence). */
  sameGroupDuplicates: Array<{ tempId: string; eventGroup: number }>;
  /** Legacy summary retained for existing diagnostic consumers. */
  duplicateTempIds: string[];
  inventedTempIds: string[];
  errors: string[];
};

export const stage2OutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["events"],
  properties: {
    events: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_hint", "sources"],
        properties: {
          event_hint: { type: "string" },
          sources: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
          },
        },
      },
    },
  },
} as const;

export function parseAndValidateStage2Output(rawText: string): Stage2ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage2Output(parsed);
}

export function validateStage2Output(value: unknown): Stage2ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }

  if (!Array.isArray(value.events)) {
    return { success: false, errors: ["events must be an array."] };
  }

  value.events.forEach((event, index) => {
    if (!isRecord(event)) {
      errors.push(`events[${index}] must be an object.`);
      return;
    }

    if (typeof event.event_hint !== "string") {
      errors.push(`events[${index}].event_hint must be a string.`);
    }

    if (!Array.isArray(event.sources)) {
      errors.push(`events[${index}].sources must be an array.`);
      return;
    }

    if (event.sources.length === 0) {
      errors.push(`events[${index}].sources must contain at least one temp_id.`);
    }

    if (!event.sources.every((source) => typeof source === "string")) {
      errors.push(`events[${index}].sources must only contain strings.`);
    }
  });

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage2Output,
  };
}

/**
 * Classifies assignment quality without turning usable output into a failure.
 * Stage 2 still asks the model for an exclusive, complete grouping, but the
 * database snapshot can safely represent cross-group memberships. Only an
 * unmappable ID is fatal because it cannot be persisted truthfully.
 */
export function validateStage2Assignments(
  output: Stage2Output,
  input: Stage2Input,
): Stage2AssignmentValidation {
  const expected = new Set(input.event_candidates.map((candidate) => candidate.temp_id));
  const groupIndexesByTempId = new Map<string, number[]>();
  const sameGroupDuplicates: Array<{ tempId: string; eventGroup: number }> = [];
  const inventedTempIds = new Set<string>();

  output.events.forEach((event, eventIndex) => {
    const seenInGroup = new Set<string>();
    event.sources.forEach((tempId) => {
      if (!expected.has(tempId)) {
        inventedTempIds.add(tempId);
        return;
      }
      if (seenInGroup.has(tempId)) {
        sameGroupDuplicates.push({ tempId, eventGroup: eventIndex + 1 });
        return;
      }
      seenInGroup.add(tempId);
      const indexes = groupIndexesByTempId.get(tempId) ?? [];
      indexes.push(eventIndex + 1);
      groupIndexesByTempId.set(tempId, indexes);
    });
  });

  const missingTempIds = [...expected].filter((tempId) => !groupIndexesByTempId.has(tempId));
  const crossGroupMemberships = [...groupIndexesByTempId.entries()]
    .filter(([, groupIndexes]) => groupIndexes.length > 1)
    .map(([tempId, eventGroups]) => ({ tempId, eventGroups }));
  const duplicateTempIds = [...new Set([
    ...crossGroupMemberships.map(({ tempId }) => tempId),
    ...sameGroupDuplicates.map(({ tempId }) => tempId),
  ])];
  const errors: string[] = [];

  for (const tempId of inventedTempIds) {
    errors.push(`Invented or modified temp_id ${tempId}.`);
  }

  return {
    passed: errors.length === 0,
    missingTempIds,
    crossGroupMemberships,
    sameGroupDuplicates,
    duplicateTempIds,
    inventedTempIds: [...inventedTempIds],
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
