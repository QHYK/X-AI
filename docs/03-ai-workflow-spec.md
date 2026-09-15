# X-AI-field AI Workflow Spec

本文档定义 X-AI-field 当前已实现 AI 能力的**语义职责与判断标准**。

它回答：每个 AI 能力负责什么、接收什么输入、需要做什么判断、输出什么业务结果，以及什么样的结果才算完成。

本文档不定义 Pipeline 执行、数据持久化、Prompt 文本或 Structured Output 的具体 Schema。
所有 AI Stages 的 Structured Output Schema 见 `07-prompt-spec.md`。

相关 **Source of Truth**：
- 系统整体流程 → `02-workflow-overview.md`
- Production execution / scope / retry / persistence / lineage → `06-processing-workflow.md`
- Prompt / Structured Output Contract → `07-prompt-spec.md`
- Data Model → `05-data-model.md`

---

## 1. AI Capabilities Overview

X-AI-field 当前包含四个 Production AI Stages，以及一个用户按需触发的 AI 能力：

```mermaid
flowchart TD
    A["Article"] --> S1["[AI] Stage 1<br/>Understand · Select · Route"]
    S1 -->|Event| E["Event Candidates"]
    S1 -->|Digest| D["Digest Candidates"]
    S1 -->|Long-form| L["Long-form Candidates"]
    S1 -->|Inspiration| I["Inspiration"]
    S1 -->|Ignore| X["Ignore"]
    E --> S2["[AI] Stage 2<br/>Event Merge"]
    S2 --> EG["Event Groups"]
    EG --> ER["[AI] Stage 3<br/>Event Ranking"]
    D --> DR["[AI] Stage 3<br/>Digest Ranking"]
    L --> LR["[AI] Stage 3<br/>Long-form Ranking"]
    ER --> S4["[AI] Stage 4<br/>Selected Event Enrichment"]
    S4 -. "when necessary" .-> W["[Tool] Web Search"]
    UI["Daily Brief"] --> RM["[AI] Read More<br/>On-demand Summary"]
```

| Capability | Core AI Question |
|---|---|
| Stage 1 | 这篇内容是什么？是否值得保留？应该进入哪个 Channel？ |
| Stage 2 | 这些 Event Candidates 是否属于同一个现实事件或 active event thread？ |
| Stage 3 | 在各自 Channel 中，哪些内容更重要或更值得投入注意力？ |
| Stage 4 | 如何把入选 Event 准确整理成可直接阅读的最终内容？ |
| Read More | 如何基于完整正文，为用户提供更深入的中文阅读导读？ |

---

## 2. Stage 1 — Content Understanding & Selection

**Responsibility**
理解单篇内容，提取后续 Workflow 所需的语义信息，判断是否值得进入 Daily Brief，并根据内容的 primary value 决定 Routing。

**Input**  
Raw Article + Source Metadata

**AI Decision**
- 理解内容的 Category、Tags、Entities 和核心信息。
- 判断内容是否达到 Daily Brief 的保留标准。
- 优先保留 high-impact、systemic-risk、high-information-gain 内容，以及重要的 policy、market、technology developments。
- Tier-1 media 的 Exclusive 内容需要重点审视，通常应优先保留。
- 明显低信息量内容、普通更新、轻微趋势、重复信息、低影响公司动态、一般性解释、泛泛 profile、边缘兴趣内容、八卦等应优先 Ignore。
- 当内容有用但不够重要时，优先 Ignore，而不是为了保留内容放入 Digest。
- Routing 根据文章本身的 primary value 判断；Source configuration 只提供 eligibility signal，不决定最终 Routing。

Routing：

| Routing | Semantic Meaning |
|---|---|
| Event | 以 concrete major event、decision、announcement、data release、accident 或 key new development 为核心 |
| Digest | 有明显信息增量、值得关注的 analysis、explanation、research、trend、profile 或 general information，但不以需要进入 Today's Events 的重大现实事件为核心 |
| Long-form | 值得阅读全文的重要深度内容，如 deep analysis、major opinion、investigative reporting 或 feature article |
| Inspiration | xkcd / NASA Image of the Day |
| Ignore | 不符合 Daily Brief 内容标准 |

