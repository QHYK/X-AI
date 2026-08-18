# X-AI-field Prompt Spec

本文档定义 Application 与 LLM 的接口合同。Runtime prompt 应与本文件保持一致。

## Stage 1 — Content Understanding & Selection

**Goal:** Understand each article and decide whether it should be included in today's Daily Brief.

### Input Schema
```json
{
  "title": "",
  "url": "",
  "author": "",
  "content": "",
  "source_name": "",
  "source_tags": [],
  "source_metadata": {}
}
```

### Output Schema
```json
{
  "category": "",
  "tags": [],
  "entities": [],
  "entities_zh": [],
  "routing": "Event|Digest|Long-form|Inspiration|Ignore",
  "generated_content": {
    "summary": "",
    "summary_zh": "",
    "title_zh": ""
  }
}
```

### Guidelines
- Routing 时根据文章本身的**primary value**判断，而不是仅根据 Source 的候选配置判断。
- `event_candidate` / `source_digest_candidate` are eligibility signals, not final routing rules.
- `Event`: concrete major event, decision, announcement, data release, accident, or key new development.
- `Digest`: useful analysis, explanation, research, trend, profile, or general information. 不以需要进入 Today's Events 的重大现实事件为核心.
- `Long-form`: important content worth reading in full; Eg: 深度分析、重要观点、调查报道、专题文章. May come from any source/category.
- `Inspiration`: xkcd / NASA Image of the Day.
- `Ignore`: 不符合 Daily Brief 内容标准的内容。
- Commentary about an important event is not automatically `Event`; route deep, high-value analysis to `Long-form` when appropriate.
- Scientific papers → `Digest` unless duplicate reposts.
- Category: `Finance & Economy`, `Technology`, `Science`, `Policy`, `Company`, `General`, `Long-form`.
- Prefer high-impact, systemic-risk, high-information-gain content and important policy / market / technology developments.
- Tier-1 media 的 Exclusive 内容需要重点审视，通常应优先保留
- Default ignore: marketing, duplicate reposts, no-new-information follow-ups, gossip, clickbait, unsupported rumors, sports, entertainment, lifestyle, consumer devices.
- `tags` ≤ 5; 用于补充和细化 Category；选择最能描述内容的具体标签
- `entities` ≤ 3; 只保留对识别文章核心事件有帮助的主要实体.
- For `routing != Ignore`, generate English summary + Chinese title/summary.
- Long-form summary may be longer, but keep Chinese summary roughly ≤ 400 characters.
- Summaries must be faithful to the source.

---

## Stage 2 — Merge Events

**Goal:** Group Event Candidates that describe the same real-world event.

### Input Candidate
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

### Output Schema
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

### Guidelines
<!-- + 共享主要实体并不自动意味着属于同一个 Event。 -->
- Merge only when reports describe the same real-world event: same primary entity, core action/issue, and event context.
- Do not merge merely because reports share a broad topic, country, company, market, or category.
- Unclear matches remain separate Event Groups.
- Every `temp_id` appears exactly once; never invent or modify IDs.
- `event_hint` is a short description of the real-world event.

---

## Stage 3 — Channel Ranking

**Goal:** Rank candidates by relative importance or value within each Daily Brief Channel.

### Execution
1. Rank Event Groups globally.
2. Code selects Top N Events.
3. Code removes exact duplicates already represented by Selected Events.
4. Rank remaining Digest items separately by Category.
5. Rank remaining Long-form items globally.

### Output Schema
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

### Event Ranking
Prioritize:
- Systemic Risk
- Important Topics
- Impact: economic / geographic / affected group
- Independent media coverage and source authority
- Important policy, macro, market, company, technology changes
- Key new development in an important ongoing story

### Digest Ranking
Rank **within Category** by:
- Source / publication significance
- Novelty
- Information value

For Science, `source` may be a subject feed; use `publication` when reliably available and do not infer journal prestige from Nature subject-feed names.

### Long-form Ranking
Rank by:
- Depth
- Author / source credibility
- Originality
- Durable reading value
- Understanding that a normal news summary cannot replace

### Common Rules
- Rank all provided IDs exactly once, `1..N` with no duplicates.
- Do not decide Top N; Code handles selection.
- Do not rank only by publish time, breaking-news tone, or source diversity.
- Keep `reason` concise; it is currently used for review/debug.

---

## Stage 4 — Selected Event Enrichment

**Goal:** Understand each selected Event Group and generate complete Event content for the Daily Brief.

### Input Schema
```json
{
  "event_hint": "",
  "sources": [
    {
      "title": "",
      "summary": "",
      "entities": [],
      "source": "",
      "url": ""
    }
  ]
}
```

### Output Schema
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
    "summary": ""
  }],
  "external_context": {
    "performed": false,
    "sources": [],
    "sources_summary": ""
  }
}
```

### Guidelines
- Accurately describe what happened and extract common facts.
- Preserve meaningful added details, perspectives, uncertainty, and conflicts across sources.
- `source_perspectives[].summary` must be faithful to that specific source.
- `event_tags` / `event_tags_zh` ≤ 5.
- `event_entities` / `event_entities_zh` ≤ 3. 只保留识别该 Event 最重要的核心实体。
- `event_summary_zh` ≤ ~200 Chinese characters.
- Each `source_perspectives[].summary` ≤ ~80 Chinese characters. 
+ Summaries must be faithful to the provided reports.
<!-- - Do not output `event_date`; Application Code derives it from source timestamps. -->
- Web Search is available but optional. Use it only when materially needed to fill essential context, clarify meaningful conflicts, or confirm uncertain facts.
- Do not search merely to add detail or because the topic is important.
+ If Web Search is used, summarize only the context needed to understand the event. And list the source URLs used in summarize in `external_context.sources`.
- Application Code derives actual `external_context.performed` and provenance URLs from real Responses API Web Search tool usage.
- `external_context.sources_summary` ≤ 250 Chinese characters.
