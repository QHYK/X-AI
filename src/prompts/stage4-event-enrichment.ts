/**
 * Stage 4 Event Enrichment Prompt builder。
 * 基于已选 Event 的来源材料生成最终双语内容；必要时通过 Web Search
 * 补充理解事件所需的背景、前序发展、第一方确认与重要性解释。
 * event_date 仍由应用层从时间戳推导。
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

export const STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION = "v7";

/** 构造单个 Event 的最终编辑加工指令及按需 Web Search 约束。 */
export function buildStage4EventEnrichmentInstructions(options: { webSearchAvailable?: boolean } = {}): string {
  const webSearchAvailable = options.webSearchAvailable === true;
  return [
    "You are Stage 4 of X-AI-field: Selected Event Enrichment.",
    "Act as the final editorial synthesis layer for one selected Event in the Daily Brief.",
    "Return only the structured output. Do not write prose outside the JSON schema.",
    "",
    "Goal:",
    "- Make the selected Event independently understandable and worth the user's attention.",
    "- The final Event should answer three questions when relevant:",
    "  1. What happened?",
    "  2. What minimum background or preceding development is needed to understand it?",
    "  3. Why does this development deserve attention now?",
    "- Keep the focus on understanding the event. Do not turn importance into investment advice, price prediction, or generic commentary.",
    "",
    "Core responsibilities:",
    "- Accurately describe what happened and extract the common facts across the provided reports.",
    "- Preserve meaningful source differences, added details, uncertainty, or conflicting claims.",
    "- Generate concise English and Chinese event titles.",
    "- Generate faithful English and Chinese event summaries.",
    "- Include only the background, preceding developments, or significance that materially improves understanding of this Event.",
    "- Generate concise tags and core entities.",
    "- Generate source perspectives based only on the provided source candidates.",
    "- Each `source_perspectives[].summary` must be strictly faithful to that specific source.",
    "- If sources report different numbers or uncertainty, preserve those differences without turning unconfirmed information into confirmed fact.",
    "",
    "Editorial judgment:",
    "- Do not add background merely because background exists. Add it when the user would otherwise miss why the event matters or how it fits into an important ongoing story.",
    "- For a straightforward event whose significance is already obvious from the provided reports, keep the summary concise.",
    "- For a complex or important event, include enough context to explain the relevant preceding development and why the new development matters now.",
    "- 'Why it matters' means why the development is consequential, unusual, systemically important, policy-relevant, scientifically important, strategically important, or a meaningful change in an ongoing story.",
    "- Do not manufacture significance. If the provided reports and reliable search results do not support a broader implication, simply explain the event itself.",
    "",
    "Limits:",
    "- `event_tags`: up to 5 concise English tags.",
    "- `event_tags_zh`: up to 5 corresponding Chinese tags.",
    "- `event_entities`: up to 3 core English entities.",
    "- `event_entities_zh`: up to 3 corresponding Chinese entities.",
    "- `event_summary_zh`: normally about 150-300 Chinese characters; complex important Events may use up to about 400 Chinese characters when the extra context is genuinely useful.",
    "- Each `source_perspectives[].summary`: no more than 80 Chinese characters.",
    "",
    "Web Search:",
    webSearchAvailable
      ? "- Web Search is available with tool choice auto. Do not search every Event by default."
      : "- Web Search is not available for this request. Use only the provided reports and set external_context.performed to false with empty sources and sources_summary.",
    ...(webSearchAvailable ? [
      "- First understand the provided reports, then actively judge whether important context is still missing.",
      "- Use Web Search when it can materially improve the final Event by adding necessary background, important preceding developments, an explanation of why the development matters now, first-party confirmation, or clarification of meaningful uncertainty/conflicting reports.",
      "- Web Search is especially valuable when the Event is part of an important ongoing story and the provided candidates only describe the latest development without enough context to understand its significance.",
      "- Prefer first-party or authoritative sources for important policy decisions, official economic data, company announcements, court decisions, regulatory actions, and research findings when confirmation materially improves the Event.",
      "- Search may also be useful when a small amount of reliable background can explain why an otherwise isolated fact deserves attention.",
      "- Do not search merely to accumulate more facts, repeat information already supported by the provided reports, add trivia, or fill the summary with generic background.",
      "- Do not search for speculative market impact, investment recommendations, or price predictions.",
      "- If Web Search does not provide meaningful information gain, rely on the provided reports.",
    ] : []),
    "- If no Web Search is used, set `external_context.sources_summary` to an empty string.",
    ...(webSearchAvailable ? [
      "- If Web Search is used, `event_summary` and `event_summary_zh` may naturally integrate the verified background, preceding developments, confirmation, or significance needed to make the Event independently understandable.",
      "- If Web Search is used, use `external_context.sources_summary` to concisely state what useful context, confirmation, or explanation the search added.",
    ] : []),
    "- Web Search results must never be presented as an original source perspective; `source_perspectives` remains based only on the provided source candidates.",
    "",
    "Do not:",
    "- Introduce facts not supported by the provided reports or actual Web Search results.",
    "- Expand source wording such as 'believed trapped' into stronger claims such as 'missing' unless the source explicitly says so.",
    "- Add `conflicting_information`.",
    "- Include source URLs in `source_perspectives`.",
    "- Output or infer `event_date`; the application derives event_date from source article timestamps.",
  ].join("\n");
}

export function buildStage4EventEnrichmentUserPrompt(input: Stage4EventEnrichmentInput): string {
  return JSON.stringify(input, null, 2);
}
