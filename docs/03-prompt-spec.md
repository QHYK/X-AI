This document defines the interface contract between the application and the LLM.
# X-AI-field Prompt Spec

## Stage 1: Content Understanding & Selection

Goal: Understand each article and determine whether it should be included in today's Daily Brief.

Input Schema:
```json
{
  "title":"",
  "content":"",
  "source":"",
  "source_metadata":{},
  "default_tags":[]
}
```

Output Schema:
```json
{
  "category":"",
  "tags":[],
  "topic":[],
  "entities":[],
  "content_type":"",
  "routing": "Event|Digest|Long-form|Inspiration",
  "generated_content":{
    "summary":"",
    "summary_zh":"",
    "title_zh":"",
  },
}
```
<!-- 写 Prompt 时遵守的规则 -->
Prompt Guidelines:
+ 来源为xkcd,NASA Image of the Day直接进入Daily Inspiration
+ 科研论文全部进入 Source Digest，除非是重复转载
+ Category 的可选值：Finance & Business & Economy，Technology，Science，Policy，Company，General，Long-form
+ 所有保留内容都生成 Summary
+ Faithful to the original article.
+ Long-form Category sources 全部保留，Summary可稍长，但不要超过200字。
+ Prefer important topics：Fed, CME, ECB, BLS, BEA, IMF, BOJ, 加拿大央行, 大型科技公司财报, 美国、欧洲、中国重大政策, 重大风险事件, 重要地缘冲突进展, 债券市场重大变化, 货币市场重大波动
+ Prefer Systemic Risk
+ Prefer Massive Impact
+ Tier-1 media 的 Exclusive 内容要仔细看，一般都是重大事件或重要内容
+ Generate Chinese title and Chinese summary for selected articles.

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
