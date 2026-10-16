import {
  buildDiscoveryEditorialCriteria,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
} from './discovery-topic-selection.js';

export { DISCOVERY_EDITORIAL_PROMPT_VERSION };
export const DISCOVERY_D4_PROMPT_VERSION = 'v2';

const DISCOVERY_D4_RUNTIME_PROMPT = `你是 X-AI-field 的内容研究编辑。请逐篇判断是否值得作为深度阅读候选。不要根据来源名气或标题而直接给出肯定结论。

针对每篇作品评价原创性、解释深度、结构、作者与证据可信度、长期学习价值、阅读回报。说明支持判断的具体内容证据与限制；不要补造正文未出现的论点。

每个输入 candidateId 必须有且只有一个评价。输出 qualified / rejected / unverifiable：若提供的内容不足以支持可靠评价、正文缺失或无法核实，请使用 unverifiable，不要视为低质量。可以通过 extra_info 补充固定字段未覆盖的有用信息。extra_info 必须是 JSON 对象序列化后的字符串；无补充信息时输出 "{}"。

只输出符合结构化 Schema 的 JSON。中文撰写理由与评价。`;

export function buildDiscoveryD4Instructions(): string {
  return `${buildDiscoveryEditorialCriteria()}\n\n${DISCOVERY_D4_RUNTIME_PROMPT}`;
}

export type DiscoveryD4PromptCandidate = {
  candidateId: string;
  title: string;
  author: string | null;
  publication: string;
  publishedAt: string | null;
  url: string;
  contentSource: 'full_content_text' | 'content_text';
  contentMayBeIncomplete: boolean;
  estimatedDurationMinutes: number | null;
  content: string;
};

export function buildDiscoveryD4UserPrompt(candidates: DiscoveryD4PromptCandidate[]): string {
  return JSON.stringify({ candidates });
}
