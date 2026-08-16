This document defines the interface contract between the application and the LLM.
# X-AI-field Prompt Spec

## Stage 1: Content Understanding & Selection

Goal: Understand each article and determine whether it should be included in today's Daily Brief.

Input Schema:
```json
{
  "title":"",
  "url":"",
  "author":"",
  "content":"",
  "source_name":"",
  "source_tags":[],
  "source_metadata":{}
}
```

Output Schema:
```json
{
  "category":"",
  "tags":[],
  "entities":[],
  "entities_zh":[],
  "routing": "Event|Digest|Long-form|Inspiration|Ignore",
  "generated_content":{
    "summary":"",
    "summary_zh":"",
    "title_zh":"",
  },
}
```
<!-- 写 Prompt 时遵守的规则 -->
Prompt Guidelines:

- Routing Guidelines:
  - `Event`: 文章的主要价值是报道一个具体的现实事件、决定、公告、数据发布、事故，或重要事件的关键新进展。
  - `Digest`: 文章有信息价值，但主要属于分析、解释、研究、趋势、人物/公司介绍或一般性信息，不以一个需要进入 Today's Events 的重大现实事件为核心。
  - `Long-form`: 重要且值得投入时间完整阅读的长篇内容，包括深度分析、重要观点、调查报道、专题文章或系统性解释。Long-form 不限于 `Long-form` Category 来源；其他来源中的高质量深度内容也可以进入 `Long-form`。
  - `Ignore`: 不符合 Daily Brief 内容标准的内容。

  Routing 时根据文章本身的主要价值判断，而不是仅根据 Source 的候选配置判断。
  当 Source 同时允许 Event Candidate 和 Source Digest Candidate 时：
  - 报道新的重大现实事件或关键进展 → `Event`
  - 主要提供分析、解释、背景、趋势或一般信息 → `Digest`
  - 如果属于重要且有深度、值得完整阅读的分析、观点、调查或专题内容 → `Long-form`
  评论或分析已有事件的文章，通常不应仅因为讨论重大事件而进入 `Event`；
  只有文章本身包含重要的新事实、新决定或关键进展时，才应进入 `Event`。

  `event_candidate` 和 `source_digest_candidate` 表示该 Source 可以进入哪些候选分支，不代表最终 Routing。
  最终 Routing 由文章内容决定。
  - `xkcd`、`NASA Image of the Day` → `Inspiration`
- 科研论文 → `Digest`，除非重复转载
- Long-form Category 来源通常进入 `Long-form`，但内容本身仍应具有足够的重要性、深度或阅读价值。
- 其他 Category 来源中的高质量深度分析、重要观点、调查报道、专题文章或系统性解释，也可以进入 `Long-form`。
- Category 可选值：`Finance & Economy`, `Technology`, `Science`, `Policy`, `Company`, `General`, `Long-form`
- 优先保留：
    - Important Topics：Fed、CME、ECB、BLS、BEA、IMF、BOJ、加拿大央行、大型科技公司财报、美欧中重大政策、重大风险事件、重要地缘冲突进展、债券和货币市场重大变化
    - 具有广泛影响、系统性风险、显著信息增量
    - 代表重要行业/技术趋势
    - 重要事件的关键后续发展
- Tier-1 media 的 Exclusive 内容需要重点审视，通常应优先保留
- 默认排除：
    - 单纯营销稿
    - 重复转载
    - 缺乏新增信息的跟进文章
    - 纯娱乐八卦
    - 标题党
    - 无可靠来源支持的传闻
    - 体育、娱乐、生活方式、3C 消费设备
- 所有 `routing != Ignore` 的内容生成 Summary、中文标题和中文摘要
- `tags`: 最多 5 个，用于补充和细化 Category；选择最能描述内容的具体标签，避免无意义的泛化标签。
- `entities`: 最多 3 个，只保留对识别文章核心事件有帮助的主要实体，用于后续 Merge Events；不要提取所有被提及的人名、指标、产品、媒体来源或次要实体。
- 分析/观点文章不是简单地 Event → Digest。高质量、重要、值得完整阅读的深度分析应该进入 Long-form。
- Long-form Summary 可以更详细，但不超过约 400 字
- Summary 必须忠于原文，不补写原文不存在的事实


## Stage 2: Merge Events

Goal: Group Event Candidates that describe the same real-world event.

Input: Stage1 Output Event Candidate
Each Event Candidate only needs:
```json
{
  "temp_id": "",
  "title": "",
  "summary": "",
  "entities": [],
  "source": "",
  "url": ""
}
```

