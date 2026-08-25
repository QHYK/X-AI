/**
 * Stage 3 三类排名的 Structured Output 契约与完整性校验。
 * 模型输出先验证 JSON，再验证 ID/rank 排列，防止错误排名污染 persistence。
 */
export type Stage3RankingItem = {
  id: string;
  rank: number;
  reason?: string;
};

export type Stage3EventRankingItem = {
  id: string;
  event_hint: string;
  source_count: number;
  sources: Array<{
    source: string;
    title: string;
    summary: string;
  }>;
};

export type Stage3EventRankingInput = {
  events: Stage3EventRankingItem[];
};

export type Stage3RankingOutput = {
  rankings: Stage3RankingItem[];
};

export type Stage3EventRankingOutput = {
  ordered_ids: string[];
};

export const MAX_STAGE3_EVENT_RANKINGS = 50;

export type Stage3EventRankedOutput = {
  rankings: Array<{
    id: string;
    rank: number;
  }>;
};

export type Stage3EventRankingValidationResult =
  | {
      success: true;
      output: Stage3EventRankingOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage3EventRankingIntegrity = {
  passed: boolean;
  missingIds: string[];
  duplicateIds: string[];
  inventedIds: string[];
  errors: string[];
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

export const stage3EventRankingOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ordered_ids"],
  properties: {
    ordered_ids: {
      type: "array",
      maxItems: MAX_STAGE3_EVENT_RANKINGS,
      items: { type: "string" },
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

/** 验证通用 ranking 是否覆盖全部候选且 rank 为连续、唯一的排列。 */
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

export function validateStage3DigestRankingIntegrity(
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
  const missingRanks = Array.from(
    { length: output.rankings.length },
    (_, index) => index + 1,
  ).filter((rank) => !seenRanks.has(rank));
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

export type Stage3DigestOrderedIdsOutput = {
  ordered_ids: string[];
};

export type Stage3DigestOrderedIdsValidationResult =
  | {
      success: true;
      output: Stage3DigestOrderedIdsOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export const stage3DigestOrderedIdsOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ordered_ids"],
  properties: {
    ordered_ids: {
      type: "array",
      items: { type: "string" },
    },
  },
} as const;

export function parseAndValidateStage3DigestOrderedIdsOutput(
  rawText: string,
): Stage3DigestOrderedIdsValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!isRecord(parsed)) {
    return { success: false, errors: ["Output must be an object."] };
  }
  if (!Array.isArray(parsed.ordered_ids)) {
    return { success: false, errors: ["ordered_ids must be an array."] };
  }
  if (!parsed.ordered_ids.every((id) => typeof id === "string")) {
    return { success: false, errors: ["ordered_ids must only contain strings."] };
  }

  return {
    success: true,
    output: parsed as Stage3DigestOrderedIdsOutput,
  };
}

export function rebuildStage3DigestRankingFromOrderedIds(
  orderedIds: string[],
): Stage3RankingOutput {
  return {
    rankings: orderedIds.map((id, index) => ({
      id,
      rank: index + 1,
    })),
  };
}

export function parseAndValidateStage3EventRankingOutput(
  rawText: string,
): Stage3EventRankingValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  if (!isRecord(parsed)) {
    return { success: false, errors: ["Output must be an object."] };
  }
  if (!Array.isArray(parsed.ordered_ids)) {
    return { success: false, errors: ["ordered_ids must be an array."] };
  }
  if (!parsed.ordered_ids.every((id) => typeof id === "string")) {
    return { success: false, errors: ["ordered_ids must only contain strings."] };
  }
  if (parsed.ordered_ids.length > MAX_STAGE3_EVENT_RANKINGS) {
    return {
      success: false,
      errors: [
        `ordered_ids must contain at most ${MAX_STAGE3_EVENT_RANKINGS} IDs, got ${parsed.ordered_ids.length}.`,
      ],
    };
  }

  return {
    success: true,
    output: parsed as Stage3EventRankingOutput,
  };
}

/** Event Ranking 允许只选择 Top 50，因此只拒绝虚构 ID，不将未选 ID 视为错误。 */
export function validateStage3EventRankingIntegrity(
  output: Stage3EventRankingOutput,
  expectedIds: string[],
): Stage3EventRankingIntegrity {
  const expected = new Set(expectedIds);
  const seen = new Map<string, number>();
  const inventedIds = new Set<string>();

  for (const id of output.ordered_ids) {
    if (!expected.has(id)) {
      inventedIds.add(id);
      continue;
    }
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  const missingIds = [...expected].filter((id) => !seen.has(id));
  const duplicateIds = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
  const errors = [...inventedIds].map((id) => `Invented or modified id ${id}.`);

  return {
    passed: errors.length === 0,
    missingIds,
    duplicateIds,
    inventedIds: [...inventedIds],
    errors,
  };
}

export function deduplicateStage3EventRankingOutput(
  output: Stage3EventRankingOutput,
): Stage3EventRankingOutput {
  return {
    ordered_ids: output.ordered_ids.filter(
      (id, index, orderedIds) => orderedIds.indexOf(id) === index,
    ),
  };
}

export function deriveStage3EventRankings(
  output: Stage3EventRankingOutput,
): Stage3EventRankedOutput {
  return {
    rankings: output.ordered_ids.map((id, index) => ({
      id,
      rank: index + 1,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
