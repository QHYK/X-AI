# X-AI-field AI Workflow Spec

本文档只定义 AI 在四个 Stage 中分别负责什么。完整 Code / Data 流程见 `06-workflow-overview.md`。

## Overview

```text
Raw Articles
    ↓
Stage 1 — Content Understanding & Selection
    ↓
┌─────────────────────────────┐
│ Event Candidates            │
│ Source Digest               │
│ Long-form                   │
│ Inspiration                 │
└─────────────────────────────┘
    ↓
Stage 2 — Merge Events                (Event only)
    │
    └── Event Candidates → Event Groups → Global Ranking
                                              ↓
                                       Top N Event Selection         ← Code
                                              ↓
                                Collect selected Event source items  ← Code
                                              ↓
                                   Exclude exact duplicates          ← Code
                                              ↓
                                Science Publication Enrichment        ← Code
                                              │
Stage 3 — Source Digest Ranking by Category  ←┘
Stage 3 — Long-form Global Ranking
    ↓
Code selects Top Events
    ↓
Stage 4 — Selected Event Enrichment
```

---

## Stage 1 — Content Understanding & Selection

**Responsibility**  
理解单篇内容，判断是否保留，以及进入哪个 Daily Brief Channel。

**Input**  
Raw Article + Source Metadata

**Output**
- Category
- Tags
- Entities
- Routing: Event / Digest / Long-form / Inspiration / Ignore
- Generated Content: 
  - English Summary
  - Chinese Translation

**Definition of Done**
- Routing 与文章主要价值一致
- 明显低价值内容被过滤
- Tags ≤ 5，Entities ≤ 3
- Summary 忠于原文，中文自然准确

---

## Stage 2 — Merge Events

**Responsibility**  
判断 Event Candidates 是否描述同一个现实事件，并将属于同一事件的 Candidates 合并为 Event Group。

**Input**  
Event Candidates

**Output**
- Event Group
  - Event Hint
  - Sources

**Definition of Done**
- 每个 Candidate 属于且只属于一个 Event Group
- 同一现实事件尽可能合并
- 不因相同主题、国家或公司而误合并
- 无明确匹配时保持独立 Event Group

当前 runtime 的 assignment validation 处于临时 diagnostic 模式：missing、duplicate 和
invented ID 会被记录，但暂不阻断输出。这是已知实现限制，不改变上述长期 contract。

---

## Stage 3 — Channel Ranking

**Responsibility**  
根据不同 Channel 的目标，对候选内容进行相对重要性排序。

**Execution**
1. Event Groups 全局筛选并返回最重要的 Top 50 排序
2. Code 选择 Top N Events
3. Code 排除已被 Selected Events 覆盖的 exact duplicates
4. Digest 全局 exact dedup 后，按 Category 分别排序
5. Long-form 全局排序

**Ranking Scope**
```text
Events      → 全局排序：今天哪些现实事件最重要？
Digest      → 各 Category 分别排序：各领域今天哪些内容最值得关注？
Long-form   → 全局排序：什么最值得投入阅读时间？
```

**Input**
- Event Groups
- Source Digest Contents grouped by Category
- Long-form Contents

**Output**
- Rank
<!-- - Ranking Reason（当前用于 review/debug） -->

**Definition of Done**
- Event 排序反映事件相对重要性
- Digest 在 Category 内排序，能反映内容值得关注程度
- Long-form 反映阅读价值
- 不进行跨 Channel 排名

---

## Stage 4 — Selected Event Enrichment

**Responsibility**  
只对最终入选的 Event Groups 生成可直接展示的完整 Event；必要时使用 Web Search 补充关键背景或澄清冲突。

**Input**
- Selected Event Group
- Corresponding Event Candidates

**Output**
- Event Title / Chinese Event Title
- Event Tags / Chinese Event Tags
- Event Entities / Chinese Event Entities
- Event Summary / Chinese Event Summary
- Source Perspectives / Differences
- External Context

`event_date` 由 Application Code 根据 source article timestamps 推导，不由 LLM 输出。

**Definition of Done**
- 准确说明发生了什么
- 提取共同事实
- 保留有意义的来源差异 / 冲突
- Web Search 只在确有需要时使用
- 不引入无法被输入或外部来源支持的事实
- 输出可直接用于 Daily Brief

---

## Feedback Loop — Planned

人工反馈Input & 用途：
- False Positive / False Negative
- Ranking Error
- Classification Error
- Eval / Prompt refinement

当前不是 Daily Workflow 的阻塞步骤。
