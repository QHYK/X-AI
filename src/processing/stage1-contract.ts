export type Stage1Input = {
  title: string;
  url: string | null;
  author: string | null;
  content: string;
  source_name: string;
  source_tags: string[] | null;
  source_metadata: {
    category: string;
    source_type: string | null;
    priority: string;
    event_candidate: boolean;
    source_digest_candidate: boolean;
    availability: string | null;
    language: string;
    published_at: string | null;
  };
};

export type Stage1BatchInputArticle = Stage1Input & {
  temp_id: string;
};

export type Stage1BatchInput = {
  articles: Stage1BatchInputArticle[];
};

export type Stage1Output = {
  category: Stage1Category;
  tags: string[];
  entities: string[];
  entities_zh: string[];
  routing: Stage1Routing;
  generated_content: {
    summary: string;
    summary_zh: string;
    title_zh: string;
  };
};

export type Stage1BatchOutputResult = Stage1Output & {
  temp_id: string;
};

export type Stage1BatchOutput = {
  results: Stage1BatchOutputResult[];
};

export type Stage1Category =
  | "Finance & Economy"
  | "Technology"
  | "Science"
  | "Policy"
  | "Company"
  | "General"
  | "Long-form";

export type Stage1Routing = "Event" | "Digest" | "Long-form" | "Inspiration" | "Ignore";

export type Stage1ArticleRow = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  contentText: string | null;
  publishedAt: Date | null;
  sourceTags: string[] | null;
  sourceName: string;
  sourceCategory: string;
  sourceType: string | null;
  sourcePriority: string;
  eventCandidate: boolean;
  sourceDigestCandidate: boolean;
  sourceAvailability: string | null;
  sourceLanguage: string;
};

export type Stage1ValidationResult =
  | {
      success: true;
      output: Stage1Output;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage1BatchValidationResult =
  | {
      success: true;
      output: Stage1BatchOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export type Stage1AssignmentValidation = {
  passed: boolean;
  missingTempIds: string[];
  duplicateTempIds: string[];
  inventedTempIds: string[];
  errors: string[];
};

const STAGE1_CATEGORIES = new Set<Stage1Category>([
  "Finance & Economy",
  "Technology",
  "Science",
  "Policy",
  "Company",
  "General",
  "Long-form",
]);

const STAGE1_ROUTINGS = new Set<Stage1Routing>([
  "Event",
  "Digest",
  "Long-form",
  "Inspiration",
  "Ignore",
]);

export const MAX_STAGE1_TAGS = 5;
export const MAX_STAGE1_ENTITIES = 3;

export const stage1OutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["category", "tags", "entities", "entities_zh", "routing", "generated_content"],
  properties: {
    category: {
      type: "string",
      enum: [...STAGE1_CATEGORIES],
    },
    tags: {
      type: "array",
      maxItems: MAX_STAGE1_TAGS,
      items: { type: "string" },
    },
    entities: {
      type: "array",
      maxItems: MAX_STAGE1_ENTITIES,
      items: { type: "string" },
    },
    entities_zh: {
      type: "array",
      maxItems: MAX_STAGE1_ENTITIES,
      items: { type: "string" },
    },
    routing: {
      type: "string",
      enum: [...STAGE1_ROUTINGS],
    },
    generated_content: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "summary_zh", "title_zh"],
      properties: {
        summary: { type: "string" },
        summary_zh: { type: "string" },
        title_zh: { type: "string" },
      },
    },
  },
} as const;

export const stage1BatchOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["temp_id", ...stage1OutputJsonSchema.required],
        properties: {
          temp_id: { type: "string" },
          ...stage1OutputJsonSchema.properties,
        },
      },
    },
  },
} as const;

export function buildStage1Input(row: Stage1ArticleRow): Stage1Input {
  return {
    title: row.title,
    url: row.url,
    author: row.author,
    content: row.contentText?.trim() ?? "",
    source_name: row.sourceName,
    source_tags: row.sourceTags,
    source_metadata: {
      category: row.sourceCategory,
      source_type: row.sourceType,
      priority: row.sourcePriority,
      event_candidate: row.eventCandidate,
      source_digest_candidate: row.sourceDigestCandidate,
      availability: row.sourceAvailability,
      language: row.sourceLanguage,
      published_at: row.publishedAt?.toISOString() ?? null,
    },
  };
}

