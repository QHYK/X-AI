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
  passed: boolean;
  missingTempIds: string[];
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

export function validateStage2Assignments(
  output: Stage2Output,
  input: Stage2Input,
): Stage2AssignmentValidation {
  const expected = new Set(input.event_candidates.map((candidate) => candidate.temp_id));
  const seen = new Map<string, number>();
  const inventedTempIds = new Set<string>();

  output.events.forEach((event) => {
    event.sources.forEach((tempId) => {
      if (!expected.has(tempId)) {
        inventedTempIds.add(tempId);
        return;
      }

      seen.set(tempId, (seen.get(tempId) ?? 0) + 1);
    });
  });

  const missingTempIds = [...expected].filter((tempId) => !seen.has(tempId));
  const duplicateTempIds = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([tempId]) => tempId);
  const errors: string[] = [];

  for (const tempId of missingTempIds) {
    errors.push(`Missing temp_id ${tempId}.`);
  }

  for (const tempId of duplicateTempIds) {
    errors.push(`Duplicate assignment for temp_id ${tempId}.`);
  }

  for (const tempId of inventedTempIds) {
    errors.push(`Invented or modified temp_id ${tempId}.`);
  }

  return {
    passed: errors.length === 0,
    missingTempIds,
    duplicateTempIds,
    inventedTempIds: [...inventedTempIds],
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