Output Schema:
```json
{
  "events": [
    {
      "event_hint": "",
      "sources": []
    }
  ]
}
```

Prompt Guidelines:
<!-- + 共享主要实体并不自动意味着属于同一个 Event。 -->
- Merge reports describing the same real-world event when they share the same primary entity, core action or issue, and event context.
- Do not merge unrelated events just because they share a broad topic, country, company, market, or category.
- Keep a single candidate as its own Event when it does not clearly match another candidate.
- Every input candidate must appear in exactly one Event's `sources` using its exact `temp_id`.
- Do not invent or modify `temp_id`.
- `event_hint` should be a short description of the real-world event.


## Stage 3: Channel Ranking

Goal: Rank candidates by relative importance or value within each Daily Brief Channel.

Input Schema:
### Event Groups
```json
{
  "event_hint": "",
  "sources": [
    {
      "source": "",
      "title": "",
      "summary": ""
    }
  ]
}
```

Input Execution order:
1. Rank all Event Groups.
2. Code selects Top N Events.
3. Before Source Digest and Long-form ranking, code removes candidates already represented by the selected Events.
4. Rank the remaining Source Digest contents by Category.
5. Rank the remaining Long-form contents globally.

### Source Digest
Source Digest contents grouped by Category.

### Long-form
Selected Long-form contents.

Output Schema:
```json
{
  "rankings": [
    {
      "id": "",
      "rank": 1,
      "reason": ""
    }
  ]
}
```

Prompt Guidelines:
- Rank Event Groups globally by their importance as real-world events.
- Rank Source Digest contents separately within each Category.
- Rank Long-form contents globally by their reading value.
- Do not compare candidates across different Channels.
- Ranking is relative to the candidates provided in the current run.
- Do not decide how many items should be displayed. Top N selection is handled by code.

Event Prioritize by:
- Systemic Risk
- Important Topics
- Impact (Economic, Geographic, Affected Group)
- Media Coverage (Number of Sources, Source Authority)

Source Digest Prioritize by:
- Source significance
- Novelty
- Information value

Long-term Prioritize by:
- Depth
- Author credibility
- Originality

Do NOT:

- sort only by publish time
- equally distribute sources
- over-emphasize breaking news

## Stage 4: Selected Event Enrichment

Goal: Understand each selected Event Group and generate the complete Event content used by the Daily Brief.

Input Schema:

```json
{
  "event_hint": "",
  "sources": [
    {
      // "id": "",
      "title": "",
      "summary": "",
      "entities": [],
      "source": "",
      "url": ""
    }
  ]
}
```

Output Schema:
```json
{
  "event_title": "",
  "event_title_zh": "",
  "event_tags": [],
  "event_tags_zh": [],
  "event_entities": [],
  "event_entities_zh": [],
  "event_summary": "",
  "event_summary_zh": "",
  "source_perspectives": [{
    "source": "Reuters",
    "summary": "..."
  }],
  "external_context": {
    "performed": false,
    "sources":[],
    "sources_summary": ""
  }
}
```
Prompt Guidelines:
+ Accurately describe what happened.
+ Extract the common information across reports while preserving meaningful differences between sources.
+ Do not output `event_date`; the application derives event_date from source article timestamps.
+ `event_tags`:  Up to 5 concise English tags
+ `event_tags_zh`: Up to 5 corresponding Chinese tags.
+ `event_entities`: Up to 3 core English entities. 只保留识别该 Event 最重要的核心实体。
+ `event_entities_zh`: Up to 3 corresponding Chinese entities.
+ 合并后提取共同事实，并保留不同来源提供的重要新增信息、不同视角或冲突信息。
+ `event_summary_zh`: 不超过200字。
+ Each `source_perspectives[].summary`: 不超过80字。
+ `source_perspectives[].summary` 必须严格忠于对应来源
+ Summaries must be faithful to the provided reports.
+ Web Search is available, but optional. Use it only when materially needed.
+ Use Web Search when provided reports contain meaningful conflicting facts, important required context is missing, a major development cannot be reliably understood from provided reports alone, or current information needs confirmation to avoid presenting uncertainty as settled.
+ Do not search merely to add detail, lengthen the summary, because only one source exists, because the topic is important, or to repeat facts already supported by provided sources.
+ If existing sources are sufficient, do not call Web Search and set `external_context.sources_summary` to an empty string.
+ If Web Search is used, summarize only the context needed to understand the event.
+ Application Code derives `external_context.performed` and `external_context.sources` from actual Responses API Web Search tool usage; model-provided provenance is not the final source of truth.
+ `external_context.sources_summary` 不超过 250 字。
