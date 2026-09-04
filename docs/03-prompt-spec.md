# X-AI-field Prompt Spec

本文档定义 Application 与 LLM 的接口合同。Runtime prompt 应与本文件保持一致。

## Stage 1 — Content Understanding & Selection

**Goal:** Understand each article and decide whether it should be included in today's Daily Brief.

### Input Schema
```json
{
  "articles": [
    {
      "temp_id": "A001",
      "title": "",
      "url": "",
      "author": "",
      "content": "",
      "source_name": "",
      "source_tags": [],
      "source_metadata": {}
    }
  ]
}
```

### Output Schema
```json
{
  "results": [
    {
      "temp_id": "A001",
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
  ]
}
```

Each article is evaluated independently, and every input `temp_id` must appear exactly once in the output.
    <!-- "Process every provided article independently.",
    "Do not let one article influence another article's routing or summary.",
    "Return one result for every exact `temp_id`.",
    "Do not invent, omit, duplicate, or modify `temp_id`.", -->
### Guidelines
- Routing 时根据文章本身的**primary value**判断，而不是仅根据 Source 的候选配置判断。
- `event_candidate` / `source_digest_candidate` are eligibility signals, not final routing rules.
- `Event`: concrete major event, decision, announcement, data release, accident, or key new development.
- `Digest`: 值得用户花注意力、具有明显信息增量的 analysis, explanation, research, trend, profile, or general information. 不以需要进入 Today's Events 的重大现实事件为核心.
- `Long-form`: important content worth reading in full; Eg: 深度分析、重要观点、调查报道、专题文章. May come from any source/category.
- `Inspiration`: xkcd / NASA Image of the Day.
- `Ignore`: 不符合 Daily Brief 内容标准的内容。
- Commentary about an important event is not automatically `Event`; route deep, high-value analysis to `Long-form` when appropriate.
- Scientific papers → `Digest` unless duplicate reposts.
<!-- - Scientific papers with meaningful novelty, scientific significance, application value, or learning value → `Digest`; routine, narrow, or low-information papers may be `Ignore`. -->
- Category: `Finance & Economy`, `Technology`, `Science`, `Policy`, `Company`, `General`, `Long-form`.
- Prefer high-impact, systemic-risk, high-information-gain content and important policy / market / technology developments.
- Tier-1 media 的 Exclusive 内容需要重点审视，通常应优先保留
- Default ignore: marketing, duplicate reposts, no-new-information follow-ups, gossip, clickbait, unsupported rumors, sports, entertainment, lifestyle, consumer devices.
- 普通更新、轻微趋势、重复信息、低影响公司动态、一般性解释、泛泛 profile、边缘兴趣内容应优先 Ignore。
- 当内容“有用但不够重要”时，优先 Ignore，而不是 Digest。
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
      "rank": 1
      // "reason": ""
    }
  ]
}
```

### Event Ranking
Return only the 50 most important Event Groups. If fewer than 50 are provided, return all.

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
- Event Ranking returns at most 50 IDs; Code handles final Top N selection.
- Digest Ranking must rank all provided candidates exactly once; missing / duplicate / invalid IDs trigger one repair attempt, and the ranking fails if repair still cannot produce a complete valid ordering.
- Long-form Ranking ranks all provided IDs exactly once.
- Returned IDs must come from the corresponding input; ranks start at 1 and remain consecutive.
- Do not rank only by publish time, breaking-news tone, or source diversity.
- Keep Digest / Long-form `reason` concise for review/debug.
- Keep `reason` concise; it is currently used for review/debug.

---

## Stage 4 — Selected Event Enrichment

**Prompt Version:** `v7`

**Goal:** Act as the final editorial synthesis layer for each selected Event. Make the Event independently understandable by explaining what happened and, when relevant, the minimum background / preceding development needed to understand it and why the development deserves attention now.

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

### Editorial Goal
For each Selected Event, answer these questions when relevant:

1. **What happened?**
2. **What minimum background or preceding development is needed to understand it?**
3. **Why does this development deserve attention now?**

“Why it matters” means why the development is consequential, unusual, systemically important, policy-relevant, scientifically important, strategically important, or a meaningful change in an ongoing story. It does **not** mean investment advice, price prediction, or speculative market impact.

Do not manufacture significance. Straightforward Events whose significance is already clear should remain concise.

### Guidelines
- Accurately describe what happened and extract common facts across the provided reports.
- Preserve meaningful added details, perspectives, uncertainty, and conflicts across sources.
- `source_perspectives[].summary` must be faithful to that specific source and based only on the provided source candidates.
- `event_tags` / `event_tags_zh` ≤ 5.
- `event_entities` / `event_entities_zh` ≤ 3. 只保留识别该 Event 最重要的核心实体。
- `event_summary_zh` normally about 150–300 Chinese characters; complex important Events may use up to about 400 Chinese characters when the additional context is genuinely useful.
- Each `source_perspectives[].summary` ≤ ~80 Chinese characters.
- Summaries must remain faithful to the provided reports and any actual Web Search results used.

### Web Search
- Stage 4 first makes a non-persisted application-side context decision. If existing sources are sufficient,
  enrichment uses Chat Completions without Web Search; otherwise it uses Responses API with `tool_choice=auto`.
- Web Search remains optional and is not required for every Event.
- First understand the provided reports, then actively judge whether important context is still missing.
- Use Web Search when it can materially improve independent understanding through necessary background/context, important preceding developments, why the development matters now, important context for an ongoing story, first-party confirmation, or clarification of meaningful uncertainty/conflicting reports.
- Web Search is especially useful when the provided candidates describe only the latest development in an important ongoing story without enough context to understand its significance.
- Prefer first-party or authoritative sources when useful for important policy decisions, official economic data, company announcements, court decisions, regulatory actions, and research findings.
- Search may also be used when a small amount of reliable background explains why an otherwise isolated fact deserves attention.
- Do not search merely to accumulate facts, repeat facts already covered by the provided sources, add trivia / low-value background, or produce investment advice / price predictions.
- If Web Search does not provide meaningful information gain, rely on the provided reports.
- If Web Search is used, `event_summary` / `event_summary_zh` may naturally integrate verified background, preceding developments, confirmation, or significance needed to make the Event independently understandable.
- If Web Search is used, keep `external_context.sources_summary` concise and state what useful background, confirmation, or explanation the search added; list the source URLs used in `external_context.sources`.
- Web Search results must not be represented as original source perspectives; `source_perspectives` remains based only on provided source candidates.
- Application Code derives actual `external_context.performed` and provenance URLs from real Responses API Web Search tool usage.
- `external_context.sources_summary` ≤ 250 Chinese characters.
