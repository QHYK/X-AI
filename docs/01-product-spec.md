# X-AI-field Product Spec

## Product Summary
X-AI-field 是一个 AI Editor（AI 编辑）系统，它持续监控可信信息源，理解每天发生的重要事件，并生成一份帮助用户了解每天最重要的商业、科技和财经事件的中文 Daily Brief。

## Problem Statement
- 财经和科技领域每天产生大量信息，同一重要事件常被不同媒体重复报道，并夹杂不同事实、观点和解释。
- 英文信息提高了非母语用户的阅读成本；用户需要花费大量时间筛选、翻译和判断重要性。
- 现有新闻聚合工具主要信息收集，没有很好解决：信息筛选、事件理解和价值判断。

## Target User
- 开发者本人，和对投资、财经和科技感兴趣的朋友。
### 用户特点：
- 关注全球经济、市场和科技趋势；
- 英文阅读能力有限；
- 希望降低每日阅读成本。

## Product Goal
Generate a concise daily business & tech briefing that helps users quickly understand what happened today.
每天自动生成一份 Daily Brief，帮助用户快速了解：
> 重要财经事件、科技进展和值得阅读的内容。
重点：
  - 财经市场；
  - 宏观政策；
  - 全球风险；
  - 科技发展；
  - 科学发现

## Design Principle
- Reduce Reading, Not Generate More Reading
- Importance over completeness
- Facts before interpretation
- Preserve source disagreement
- LLM-first, rules only when necessary

系统不应该替用户创造更多阅读内容，而应该：
  - 去除重复和低价值内容；
  - 允许用户通过人工调整排序、筛选和归档，逐步优化内容选择规则。


## Daily Brief Structure

### Today's Brief
---
#### 🌍 Today's Events
回答：
> 今天有哪些真正重要的事件？
特点：
+ Event-centric；
+ 多来源合并；
+ 保留不同来源观点；
+ 按重要性排序。

内容：
```
Event Title

What happened?(Summary)

Different Sources:
- Reuters
- Bloomberg
- FT

Original Links
```

规则：
- 同一事件合并；
- 保留不同来源观点；
- 不展示重复转载。

---

#### 📰 Source Digests
按 Category 组织，展示重点文章及其他标题。
数量可以相对宽松，接近经过 AI 减负的 RSS。
回答：
> 关注的高质量来源今天重点发布了什么？

按 Category 分组：

##### Technology
例如：
- TechCrunch
- MIT Technology Review
- The Verge

##### Science
例如：
- Nature
- Science
- JACS

规则：
- 不追求严格数量限制；
- 类似智能 RSS；
- 提供重点文章。

---

#### ✍️ Long-form Reads
回答：
> 哪些内容值得投入时间认真阅读？
规则：
- 可以不是当天发布；
- 深度分析、评论、研究综述；
- 最大数量约 10 篇。

如果可以获取全文：
保存：
- 原文；
- 中文总结；
- 元数据。

---

### 🌌 Daily Inspiration
轻量内容：
- xkcd
- NASA Image of the Day


## Content Selection Principles
+ Prefer：
  - 重要政策、公司、机构或公共事件
  - Important Topics：Fed, CME, ECB, BLS, BEA, IMF, BOJ, 加拿大央行, 大型科技公司财报, 美国、欧洲、中国重大政策, 重大风险事件, 重要地缘冲突进展, 债券市场重大变化, 货币市场重大波动
  - 对较大范围的人群、市场或行业产生明显影响
  - 代表新的行业趋势或技术变化
  - 是重要事件的关键后续发展

### 其他规则说明
+ 来源为Tier-1 media，所有Tag为Press Release的都进入候选
+ 来源为Tier-1 media，所有title包含"Exclusive","独家报道"的都进入 Event 候选
+ Long-form Category sources 直接进入 Long-form 候选
+ 来源为Opinion类型，只进入 Long-form 候选


## Event Merge Principles
合并同一现实事件的 Event Candidate，并保留来源差异


## Ranking Objectives
不同模块考虑不同 Ranking Signals。

### Event Ranking
+ Systemic Risk
+ Important Topics
+ Impact (economic_scope, geographic_scope, affected_group)
+ Media Coverage (number_of_sources, source_authority)

### Source Digest Ranking
+ 来源内部重要性；
+ 新颖性；
+ 信息价值。

### Long-form Ranking
+ 深度；
+ 作者可信度；
+ 原创性；
+ 证据质量；


## Human Review [Planned]

```
AI Pipeline
↓
Draft Brief
↓
Publish
↓
Human Review
```
人工操作不影响发布流程，人工可进行的操作包括：
+ False Positive - 删除；
+ Ranking Error - 调整排序；
+ Classification Error - 修改分类；
+ False Negative - 补充遗漏。
不人工重新生产摘要。


## Success Metrics

### Coverage
+ False Negative - 是否遗漏明显重要事件
  
### Ranking Quality
+ 人工调整排序次数

### Precision
+ False Positive - 人工删除比例

## Non-goals
MVP 不做：
- 邮件推送
- 微信推送
- 个性化推荐
- 自动投资建议
- 社交分享
- 多用户权限系统