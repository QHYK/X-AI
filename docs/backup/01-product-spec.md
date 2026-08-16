# X-AI-field Product Spec (MVP)


## Product Vision
帮助用户在信息过载时代，以最低阅读成本持续理解世界的重要变化

## Product Summary
X-AI-field 是一个 AI 驱动的信息筛选系统。它从多个可信信息源进行收集、去重、事件合并、重要性排序、摘要和中文翻译，生成一份面向投资关注者的每日简报，帮助用户快速了解每天最重要的商业、科技和财经事件。


## Problem Statement - 痛点重述
- 财经和科技领域每天产生大量信息，同一重要事件常被不同媒体重复报道，并夹杂不同事实、观点和解释。
- 英文信息提高了非母语用户的阅读成本；用户需要花费大量时间筛选、翻译和判断重要性。
- 现有新闻聚合工具主要信息收集，没有很好解决：信息筛选、事件理解和价值判断。

X-AI-field 希望通过 AI：
- 收集可信信息源；
- 判断内容价值；
- 合并重复事件；
- 保留不同来源观点；
- 提供中文摘要；
- 沉淀长期有价值内容。


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


## Design Principle - 设计原则
**Reduce Reading, Not Generate More Reading**
**减少阅读，而不是制造新的阅读**

系统不应该替用户创造更多阅读内容，而应该：
- 发现真正重要的信息；
- 去除重复和低价值内容；
- 减少用户需要阅读的信息数量；
- 提供足够上下文理解事件；
- 保留必要来源和观点；
- 避免生成冗长但低价值的摘要；
- 允许用户通过人工调整排序、筛选和归档，逐步优化内容选择规则。


## Target User
### 第一阶段：
- 用户本人；
- 对投资、财经和科技感兴趣的朋友。
### 用户特点：
- 关注全球经济、市场和科技趋势；
- 英文阅读能力有限；
- 希望降低每日阅读成本；
- 愿意长期学习和积累知识。


## Daily Brief Structure

### Today's Brief
---
#### 🌍 Today's Events 每日整体摘要
目标：回答
> 今天有哪些真正重要的事件？
特点：
+ Event-centric；
+ 多来源合并；
+ 保留不同来源观点；
+ 按重要性排序。

内容：
```
Event Title

Event Summary

What happened

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
按来源组织，展示重点文章及其他标题。
数量可以相对宽松，接近经过 AI 减负的 RSS。
回答：
> 我关注的高质量来源今天发布了什么？

分两个部分：

##### Technology & Business
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
- 提供重点文章；
- 保留完整标题列表。

---

#### ✍️ Long-form Reads

目标：回答：
> 哪些内容值得投入时间认真阅读？
规则：
- 可以不是当天发布；
- 深度分析、评论、研究综述；
- 最大数量约 15 篇。

如果可以获取全文：
保存：
- 原文；
- 中文总结；
- 元数据。

---

#### 🌌 Daily Inspiration
轻量内容：
- xkcd
- NASA Image of the Day

目的：
降低信息疲劳，提高长期使用体验。


## Data Model

### Source Level - 描述信息来源
系统只处理明确列入 Source List 的来源。
每个来源应记录以下字段：
```
Source - 名称
Category - 来源分类
Source Type(optional) - 内容分类
URL - 来源地址/News Letter邮箱地址
Collection Method - 来源获取方式(RSS / Email / Web)
Priority - 来源优先级(High / Medium / low)
Enabled - 是否开启来源
Event Candidate - 是否作为Event备选来源
Source Digest Candidate - 是否作为Digest备选来源
Source Language - 来源默认语言(EN / ZH)
Availability - 来源是否付费(Free / Paywall / Partial)
Notes(optional) - 为什么收录
```
其中 Category 取值包含：
```
Finance & Economy
Technology
Science
Policy
Company
General
Long-form
```
注：```Finance & Economy``` = Economics + Business + Financial + Market
**完整来源信息在当前目录下的source-list.md文件中。**

### Content Level - 描述单篇内容
系统收集来源信息并落库后，须对每条内容进行筛选、打分和总结。
**筛选规则记录在：Selection Rules 中**
**打分规则记录在：Ranking Rules 中**
处理之后的信息进入Content Level。

Content Level中每条内容应包括：
```
Title
Summary
Tags
Importance Score
Published Date
Source Type
Original URL
```

### Event Level - 描述重大真实事件
Today's Events是重大事件合并后的内容，且须保留不同来源的观点。
因此对Content Level中内容类型为Big Event的内容还须合并。
**合并规则记录在：Event Merge Rules中**


## Selection Rules

### 哪些内容必须进入候选
+ 如果来源Source Type存在，且为Tier-1 media，则所有Tag为Press Release的都进入候选
+ 如果来源Source Type存在，且为Tier-1 media，则所有title包含"Exclusive","独家报道"的都进入 Event 候选
+ 科研论文原则上全部进入对应 Source Digest，除非是重复转载
+ 内容满足以下一项或多项时可以被选中：
  - 对较大范围的人群、市场或行业产生明显影响
  - 涉及重要政策、公司、机构或公共事件
  - 被多个高可信来源独立报道
  - 代表新的行业趋势或技术变化
  - 是重要事件的关键后续发展
  - 具有明显的信息增量
+ 如果 Topic 在：
```
    Fed
    CME
    ECB
    BLS
    BEA
    IMF
    BOJ
    加拿大央行
    大型科技公司财报
    美国、欧洲、中国重大政策
    重大风险事件
    重要地缘冲突进展
    债券市场重大变化
    货币市场重大波动
