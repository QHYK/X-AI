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
- `entities`: 最多 3 个，只保留对识别文章核心事件有帮助的主要实体，用于后续 Event Merge；不要提取所有被提及的人名、指标、产品、媒体来源或次要实体。
- Long-form Summary 可以更详细，但不超过约 400 字
- Summary 必须忠于原文，不补写原文不存在的事实


## Stage 2: Event Understanding & Merge

Input: Stage1 Output Event Candidate

Output:
```json
{
  "event_date": "",
  "event_title": "",
  "event_title_zh": [],
  "event_entities_zh": [],
  "event_summary": "",
  "event_summary_zh": "",
  "source_perspectives": [{
    "source": "Reuters",
    "summary": "..."
  }],
  "external_context": {
    "performed": true,
    "sources":[],
    "sources_summary": ""
  },
  "sources": []
}
```
Prompt Guidelines:
+ Merge reports describing the same real-world event.
+ 合并时提取报导的共同信息，并保留不同来源的信息差异。
+ 当现有来源无法完整描述事件、存在信息冲突或需要补充背景时，主动检索外部可信信息，并记录信息来源。

## Stage 3: Daily Brief Prioritization

Input: 
Stage2 Output Candidate: Merged Events, Source Digest Candidates, Long-form Candidates
```json
{
  "events": [],
  "source_digest_candidates": [],
  "long_form_candidates": []
}
```

Output:
```json
{
  "events": [
    {
      "event_id": "",
      "rank": 1,
      "reason": ""
    }
  ],
  "source_digest": [
    {
      "source": "Nature",
      "articles": []
    }
  ],
  "long_form": [
    {
      "content_id": "",
      "rank": 1,
      "reason": ""
    }
  ]
}
```

Prompt Guidelines:
Event Prioritize by:
- Has Systemic Risk
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
