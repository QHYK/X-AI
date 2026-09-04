/**
 * Stage 4 Event Enrichment 的 LLM 调用层。
 * 允许模型按需检索，并用实际工具调用记录覆盖模型自报的外部上下文字段。
 */
import {
  buildStage4EventEnrichmentInstructions,
  buildStage4EventEnrichmentUserPrompt,
  STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
  type Stage4EventEnrichmentInput,
} from "../prompts/stage4-event-enrichment.js";
import {
  createLlmClient,
  resolveStageLlmModel,
  resolveStageLlmProvider,
} from "./llm-client.js";
import {
  parseAndValidateStage4EventEnrichmentOutput,
  stage4EventEnrichmentOutputJsonSchema,
  type Stage4EventEnrichmentOutput,
} from "./stage4-contract.js";

export type Stage4LlmOptions = {
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

export type Stage4WebSearchToolUsage = {
  apiMode: "responses" | "chat_completions";
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  webSearchPerformed: boolean;
  webSearchCallCount: number;
  sources: string[];
  calls: Array<{
    id: string | null;
    status: string | null;
    actionType: string | null;
    sources: string[];
  }>;
};

export type Stage4LlmSuccess = {
  success: true;
  input: Stage4EventEnrichmentInput;
  output: Stage4EventEnrichmentOutput;
  rawStructuredOutput: Stage4EventEnrichmentOutput;
  toolUsage: Stage4WebSearchToolUsage;
  model: string;
  promptVersion: string;
  responseId: string;
  attempts: number;
  elapsedMs: number;
  rawOutputText: string;
};

export type Stage4LlmFailure = {
  success: false;
  input: Stage4EventEnrichmentInput;
  model: string;
  promptVersion: string;
  attempts: number;
  elapsedMs: number;
  error: string;
  rawOutputText: string | null;
};

export type Stage4LlmResult = Stage4LlmSuccess | Stage4LlmFailure;

const DEFAULT_TIMEOUT_MS = Number(process.env.STAGE4_LLM_TIMEOUT_MS ?? 240_000);
const DEFAULT_MAX_RETRIES = Number(process.env.STAGE4_LLM_MAX_RETRIES ?? 2);
const RETRY_DELAY_MS = Number(process.env.STAGE4_LLM_RETRY_DELAY_MS ?? 1_000);

/** 生成单个已选 Event 的可持久化双语内容，并校验 Structured Output。 */
export async function runStage4EventEnrichmentLlm(
  input: Stage4EventEnrichmentInput,
  options: Stage4LlmOptions = {},
): Promise<Stage4LlmResult> {
  const provider = resolveStageLlmProvider("stage4");
  const model = resolveStageLlmModel("stage4", options.model);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const client = createLlmClient({ provider, timeoutMs, maxRetries: 0 });
  const startedAt = Date.now();
  const useWebSearch = await determineWhetherExternalContextIsNeeded(client, model, input, timeoutMs);

  let rawOutputText: string | null = null;
  let lastError = "Unknown Stage 4 LLM failure.";
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attemptsUsed = attempt;
    try {
      const response = await (useWebSearch ? client.responses : client.structured).create(
        {
          model,
          instructions: buildStage4EventEnrichmentInstructions({ webSearchAvailable: useWebSearch }),
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: buildStage4EventEnrichmentUserPrompt(input),
                },
              ],
            },
          ],
          max_output_tokens: 4_000,
          ...(useWebSearch ? { tools: [{ type: "web_search" }], tool_choice: "auto" as const } : {}),
          store: false,
          text: {
            format: {
              type: "json_schema",
              name: "stage4_event_enrichment",
              description: "Structured Stage 4 selected event enrichment output.",
              schema: stage4EventEnrichmentOutputJsonSchema,
              strict: true,
            },
          },
        },
        {
          timeout: timeoutMs,
        },
      );

      rawOutputText = response.output_text;
      const validation = parseAndValidateStage4EventEnrichmentOutput(rawOutputText);
      if (!validation.success) {
        lastError = `Structured output validation failed: ${validation.errors.join("; ")}`;
        if (attempt <= maxRetries) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        break;
      }

      const toolUsage = useWebSearch
        ? extractWebSearchToolUsage(response)
        : emptyChatToolUsage(response);
      const normalizedOutput = normalizeExternalContext(validation.output, toolUsage);
      return {
        success: true,
        input,
        output: normalizedOutput,
        rawStructuredOutput: validation.output,
        toolUsage,
        model,
        promptVersion: STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
        responseId: response.id,
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        rawOutputText,
      };
    } catch (error) {
      lastError = sanitizeLlmError(error instanceof Error ? error.message : String(error));
      if (isNonRetryableLlmError(lastError)) {
        break;
      }

      if (attempt <= maxRetries) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
    }
  }

  return {
    success: false,
    input,
    model,
    promptVersion: STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION,
    attempts: attemptsUsed,
    elapsedMs: Date.now() - startedAt,
    error: lastError,
    rawOutputText,
  };
}