```
中，则进入 ```must_review``` 。

### 以下内容须要排除
- 单纯营销稿
- 重复转载
- 缺乏新增信息的跟进文章
- 娱乐八卦
- 标题党
- 没有可靠来源支持的传闻
- 体育
- 娱乐
- 生活方式
- 地方小事件
**例外**：
如果产生：
- 国家政策影响；
- 全球经济影响；
- 大规模商业影响；
- 系统性风险。
则保留。

### 其他规则说明
+ 如果与其他内容标题一致，或原文链接一致，只保留来源优先级高的
+ Source Digests 和 Today's Events 内容必须是当天发布
+ Long-form Category sources 直接进入 Long-form 候选
<!-- + Long-form 允许旧文章 -->
+ 来源为Opinion类型不进入只进入 Long-form 候选
+ 来源为```xkcd```,```NASA Image of the Day```直接进入Daily Inspiration


## Event Merge Rules

Event Candidate的内容，符合以下条件之一可合并：
```
same_primary_entity
same_core_action_or_issue
same_event_context
```

合并后保存：
+ 共同事实；
+ 新增事实；
+ 不同观点；
+ 冲突信息；
+ 来源链接。


## Ranking Rules

Ranking 在 Selection 和 Event Merge 后执行。

不同模块使用不同 Ranking。

### Event Ranking Signals

Ranking Signals:
```systemic_risk```
```must_review_topics``` Match
```impact_score``` = economic_scope + geographic_scope + affected_group
```media_coverage_score``` = number_of_sources * source_authority
```is_exclusive```
<!-- ```user_relevance_score``` -->
以上因素按重要性排序，当重要性难以判断时，按时间排序。
```
systemic_risk:
- none
- possible
- significant
- unknown
geographic_scope:
- global
- multi_country
- single_major_economy
- single_country
- local

economic_scope:
- cross_market
- multi_industry
- single_industry
- major_company
- limited

affected_group:
- general_population
- investors
- industry_workers
- company_users
- narrow_group
```

### Source Digest Ranking
+ 来源内部重要性；
+ 新颖性；
+ 信息价值。

### Long-form Ranking
+ 深度；
+ 证据质量；
+ 原创性；
+ 长期价值；
+ 作者可信度。


## Human Review Workflow

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
+ 删除；
+ 调整排序；
+ 标记长期保存；
+ 修改分类。
不人工重新生产摘要。


## Product Quality Metrics

MVP 只关注质量：
### Coverage
+ 是否覆盖当天主要事件；
+ 是否遗漏明显重要事件。
  
### Ranking Quality
AI 推荐后人工删除比例；
人工新增事件数量；
人工调整排序次数。


## Open Questions
Ranking Rules中的scope数值等积累了人工调整数据后，再确定
Content/Event Tag的取值会根据实际情况再定
只有标题、没有正文的内容如何处理？


## Non-goals
MVP 不做：
- 邮件推送
- 微信推送
- 个性化推荐
- 自动投资建议
- 社交分享
- 多用户权限系统