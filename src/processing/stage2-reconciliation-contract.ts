export type Stage2ReconciliationInputGroup = {
  group_id: string;
  event_hint: string;
  candidate_ids: string[];
  representative_titles: string[];
  entities: string[];
  tags: string[];
  categories: string[];
};

export type Stage2ReconciliationInput = {
  groups: Stage2ReconciliationInputGroup[];
};

export type Stage2ReconciledGroup = {
  event_hint: string;
  group_ids: string[];
};

export type Stage2ReconciliationOutput = {
  merged_groups: Stage2ReconciledGroup[];
  single_group_ids: string[];
};

export type Stage2ReconciliationValidationResult =
  | {
      success: true;
      output: Stage2ReconciliationOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage2ReconciliationAssignment = {
  passed: boolean;
  missingGroupIds: string[];
  duplicateGroupIds: string[];
  inventedGroupIds: string[];
  errors: string[];
};

export const stage2ReconciliationOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["merged_groups", "single_group_ids"],
  properties: {
    merged_groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event_hint", "group_ids"],
        properties: {
          event_hint: { type: "string" },
          group_ids: {
            type: "array",
            minItems: 2,
            items: { type: "string" },
          },
        },
      },
    },
    single_group_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export function parseAndValidateStage2ReconciliationOutput(
  rawText: string,
): Stage2ReconciliationValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage2ReconciliationOutput(parsed);
}

export function validateStage2ReconciliationOutput(
  value: unknown,
): Stage2ReconciliationValidationResult {
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }
  if (!Array.isArray(value.merged_groups)) {
    return { success: false, errors: ["merged_groups must be an array."] };
  }
  if (!Array.isArray(value.single_group_ids)) {
    return { success: false, errors: ["single_group_ids must be an array."] };
  }

  const errors: string[] = [];
  value.merged_groups.forEach((group, index) => {
    if (!isRecord(group)) {
      errors.push(`merged_groups[${index}] must be an object.`);
      return;
    }
    if (typeof group.event_hint !== "string") {
      errors.push(`merged_groups[${index}].event_hint must be a string.`);
    }
    if (!Array.isArray(group.group_ids)) {
      errors.push(`merged_groups[${index}].group_ids must be an array.`);
      return;
    }
    if (group.group_ids.length < 2) {
      errors.push(`merged_groups[${index}].group_ids must contain at least two IDs.`);
    }
    if (!group.group_ids.every((groupId) => typeof groupId === "string")) {
      errors.push(`merged_groups[${index}].group_ids must only contain strings.`);
    }
  });
  if (!value.single_group_ids.every((groupId) => typeof groupId === "string")) {
    errors.push("single_group_ids must only contain strings.");
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage2ReconciliationOutput,
  };
}

export function validateStage2ReconciliationAssignments(
  output: Stage2ReconciliationOutput,
  input: Stage2ReconciliationInput,
): Stage2ReconciliationAssignment {
  const expected = new Set(input.groups.map((group) => group.group_id));
  const seen = new Map<string, number>();
  const inventedGroupIds = new Set<string>();

  for (const group of output.merged_groups) {
    for (const groupId of group.group_ids) {
      if (!expected.has(groupId)) {
        inventedGroupIds.add(groupId);
        continue;
      }
      seen.set(groupId, (seen.get(groupId) ?? 0) + 1);
    }
  }
  for (const groupId of output.single_group_ids) {
    if (!expected.has(groupId)) {
      inventedGroupIds.add(groupId);
      continue;
    }
    seen.set(groupId, (seen.get(groupId) ?? 0) + 1);
  }

  const missingGroupIds = [...expected].filter((groupId) => !seen.has(groupId));
  const duplicateGroupIds = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([groupId]) => groupId);
  const errors = [
    ...missingGroupIds.map((groupId) => `Missing group_id ${groupId}.`),
    ...duplicateGroupIds.map((groupId) => `Duplicate assignment for group_id ${groupId}.`),
    ...[...inventedGroupIds].map(
      (groupId) => `Invented or modified group_id ${groupId}.`,
    ),
  ];

  return {
    passed: errors.length === 0,
    missingGroupIds,
    duplicateGroupIds,
    inventedGroupIds: [...inventedGroupIds],
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
