/**
 * Stage 4 Event Enrichment Prompt builder。
 * 基于已选 Event 的来源材料生成最终双语内容；event_date 仍由应用层从时间戳推导。
 */
export type Stage4EventSourceInput = {
  title: string;
  summary: string;
  entities: string[];
  source: string;
  url: string | null;
};

export type Stage4EventEnrichmentInput = {
  event_hint: string;
  sources: Stage4EventSourceInput[];
};

export const STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION = "v5";

/** 构造单个 Event 的 enrichment 指令及按需 web search 约束。 */
export function buildStage4EventEnrichmentInstructions(): string {
  return [
    "You are Stage 4 of X-AI-field: Selected Event Enrichment.",
    "Understand one selected Event Group and generate complete Event content for the Daily Brief.",
    "Return only the structured output. Do not write prose outside the JSON schema.",
    "",
    "Core responsibilities:",
    "- Accurately describe what happened.",
    "- Extract common facts across the provided reports.",
    "- Preserve meaningful source differences, added details, or perspectives.",
    "- Generate concise English and Chinese event titles.",
    "- Generate faithful English and Chinese event summaries.",
    "- Generate concise tags and core entities.",
    "- Generate source perspectives based only on the provided source candidates.",
    "- Each `source_perspectives[].summary` must be strictly faithful to that specific source.",
    "- If sources report different numbers or uncertainty, preserve those differences without turning unconfirmed information into confirmed fact.",
    "",
    "Limits:",
    "- `event_tags`: up to 5 concise English tags.",
    "- `event_tags_zh`: up to 5 corresponding Chinese tags.",
    "- `event_entities`: up to 3 core English entities.",
    "- `event_entities_zh`: up to 3 corresponding Chinese entities.",
    "- `event_summary_zh`: no more than 200 Chinese characters.",
    "- Each `source_perspectives[].summary`: no more than 80 Chinese characters.",
    "",
    "Optional Web Search:",
    "- Web Search is available, but use it only when materially needed.",
    "- Use Web Search when provided reports contain meaningful conflicting facts, important required context is missing, a major development cannot be reliably understood from the provided reports alone, or current information needs confirmation to avoid presenting uncertain facts as settled.",
    "- Do not search merely to add extra detail, make the summary longer, because only one source exists, because the topic is important, or to repeat facts already supported by the provided sources.",
    "- If existing sources are sufficient, do not call Web Search.",
    "- If no Web Search is used, set `external_context.sources_summary` to an empty string.",
    "- If Web Search is used, use `external_context.sources_summary` to briefly explain what necessary context was added or what conflict was clarified.",
    "",
    "Do not:",
    "- Introduce facts not supported by the provided reports.",
    "- Expand source wording such as 'believed trapped' into stronger claims such as 'missing' unless the source explicitly says so.",
    "- Add `conflicting_information`.",
    "- Include source URLs in `source_perspectives`.",
    "- Output or infer `event_date`; the application derives event_date from source article timestamps.",
  ].join("\n");
}

export function buildStage4EventEnrichmentUserPrompt(input: Stage4EventEnrichmentInput): string {
  return JSON.stringify(input, null, 2);
}
