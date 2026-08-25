/**
 * Stage 4 Event Enrichment 的 Structured Output 契约。
 * 输出在写入 events 前由此验证，确保双语内容、来源视角与外部检索上下文结构一致。
 */
export type Stage4SourcePerspective = {
  source: string;
  summary: string;
};

export type Stage4ExternalContext = {
  performed: boolean;
  sources: string[];
  sources_summary: string;
};

export type Stage4EventEnrichmentOutput = {
  event_title: string;
  event_title_zh: string;
  event_tags: string[];
  event_tags_zh: string[];
  event_entities: string[];
  event_entities_zh: string[];
  event_summary: string;
  event_summary_zh: string;
  source_perspectives: Stage4SourcePerspective[];
  external_context: Stage4ExternalContext;
};

export type Stage4ValidationResult =
  | {
      success: true;
      output: Stage4EventEnrichmentOutput;
    }
  | {
      success: false;
      errors: string[];
    };

export const stage4EventEnrichmentOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "event_title",
    "event_title_zh",
    "event_tags",
    "event_tags_zh",
    "event_entities",
    "event_entities_zh",
    "event_summary",
    "event_summary_zh",
    "source_perspectives",
    "external_context",
  ],
  properties: {
    event_title: { type: "string" },
    event_title_zh: { type: "string" },
    event_tags: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
    event_tags_zh: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
    event_entities: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    event_entities_zh: {
      type: "array",
      maxItems: 3,
      items: { type: "string" },
    },
    event_summary: { type: "string" },
    event_summary_zh: { type: "string" },
    source_perspectives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "summary"],
        properties: {
          source: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    external_context: {
      type: "object",
      additionalProperties: false,
      required: ["performed", "sources", "sources_summary"],
      properties: {
        performed: { type: "boolean" },
        sources: {
          type: "array",
          items: { type: "string" },
        },
        sources_summary: { type: "string" },
      },
    },
  },
} as const;

export function parseAndValidateStage4EventEnrichmentOutput(
  rawText: string,
): Stage4ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return validateStage4EventEnrichmentOutput(parsed);
}

/** 校验 LLM 输出的全部持久化字段与数量限制，拒绝不完整的 Event 内容。 */
export function validateStage4EventEnrichmentOutput(value: unknown): Stage4ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { success: false, errors: ["Output must be an object."] };
  }

  const stringFields = [
    "event_title",
    "event_title_zh",
    "event_summary",
    "event_summary_zh",
  ];
  for (const field of stringFields) {
    if (typeof value[field] !== "string") {
      errors.push(`${field} must be a string.`);
    }
  }

  validateStringArray(value, "event_tags", 5, errors);
  validateStringArray(value, "event_tags_zh", 5, errors);
  validateStringArray(value, "event_entities", 3, errors);
  validateStringArray(value, "event_entities_zh", 3, errors);

  if (!Array.isArray(value.source_perspectives)) {
    errors.push("source_perspectives must be an array.");
  } else {
    value.source_perspectives.forEach((perspective, index) => {
      if (!isRecord(perspective)) {
        errors.push(`source_perspectives[${index}] must be an object.`);
        return;
      }

      if (typeof perspective.source !== "string") {
        errors.push(`source_perspectives[${index}].source must be a string.`);
      }

      if (typeof perspective.summary !== "string") {
        errors.push(`source_perspectives[${index}].summary must be a string.`);
      }
    });
  }

  if (!isRecord(value.external_context)) {
    errors.push("external_context must be an object.");
  } else {
    if (typeof value.external_context.performed !== "boolean") {
      errors.push("external_context.performed must be a boolean.");
    }

    if (!Array.isArray(value.external_context.sources)) {
      errors.push("external_context.sources must be an array.");
    } else if (!value.external_context.sources.every((source) => typeof source === "string")) {
      errors.push("external_context.sources must only contain strings.");
    }

    if (typeof value.external_context.sources_summary !== "string") {
      errors.push("external_context.sources_summary must be a string.");
    }
  }

  if (errors.length > 0) {
    return { success: false, errors };
  }

  return {
    success: true,
    output: value as Stage4EventEnrichmentOutput,
  };
}

function validateStringArray(
  value: Record<string, unknown>,
  field: string,
  maxItems: number,
  errors: string[],
) {
  const fieldValue = value[field];
  if (!Array.isArray(fieldValue)) {
    errors.push(`${field} must be an array.`);
    return;
  }

  if (fieldValue.length > maxItems) {
    errors.push(`${field} must contain at most ${maxItems} items.`);
  }

  if (!fieldValue.every((item) => typeof item === "string")) {
    errors.push(`${field} must only contain strings.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
