# X-AI-field Product Spec

> 产品层 Source of Truth。本文件定义用户问题、产品价值、核心体验与 MVP 边界；具体 AI 职责、执行流程、技术实现、数据字段和 Prompt 分别以 `03`、`06` / `06a`、`04` / `04a`、`05`、`07` 为准。

## 1. Product Summary

X-AI-field 是一个面向主动学习者的 **AI Editor（AI 编辑）与优质内容发现系统**，帮助用户从大量信息中识别重要事实，并发现值得投入时间的优秀人类创作作品。

产品包含两条相互关联但目标不同的体验：

- **Daily Brief**：持续跟踪可信来源，合并重复事件，提炼重要事实和来源差异，让用户高效了解每天发生了什么。
- **In-depth Discovery**：利用近期 Daily Brief 中的新闻与作品线索，或开展开放式探索，发现具有原创性、解释深度、可靠证据和长期学习价值的文章、视频或播客。

两者共同服务于一个目标：**降低发现高质量知识信号的成本，而不是增加信息消费量。**

## 2. Problem Statement

### 2.1 每日信息理解成本高

- 财经和科技领域每天产生大量信息，同一重要事件常被不同媒体重复报道，并夹杂不同事实、观点和解释。
- 英文信息提高了非母语用户的阅读成本；用户需要花费大量时间筛选、翻译和判断重要性。
- 现有新闻聚合工具主要信息收集，没有很好解决：信息筛选、事件理解和价值判断。

### 2.2 真正值得学习的作品难以发现

- 优秀的解释性文章、独立研究、视频和播客散落在不同平台；发现与质量验证需要大量时间。
- 热门、最新、知名媒体或较长篇幅，都不能直接证明一篇作品具有长期阅读价值；低质量和 AI 批量生成内容进一步增加筛选成本。
- 用户需要的是**少量有明确阅读回报的作品**，而不是另一条无限内容流。

## 3. Target User

- 开发者本人，和对投资、财经和科技感兴趣的朋友。
### 用户特点：
- 关注全球经济、市场和科技趋势；
- 英文阅读能力有限；
- 希望降低每日阅读成本。

## 4. Product Goals

### 4.1 Daily Brief — 快速理解今天发生了什么

每天自动生成一份 Daily Brief，帮助用户快速了解：
> 重要财经事件、科技进展和值得阅读的内容。
重点：
  - 财经市场；
  - 宏观政策；
  - 重大风险；
  - 科技发展；
  - 重要科学发现

### 4.2 In-depth Discovery — 找到值得投入时间的作品

每两天执行一次独立 Discovery，在最近两期 Daily Brief 的基础上寻找值得深入学习的内容，并在必要时进行开放式探索。
优先推荐文章、视频和播客，目标阅读、观看或收听时长原则上不超过 30 分钟；不为凑数降低标准。
In-depth Reads 经人工审核后展示：`approved` 即上架，`pending` 与 `rejected` 不向读者展示。审核者可以生成、编辑和保存「讲了什么」「为什么值得用心阅读」「其他具体评估」三段 Editorial 内容。展示与存储规则见 `04-technical-spec.md` §7.3 和 `05-data-model.md` §11.4。

#### 人工添加候选（Phase B1）

编辑人员可提交原始 URL 和最多三组可选双语 Tags。先查找相同作品的现有审核候选：命中时展示完整已有记录，不新增、不改状态、不覆盖 Tags 或介绍、不自动生成。未命中时优先复用已有元数据与完整正文；必要时只抓取该 URL，成功后创建 manual / pending 候选。正文无法获取或不完整时明确失败，不创建无正文的候选。

Generate 由编辑人员另行触发，基于已保存正文生成中文标题、内容概要、推荐理由、补充评价及适用 Tags；不做 D4 的入选判断，不改变审核状态。完整生成结果默认直接复用，Regenerate 必须显式请求。人工 Tags 优先保留。三段介绍仍可人工编辑保存，Approve / Reject 与 Notes 独立；只有 Approved 才公开。本功能不恢复标题、作者人工编辑。技术与数据边界见 `04a` §6.4、`05` §11，Prompt 契约见 `07` 的 Manual In-depth Generate。

## 5. Design Principles

- **Quality over quantity**
- **Make Deep Reading Worthwhile**：减少寻找优秀作品的成本，而不是减少有价值的深度阅读。
- Reduce Reading, Not Generate More Reading
- Importance over completeness
- Facts before interpretation
- Preserve source disagreement
- LLM-first, rules only when necessary

系统不应该替用户创造更多阅读内容，而应该：
  - 去除重复和低价值内容；
  - 允许用户通过人工调整结果并记录 Feedback，持续优化 AI 的内容选择与排序。


## 6. Daily Brief Experience

### Today's Brief Structure

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

---

#### 📰 Source Digests
按 Category 组织。数量相对宽松，接近经过 AI 减负的 RSS。

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

---

#### ✍️ Long-form Reads
回答：
> 哪些内容值得投入时间认真阅读？

规则：
- 深度分析、评论、研究综述；最多约 10 篇。

---

### 🌌 Daily Inspiration
轻量内容：
- xkcd
- NASA Image of the Day


### Content Selection Principles
+ Prefer：
  - 重要政策、公司、机构或公共事件
  - Important Topics：Fed, CME, ECB, BLS, BEA, IMF, BOJ, 加拿大央行, 大型科技公司财报, 美国、欧洲、中国重大政策, 重大风险事件, 重要地缘冲突进展, 债券市场重大变化, 货币市场重大波动
  - 对较大范围的人群、市场或行业产生明显影响
  - 代表新的行业趋势或技术变化
  - 是重要事件的关键后续发展


#### Event Ranking
+ Systemic Risk
+ Important Topics
+ Impact (economic_scope, geographic_scope, affected_group)
+ Media Coverage (number_of_sources, source_authority)

#### Source Digest Ranking
+ 来源内部重要性；
+ 新颖性；
+ 信息价值。

#### Long-form Ranking
+ 深度；
+ 作者可信度；
+ 原创性；
+ 证据质量；


## 7. Success Criteria

### 7.1 Daily Brief

- **Coverage**：是否遗漏明显重要事件；
- **Ranking Quality**：重要性排序是否需要频繁人工调整；
- **Precision**：人工删除的低价值内容比例；
- **Reading Efficiency**：是否减少用户了解重要事件的时间。

### 7.2 In-depth Discovery

首版以人工审核和真实运行观察为主。

- **Editorial Precision**：进入人工审核的作品中，有多少确实值得阅读或收藏；
- **Evidence Quality**：推荐理由是否由实际内容与可追溯证据支持；
- **Novelty / Duplication**：是否重复推荐历史作品，是否发现 Daily 之外的优质作品；
- **Review Effort**：人工判断、补充探索所需的时间；
- **Reliability / Cost**：正常空结果与执行失败能否区分，单次探索耗时及资源消耗是否可接受。


## 8. Human Review v1

Human Review 用于检查 AI Ranking 结果、调整最终展示顺序并记录 Feedback，为后续优化 AI 判断提供数据。

当前支持：
- Event Ranking Review；
- Long-form Ranking Review；
- 调整最终展示顺序；
- 记录 False Positive、False Negative 与 Ranking Error。


## 9. Scope & Non-goals

**Scope**：现有 Daily Brief；独立的 Discovery 定时 / 手动运行；Direct、Topic 与条件触发的 Open；真实内容获取与验证；候选持久化和可追溯记录；人工审核与人工补充探索入口。

**Non-goals**：
- 邮件推送
- 微信推送
- 个性化推荐
- 自动投资建议
- 社交分享
- 多用户权限系统
