# Overview
```xml
Source Collection                 ← Code
        ↓
Raw Articles
        ↓
┌───────────────────────────────────────┐
│ AI Capability 1                       │
│ Content Understanding & Selection     │
└───────────────────────────────────────┘
        ↓
    Routing
        ↓
┌──────────────┬──────────────┬──────────────┐
│ Event        │ Source       │ Long-form    │
│ Candidates   │ Digest       │              │
└──────┬───────┴──────────────┴──────────────┘
       ↓
┌───────────────────────────────────────┐
│ AI Capability 2                       │
│ Event Understanding & Merge           │
└───────────────────────────────────────┘

三个分支
        ↓
┌───────────────────────────────────────┐
│ AI Capability 3                       │
│ Prioritize information                │
└───────────────────────────────────────┘
        ↓
Top N / ordering                      ← Code
        ↓
Daily Brief Composition              ← Code
        ↓
Publish
        ↓
Human Feedback Capture               ← Code
```

---

# Capability 1：Content Understanding & Selection

Responsibility: 理解单篇内容，并判断它是否值得保留、应该进入 Daily Brief 的哪个分支。

Input: Raw Article + Source Metadata + Source Default Tags

Output:

- Category
- Tags
- Entity
- Content Type (Event Candidate, Source Digest Candidate, Long-form Candidate, Ignore)
- Generated Content: 
  - Summary
  - Chinese Translation
<!-- - Selection Reason -->

Quality Criteria:
```xml
✓ 分类正确
✓ Tag准确
✓ 不遗漏重要Topic
✓ 不把明显无关内容保留
✓ Summary忠于原文
✓ 翻译自然且准确
```
---

# Capability 2：Event Understanding & Merge

Responsibility: 判断 Event Candidates 之间的关系，将同一现实事件的报道合并，并保留不同来源的信息差异。当现有来源无法完整描述事件、存在信息冲突或需要补充背景时，主动获取外部可信信息，以提高事件理解质量。

包括：

- Identify what happened
- Merge
- Different viewpoints
- External Context Retrieval

Input: Event Candidates

Output:

- Event Group
- Event Summary + Source-specific Summary
- Common Facts
- Conflicting Information
- Different Viewpoints

Quality Criteria:
```xml
✓ 同一事件尽可能合并
✓ 不同事件不要误合并
✓ 保留共同事实
✓ 保留来源独有观点
✓ 冲突信息不能丢失
✓ 必要时补充背景
```
---

# Capability 3：Prioritize information

Responsibility: 根据不同 Daily Brief 分支的目标，对候选内容进行相对重要性排序。

```xml
Today's Events
→ 什么最重要？

Source Digests
→ 在这个来源内部什么最值得关注？

Long-form Reads
→ 什么最值得投入阅读时间？
```

Input: Processed Event / Source Digest Content / Long-form Content

Output:

- Rank
- Ranking Reason

Quality Criteria:
```xml
✓ Today's Events
优先展示真正重要事件

✓ Source Digest
能够代表当天来源主要内容

✓ Long-form
真正值得阅读

✓ 排序符合用户预期
```
---

# Capability 4：Human Feedback Capture

Responsibility: 记录人工对 AI 输出的修正，用于评估和后续优化。

Input：

- False Positive
- False Negative
- Ranking Error
- Classification Error

用途：

- Eval
- Prompt refinement
- Few-shot examples
- 必要时增加规则

Quality Criteria:
✓ 所有人工修改都有记录
✓ 可以回溯原因
✓ 可以用于Prompt优化
✓ 不增加人工负担