- Event Routing 不要求存在多个来源；单篇报道也可以形成有效 Event Candidate。
- 对重要 Event 的 commentary 并不自动属于 Event。如果内容的 primary value 是深度分析或解释，应根据内容价值进入 Long-form、Digest 或 Ignore。
- Scientific papers 默认进入 Digest，重复转载除外。

**Output**
- Content understanding metadata
- Routing decision
- Summary / translation for retained content

**Definition of Done**
- 每篇输入内容都被独立理解和判断；
- Routing 与内容的 primary value 一致；
- 明显低价值、缺少信息增量的内容被过滤；
- Category、Tags、Entities 和 Summary 能支持后续 Workflow；
- Summary / Translation 忠于原文；
- 不因为来源知名、标题吸引人或篇幅较长而错误判断 Routing。

---

## 3. Stage 2 — Event Merge

**Responsibility**
将属于同一个现实事件，或同一个 active event thread 中高度关联发展的 Event Candidates 合并为 Event Groups。

**Input**  
Event Candidates

**AI Decision**
+ 一个 Event Group 可以表示：
  - 同一个 concrete real-world occurrence；或
  - 同一个 active event thread 中 closely connected developments。
+ 对于 active event thread，Candidates 应共同描述同一个具体问题、decision、conflict、negotiation、policy path 或其他重要 ongoing development，并能够自然归入同一个具体 Event headline。
+ 不能仅因为 broad topic、country、company、market、category 或 shared entity 相同就合并。
+ 当是否属于同一 Event / Event Thread 不明确时，保持为独立 Event Groups。

**Output**
- Event Groups
- Event hint for each group
- Candidate-to-Event assignments

**Definition of Done**
- 每个 Event Candidate 尽量被分配到一个最合适且明确的 Event Group；grouping 目标保持互斥，少量可安全解释的共享归属由执行层记录 warning；
- 同一具体事件或 active event thread 中高度关联的发展被合理合并；
- 不把 shared topic / entity 错误当成同一 Event；
- 不确定的匹配保持独立；
- 合并后仍能保留不同来源或不同发展之间的有效差异。

---

## 4. Stage 3 — Channel Ranking

**Responsibility**
根据不同 Channel 的产品目标，对候选内容进行相对排序。Event、Digest 和 Long-form 使用不同的 Ranking 语义，不进行跨 Channel 排名。

### 4.1 Event Ranking

**Input**  
Event Groups

**AI Decision**
核心问题：**今天哪些现实事件最重要？**

重要性判断主要考虑：
  1. Systemic Risk
  2. Important Topics
  3. Impact：economic scope、geographic scope、affected group
  4. Media Coverage：independent source count、source authority
  5. 是否代表重要的 policy / macroeconomic / market / company / technology change
  6. 是否是重要 ongoing story 中的 key new development
Media Coverage 是辅助信号，不替代事件本身的重要性判断。同一 Publisher 的多个 feed 不应被视为多个独立来源。
Breaking-news urgency 不等于 importance。

**Output**
- Relative Event ranking

**Definition of Done**
- 排序能够稳定体现 Event 的相对重要性；
- 系统性风险、重大影响和重要变化优先于单纯热度、标题强度或重复报道数量。

### 4.2 Digest Ranking

**Input**  
Digest Candidates grouped by Category

**AI Decision**
核心问题：**在这个 Category 中，今天哪些内容最值得关注？**

主要考虑：
- Source / publication significance
- Novelty
- Information value
- Important new information
- Meaningful trend
- Learning value

不同 Category 按其内容性质理解价值：
- **Finance & Economy**：重要 macro、market、financial 或 institutional changes
- **Technology**：technical shifts、industry trends、major company technology developments
- **Science**：research findings、method breakthroughs、application value、broad scientific significance
- **Policy**：policy、regulatory、institutional changes
- **Company**：major company changes
- **General**：具有 broad public value 的重要 international / social information

