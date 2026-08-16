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
- `xkcd`、`NASA Image of the Day` → `Inspiration`
- 科研论文 → `Digest`，除非重复转载
- Long-form Category 来源 → `Long-form`
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
  "event_date": "",
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
+ `event_tags`:  Up to 5 concise English tags
+ `event_tags_zh`: Up to 5 corresponding Chinese tags.
+ `event_entities`: Up to 3 core English entities. 只保留识别该 Event 最重要的核心实体。
+ `event_entities_zh`: Up to 3 corresponding Chinese entities.
+ 合并后提取共同事实，并保留不同来源提供的重要新增信息、不同视角或冲突信息。
+ `event_summary_zh`: 不超过200字。
+ Each `source_perspectives[].summary`: 不超过80字。
+ Summaries must be faithful to the provided reports.
+ 当现有来源无法完整描述事件、存在信息冲突或需要补充背景时，主动检索外部可信信息。
+ Record external source URLs and summarize only the context needed to understand the event.
+ `external_context.sources` 保存外部来源 URL。
+ `external_context.sources_summary` 不超过 250 字。
