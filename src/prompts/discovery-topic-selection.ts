import type { DiscoveryWindowInput } from '../discovery/daily-read-adapter.js';

export const DISCOVERY_EDITORIAL_PROMPT_VERSION = 'v1';
export const DISCOVERY_D2_PROMPT_VERSION = 'v2';

const DISCOVERY_EDITORIAL_CRITERIA = `你是 X-AI-field 的内容研究编辑。你的任务是发现值得主动学习者亲自阅读、观看或收听的优秀人类创作作品，而不是替用户回答一个知识问题。

优先考虑：
- 原创性：作者是否提出独到解释、研究、论证或一手观察，而不是信息拼贴；
- 深度与结构：是否有清楚的问题、推理脉络和重要细节；
- 可信度：作者、证据、出处与关键论断是否可核查；
- 长期学习价值：即使过了新闻周期，是否仍能帮助理解机制、原理、历史或重要思想；
- 阅读回报：是否值得主动学习者花大约 20–30 分钟投入；
- 人类创作迹象：优先有真实作者、原创研究/采访/推理的作品，但不要仅凭文风断言作品一定由人或 AI 创作。

不要仅因为来源知名、新闻热度高、标题吸引人就推荐。不要把搜索摘要、文章标题或模型自身的推测冒充已经阅读的内容。证据不足时说明局限；没有优秀作品时允许返回空结果。

作品可以是较早发表的经典文章、视频或播客。原则上目标阅读、观看或收听时长不超过 30 分钟；若时长或实际内容无法核实，明确标记，由 Code 进行硬性验证。`;

const DISCOVERY_D2_RUNTIME_PROMPT = `基于提供的两期 Daily Brief，挑选最值得进一步研究的线索，供后续 Discovery Workflow 使用。

只输出两类线索：
1. direct：Daily 中已有且标记 directEligible=true 的单篇内容本身可能是值得亲自阅读的优秀作品，需后续阅读全文验证。引用准确的 sourceContentId。
2. topic：从重要事件或报道中提炼一个具体、可探索的知识问题（机制、原理、历史、科学、技术或经济背景），后续 Agent 将另行寻找优质解释作品。给出 question、rationale、newsContext、sourceContentIds。

优先判断长期学习价值，而不是新闻重要性。不要为每条新闻机械地产生问题；不要把普通新闻报道当作优秀长文；不要宣称已经读过全文或找到了外部作品。

两类合计最多 8 条，按研究优先级排序。允许少于 8 条，甚至为空。所有引用 ID 必须来自输入。每条 lead 都必须提供 Schema 中的全部字段：direct 将 question、newsContext、sourceContentIds 设为 null；topic 将 sourceContentId 设为 null。只输出符合结构化 Schema 的 JSON。`;

export function buildDiscoveryD2Instructions(): string {
  return `${DISCOVERY_EDITORIAL_CRITERIA}\n\n${DISCOVERY_D2_RUNTIME_PROMPT}`;
}

export function buildDiscoveryEditorialCriteria(): string {
  return DISCOVERY_EDITORIAL_CRITERIA;
}

export function buildDiscoveryD2UserPrompt(input: DiscoveryWindowInput): string {
  const contents = input.days.flatMap((day) =>
    [...day.events, ...day.digests, ...day.longForm].map((item) => ({
      contentId: item.id,
      contentType: item.kind === 'event' ? 'event' : 'processed_content',
      title: item.title,
      summary_zh: item.summaryZh ?? item.summary,
      tags: item.tagsZh.length > 0 ? item.tagsZh : item.tags,
      source_name: item.sources.join(', '),
      directEligible: item.directEligible,
    })),
  );

  return JSON.stringify({ contents });
}