/**
 * Web Search 仅在缺失事实会实质影响事件理解时启用；判断本身不持久化，也不新增 Pipeline stage。
 * 判断失败时保守地使用已有 source 内容，不把一次判定故障扩大为默认检索。
 */
async function determineWhetherExternalContextIsNeeded(
  client: ReturnType<typeof createLlmClient>,
  model: string,
  input: Stage4EventEnrichmentInput,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await client.structured.create({
      model,
      instructions: [
        "Decide whether external web context is necessary before enriching this event.",
        "Return need_external_context=true only when a critical fact is missing from the provided reports and that gap would materially impair understanding: necessary background, a latest development that cannot be determined, important factual conflict, or needed authoritative confirmation.",
        "Do not request search merely because more facts may exist. If the reports already explain what happened, needed background, why it matters, and material source differences, return false.",
      ].join("\n"),
      input: buildStage4EventEnrichmentUserPrompt(input),
      max_output_tokens: 64,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "stage4_external_context_decision",
          description: "Whether Stage 4 requires external web context before enrichment.",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["need_external_context"],
            properties: { need_external_context: { type: "boolean" } },
          },
        },
      },
    }, { timeout: timeoutMs });
    return parseStage4ExternalContextDecision(response.output_text);
  } catch (error) {
    console.warn(
      "Stage 4 external-context decision failed; continuing without Web Search.",
      sanitizeLlmError(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

function parseStage4ExternalContextDecision(rawText: string): boolean {
  const parsed: unknown = JSON.parse(rawText);
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.need_external_context !== "boolean"
  ) {
    throw new Error("Invalid Stage 4 external-context decision structured output.");
  }
  return parsed.need_external_context;
}

function emptyChatToolUsage(response: { usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }): Stage4WebSearchToolUsage {
  return {
    apiMode: "chat_completions",
    usage: normalizeUsage(response.usage),
    webSearchPerformed: false,
    webSearchCallCount: 0,
    sources: [],
    calls: [],
  };
}

/** 以 API 返回的真实 web search 轨迹为准，防止输出声称未实际发生的检索。 */
function normalizeExternalContext(
  output: Stage4EventEnrichmentOutput,
  toolUsage: Stage4WebSearchToolUsage,
): Stage4EventEnrichmentOutput {
  return {
    ...output,
    external_context: {
      performed: toolUsage.webSearchPerformed,
      sources: toolUsage.webSearchPerformed ? toolUsage.sources : [],
      sources_summary: toolUsage.webSearchPerformed
        ? output.external_context.sources_summary
        : "",
    },
  };
}

function extractWebSearchToolUsage(response: unknown): Stage4WebSearchToolUsage {
  const calls: Stage4WebSearchToolUsage["calls"] = [];
  const sources = new Set<string>();
  const outputItems = isRecord(response) && Array.isArray(response.output) ? response.output : [];

  for (const item of outputItems) {
    collectUrlCitations(item, sources);
    if (!isRecord(item) || item.type !== "web_search_call") {
      continue;
    }

    const itemSources = new Set<string>();
    collectWebSearchActionSources(item.action, itemSources);
    for (const source of itemSources) {
      sources.add(source);
    }

    calls.push({
      id: typeof item.id === "string" ? item.id : null,
      status: typeof item.status === "string" ? item.status : null,
      actionType:
        isRecord(item.action) && typeof item.action.type === "string" ? item.action.type : null,
      sources: [...itemSources],
    });
  }

  return {
    apiMode: "responses",
    usage: isRecord(response) && isRecord(response.usage)
      ? normalizeUsage(response.usage as { input_tokens: number; output_tokens: number; total_tokens: number })
      : null,
    webSearchPerformed: calls.length > 0,
    webSearchCallCount: calls.length,
    sources: [...sources].sort(),
    calls,
  };
}

function normalizeUsage(
  usage: { input_tokens: number; output_tokens: number; total_tokens: number } | undefined,
) {
  return usage
    ? {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
      }
    : null;
}

function collectWebSearchActionSources(value: unknown, sources: Set<string>) {
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.url === "string") {
    sources.add(value.url);
  }

  if (Array.isArray(value.sources)) {
    for (const source of value.sources) {
      if (isRecord(source) && typeof source.url === "string") {
        sources.add(source.url);
      }
    }
  }
}

function collectUrlCitations(value: unknown, sources: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectUrlCitations(item, sources);
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  if (value.type === "url_citation" && typeof value.url === "string") {
    sources.add(value.url);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "text") {
      continue;
    }

    if (typeof nestedValue === "object" && nestedValue !== null) {
      collectUrlCitations(nestedValue, sources);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonRetryableLlmError(errorMessage: string): boolean {
  return (
    errorMessage.includes("401") ||
    errorMessage.includes("Incorrect API key") ||
    errorMessage.includes("invalid_api_key")
  );
}

function sanitizeLlmError(errorMessage: string): string {
  return errorMessage.replace(/sk-[A-Za-z0-9_*.-]+/g, "[redacted_api_key]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
