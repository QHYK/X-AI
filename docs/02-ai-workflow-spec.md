# Overview
```xml
Source Collection                         ← Code
        ↓
Raw Articles
        ↓
┌───────────────────────────────────────┐
│ Workflow Stage 1                      │
│ Content Understanding & Selection     │
└───────────────────────────────────────┘
        ↓
     Routing
        ↓
┌──────────────┬──────────────┬──────────────┬──────────────┐
│ Event        │ Source       │ Long-form    │ Inspiration  │
│ Candidates   │ Digest       │              │              │
└──────┬───────┴──────────────┴──────────────┴──────────────┘
       │
       ↓
┌───────────────────────────────────────┐
│ Workflow Stage 2                      │
│ Merge Events                          │
└───────────────────────────────────────┘
       │
       ↓
  Event Groups
┌─────────────┐ ┌──────────────┬──────────────┐
│ Event       │ │ Source       │ Long-form    │
│ Groups      │ │ Digest       │              │
└──────┬──────┘ └───────┬──────┴───────┬──────┘
       └┬────────────────┴──────────────┘
        ↓
┌───────────────────────────────────────┐
│ Workflow Stage 3                      │
│ Channel Ranking                       │
└───────────────────────────────────────┘
        ↓
Top N / ordering                          ← Code
        ↓
Selected Event Groups
        │
        ↓
┌───────────────────────────────────────┐
│ Workflow Stage 4                      │
│ Selected Event Enrichment             │
└───────────────────────────────────────┘
        ↓
Complete Events
        ↓
Daily Brief Composition                  ← Code
        ↓
Publish
        ↓
Human Feedback Capture                   ← Code
```

---

# Stage 1: Content Understanding & Selection

Responsibility: 理解单篇内容，并判断它是否值得保留、应该进入 Daily Brief 的哪个分支。

Input: Raw Article + Source Metadata

Output:

- Category
- Tags
- Entity
- Routing (Event Candidate, Source Digest Candidate, Long-form Candidate, Ignore)
- Generated Content: 
  - Summary
  - Chinese Translation
<!-- - Selection Reason -->

<!-- 这个 Stage 完成以后，整个系统应该处于什么状态 -->
Definition of Done:
- 分类正确
- Tag准确，且不超过5个
- Entity只保留重要的，且不超多3个
- 不把明显无关内容保留
- Summary忠于原文
- 翻译自然且准确

---

# Stage 2: Merge Events

Responsibility: 判断 Event Candidates 是否描述同一个现实世界事件，并将属于同一事件的 Candidates 合并为 Event Group。

包括: 

- Identify same real-world event
- Event Merge Candidates

Input: Event Candidates

Output:

- Event Groups
  - Event Hint
  - Sources

Definition of Done:
- 每个 Event Candidate 都属于且仅属于一个 Event Group
- 同一现实事件的报道尽可能合并
- 不同现实事件不被误合并
- 无法明确与其他 Candidate 合并的内容独立成为 Event Group

---

# Stage 3: Channel Ranking

Responsibility: 根据不同 Daily Brief 分支的目标，对候选内容进行相对重要性排序。

不同 Channel 使用不同的 Ranking 范围：
```xml
Today's Events
→ 全局排序：当天哪些现实事件最重要？

Source Digests
→ 按 Category 分组并分别排序：各领域今天哪些内容最值得关注？

Long-form Reads
→ 全局排序：什么最值得投入阅读时间？
```

Input:
- Event Groups
- Source Digest Contents grouped by Category
- Long-form Contents

Output:
- Rank
- Ranking Reason

Definition of Done:
- Event Groups 的排序能够反映当天事件的相对重要性
- Source Digest 在各 Category 内分别完成排序，能够反映当天哪些内容最值得关注？
- Long-form 的排序能够反映内容的阅读价值
- 不进行跨 Channel 排名

---

# Stage 4: Selected Event Enrichment

Responsibility: 对 Ranking 后最终入选的 Event Groups 进行完整事件理解，生成 Daily Brief 展示所需的事件信息，并在必要时补充外部背景。
<!-- 判断 Event Candidates 之间的关系，将同一现实事件的报道合并，并保留不同来源的信息差异。当现有来源无法完整描述事件、存在信息冲突或需要补充背景时，主动获取外部可信信息，以提高事件理解质量。 -->


包括:

- Understand what happened
- Extract common facts
- Identify source perspectives / differences
- Identify conflicting information
- External Context Retrieval
- Generate Event Summary

Input:
- Selected Event Groups
- Corresponding Event Candidates

Output:
- Event Title / Chinese Event Title
- Event Tags / Chinese Event Tags
- Event Entities / Chinese Event Entities
- Event Summary / Chinese Event Summary
- Source Perspectives / Differences
- External Context

Definition of Done:
- 准确描述事件发生了什么
- 合并来源之间的共同事实
- 有意义的来源差异或观点得到保留
- 必要时补充外部可信信息
- 不引入原始报道或外部来源无法支持的事实
- 输出可直接用于 Daily Brief
  
---

# Feedback Loop

Purpose: 记录人工对 AI 输出的修正，用于评估和后续优化。

Input: 

- False Positive
- False Negative
- Ranking Error
- Classification Error

用途: 

- Eval
- Prompt refinement
- Few-shot examples
- 必要时增加规则