export function buildStage1BatchInput(rows: Stage1ArticleRow[]): Stage1BatchInput {
  return {
    articles: rows.map((row, index) => ({
      temp_id: `A${String(index + 1).padStart(3, "0")}`,
      ...buildStage1Input(row),
    })),
  };
}

export function parseAndValidateStage1Output(rawText: string): Stage1ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage1Output(parsed);
}

export function validateStage1Output(value: unknown): Stage1ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }

  const category = value.category;
  if (typeof category !== "string" || !STAGE1_CATEGORIES.has(category as Stage1Category)) {
    errors.push("category must be a valid Stage 1 category.");
  }

  validateStringArray(value.tags, "tags", errors, MAX_STAGE1_TAGS);
  validateStringArray(value.entities, "entities", errors, MAX_STAGE1_ENTITIES);
  validateStringArray(value.entities_zh, "entities_zh", errors, MAX_STAGE1_ENTITIES);

  const routing = value.routing;
  if (typeof routing !== "string" || !STAGE1_ROUTINGS.has(routing as Stage1Routing)) {
    errors.push("routing must be one of Event, Digest, Long-form, Inspiration, Ignore.");
  }

  if (!isRecord(value.generated_content)) {
    errors.push("generated_content must be an object.");
  } else {
    for (const field of ["summary", "summary_zh", "title_zh"] as const) {
      if (typeof value.generated_content[field] !== "string") {
        errors.push(`generated_content.${field} must be a string.`);
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage1Output,
  };
}

export function parseAndValidateStage1BatchOutput(rawText: string): Stage1BatchValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage1BatchOutput(parsed);
}

export function validateStage1BatchOutput(value: unknown): Stage1BatchValidationResult {
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }

  if (!Array.isArray(value.results)) {
    return { success: false, errors: ["results must be an array."] };
  }

  const errors: string[] = [];
  value.results.forEach((result, index) => {
    if (!isRecord(result)) {
      errors.push(`results[${index}] must be an object.`);
      return;
    }

    if (typeof result.temp_id !== "string") {
      errors.push(`results[${index}].temp_id must be a string.`);
    }

    const businessValidation = validateStage1Output(result);
    if (!businessValidation.success) {
      errors.push(
        ...businessValidation.errors.map((error) => `results[${index}].${error}`),
      );
    }
  });

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage1BatchOutput,
  };
}

export function validateStage1Assignments(
  output: Stage1BatchOutput,
  input: Stage1BatchInput,
): Stage1AssignmentValidation {
  const expected = new Set(input.articles.map((article) => article.temp_id));
  const seen = new Map<string, number>();
  const inventedTempIds = new Set<string>();

  for (const result of output.results) {
    if (!expected.has(result.temp_id)) {
      inventedTempIds.add(result.temp_id);
      continue;
    }

    seen.set(result.temp_id, (seen.get(result.temp_id) ?? 0) + 1);
  }

  const missingTempIds = [...expected].filter((tempId) => !seen.has(tempId));
  const duplicateTempIds = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([tempId]) => tempId);
  const errors = [
    ...missingTempIds.map((tempId) => `Missing temp_id ${tempId}.`),
    ...duplicateTempIds.map((tempId) => `Duplicate assignment for temp_id ${tempId}.`),
    ...[...inventedTempIds].map((tempId) => `Invented or modified temp_id ${tempId}.`),
  ];

  return {
    passed: errors.length === 0,
    missingTempIds,
    duplicateTempIds,
    inventedTempIds: [...inventedTempIds],
    errors,
  };
}

function validateStringArray(
  value: unknown,
  fieldName: string,
  errors: string[],
  maxItems: number,
) {
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array.`);
    return;
  }

  if (!value.every((item) => typeof item === "string")) {
    errors.push(`${fieldName} must only contain strings.`);
  }

  if (value.length > maxItems) {
    errors.push(`${fieldName} must contain at most ${maxItems} items.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
