export type Stage3RankingItem = {
  id: string;
  rank: number;
  reason: string;
};

export type Stage3RankingOutput = {
  rankings: Stage3RankingItem[];
};

export type Stage3ValidationResult =
  | {
      success: true;
      output: Stage3RankingOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage3RankingIntegrity = {
  passed: boolean;
  missingIds: string[];
  duplicateIds: string[];
  inventedIds: string[];
  duplicateRanks: number[];
  missingRanks: number[];
  errors: string[];
};

export const stage3RankingOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rankings"],
  properties: {
    rankings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "rank", "reason"],
        properties: {
          id: { type: "string" },
          rank: { type: "integer", minimum: 1 },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export function parseAndValidateStage3RankingOutput(rawText: string): Stage3ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage3RankingOutput(parsed);
}

export function validateStage3RankingOutput(value: unknown): Stage3ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }

  if (!Array.isArray(value.rankings)) {
    return { success: false, errors: ["rankings must be an array."] };
  }

  value.rankings.forEach((ranking, index) => {
    if (!isRecord(ranking)) {
      errors.push(`rankings[${index}] must be an object.`);
      return;
    }

    if (typeof ranking.id !== "string") {
      errors.push(`rankings[${index}].id must be a string.`);
    }

    const rank = ranking.rank;
    if (typeof rank !== "number" || !Number.isInteger(rank) || rank < 1) {
      errors.push(`rankings[${index}].rank must be a positive integer.`);
    }

    if (typeof ranking.reason !== "string") {
      errors.push(`rankings[${index}].reason must be a string.`);
    }
  });

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage3RankingOutput,
  };
}

export function validateStage3RankingIntegrity(
  output: Stage3RankingOutput,
  expectedIds: string[],
): Stage3RankingIntegrity {
  const expected = new Set(expectedIds);
  const seenIds = new Map<string, number>();
  const seenRanks = new Map<number, number>();
  const inventedIds = new Set<string>();

  for (const ranking of output.rankings) {
    if (!expected.has(ranking.id)) {
      inventedIds.add(ranking.id);
    } else {
      seenIds.set(ranking.id, (seenIds.get(ranking.id) ?? 0) + 1);
    }

    seenRanks.set(ranking.rank, (seenRanks.get(ranking.rank) ?? 0) + 1);
  }

  const missingIds = [...expected].filter((id) => !seenIds.has(id));
  const duplicateIds = [...seenIds.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const duplicateRanks = [...seenRanks.entries()]
    .filter(([, count]) => count > 1)
    .map(([rank]) => rank)
    .sort((left, right) => left - right);
  const missingRanks = Array.from({ length: expectedIds.length }, (_, index) => index + 1).filter(
    (rank) => !seenRanks.has(rank),
  );
  const errors: string[] = [];

  for (const id of missingIds) {
    errors.push(`Missing id ${id}.`);
  }

  for (const id of duplicateIds) {
    errors.push(`Duplicate ranking for id ${id}.`);
  }

  for (const id of inventedIds) {
    errors.push(`Invented id ${id}.`);
  }

  for (const rank of duplicateRanks) {
    errors.push(`Duplicate rank ${rank}.`);
  }

  for (const rank of missingRanks) {
    errors.push(`Missing rank ${rank}.`);
  }

  return {
    passed: errors.length === 0,
    missingIds,
    duplicateIds,
    inventedIds: [...inventedIds],
    duplicateRanks,
    missingRanks,
    errors,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
