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