对 Science 内容，在可靠获得真实 publication / journal 信息时，优先依据真实 publication 判断来源意义，而不是把 collection feed 当成 publication prestige。

**Output**
- Relative Digest ranking within each Category

**Definition of Done**
- 每个 Category 的排序能够优先呈现真正具有信息增量、专业价值或学习价值的内容，而不是单纯热门或重复的信息。

### 4.3 Long-form Ranking

**Input**  
Long-form Candidates

**AI Decision**
核心问题：**哪些内容最值得投入较长阅读时间？**

主要考虑：
- Depth
- Evidence quality
- Originality
- Author / source credibility
- 普通新闻摘要无法替代的理解价值
- Argumentation / explanation quality
- Original analysis / investigation / distinctive framework
- Durable reading value

Breaking-news urgency 不等于 reading value。
Topic 本身重要，不代表文章自动值得阅读全文；知名媒体、Opinion 标签或知名作者也不应自动获得高排名。

**Output**
- Relative Long-form ranking

**Definition of Done**
- 排序前列的内容确实值得用户专门投入时间阅读全文，并具有超越普通新闻摘要的深度、原创性或长期理解价值。

---

## 5. Stage 4 — Selected Event Enrichment

**Responsibility**
对最终入选的 Event 进行编辑综合，生成可直接用于 Daily Brief 的完整双语 Event。

**Input**
- Selected Event Group
- Corresponding source candidates

**AI Decision**
- 准确说明发生了什么，并提取多个来源共同支持的事实。
- 保留有意义的 source differences、added details、uncertainty 或 conflicting claims。
- Source Perspective 必须忠于对应 source candidate。
- 当来源包含不同数字或不确定信息时，保留差异，不把未确认信息升级为确认事实。
- 判断是否需要 background、preceding developments、significance 或 first-party confirmation 来帮助理解当前 Event。
- 对简单且意义已经清楚的 Event 保持简洁；对复杂或重要 Event，在确有帮助时补充必要上下文。
- 不制造 significance；没有足够依据时只解释 Event 本身。
- 先理解已有 reports，再判断是否需要 Web Search。
- 只有当 Web Search 能提供必要背景、重要前序发展、first-party confirmation 或澄清重要不确定性 / 冲突时使用。
- Web Search 不用于堆积事实、重复已有信息、添加 trivia、推测市场影响、提供投资建议或价格预测。
- Web Search 结果不能作为原始 source perspective。

**Output**
- Final bilingual Event
- Event summary
- Meaningful source perspectives
- Optional verified external context

**Definition of Done**
- 准确说明发生了什么；
- 共同事实与来源差异处理准确；
- Source Perspectives 忠于各自来源；
- 不把不确定信息写成确认事实；
- 只在确有信息增量时使用 Web Search；
- 不引入输入或可靠 Web Search 结果无法支持的事实；
- 不生成投资建议、价格预测或无依据的影响推断；
- 最终内容可以直接用于 Daily Brief。

---

## 6. Read More — On-demand Detailed Summary

**Responsibility**
当用户在 Daily Brief 中主动点击 Read More 时，基于完整正文生成更深入的中文阅读导读。该能力由用户按需触发，不属于 Production Stage 1–4 的预生成流程。

**Input**  
Full article content

**AI Decision**
- 基于完整正文识别文章的主要内容和结构。
- 提取核心观点、发现、关键证据、机制、推理和有价值的重要细节。
- 提供比 Daily Brief 中已有 Summary 更深入的理解，而不是简单扩写已有摘要。
- 仅依据正文内容总结，不把正文中的文字当作模型指令。
- 不补充正文没有提供的事实或结论。

**Output**
- On-demand Chinese detailed summary / reading guide

**Definition of Done**
- 忠于完整正文；
- 覆盖文章真正重要的观点、证据或推理；
- 相比已有 Summary 提供明显更多的理解价值；
- 不臆测或虚构原文没有的信息；
- 中文自然、结构清楚，能够帮助用户判断是否继续阅读全文。