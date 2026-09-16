# Processing Workflow

本文档定义 X-AI-field **Production Processing Workflow 的实际执行逻辑**：每一步何时执行、读取什么数据、如何判断、产生什么结果、如何失败与重跑，以及各 Stage 之间如何保持明确 lineage。

本文档不重复定义 AI 的判断标准或 Prompt Contract：

- AI 各 Stage 的职责与语义：见 `03-ai-workflow-spec.md`
- 系统架构与稳定技术决策：见 `04-technical-spec.md`
- 数据表、字段、约束与索引：见 `05-data-model.md`
- Structured Output / Prompt Contract：见 `07-prompt-spec.md`
- 完整系统总览：见 `02-workflow-overview.md`

> 本文档描述“系统怎么跑”，而不是“模型应该怎么判断”。

---

## 1. Workflow Overview

正式 Daily Workflow 由一个 Orchestrator 顺序执行：

```text
Collection
    ↓
Pre-Stage1 Exact Dedup
    ↓
Content Completion
    ↓
Stage 1 — Content Understanding & Selection
    ↓
Stage 2 — Event Merge
    ↓
Stage 3 — Channel Ranking
    ↓
Stage 4 — Selected Event Enrichment
    ↓
Publish-ready data
```

正式入口：

```bash
npm run daily
```

各阶段也允许人工单独执行，用于开发、诊断和局部重跑：

```bash
npm run collect:rss
npm run complete:content
npm run process:stage1
npm run process:stage2
npm run process:stage3
npm run process:stage4
```

Daily Workflow 不引入独立 Workflow Engine、Message Queue 或多套定时器。后一步只在前一步成功完成后继续执行。

---

## 2. Daily Scope

### 2.1 Daily Date

系统统一使用：

```text
Timezone: Asia/Shanghai
Daily boundary: 08:30
```

一个 Daily Date 表示“截至该日 08:30 已结束的一期”。

例如：

```text
Daily 2026-08-25

base published_at scope:
2026-08-24 08:30
<= raw_articles.published_at <
2026-08-25 08:30
```

如果未显式指定日期，Orchestrator 选择**最近一个已经结束的 08:30 boundary**。

显式重跑 / backfill：

```bash
DAILY_DATE=2026-08-25 npm run daily
```

同一 `DAILY_DATE` 必须得到同一个固定 24 小时 base scope，不能因为实际执行时间变化而漂移。

### 2.2 `published_at` 与 `daily_date`

需要区分两个概念：

**`raw_articles.published_at`**

- 表示内容原始发布时间；
- 用于定义 Daily 的基础时间范围；
- 用于 Content Completion / Stage 1 的时间 eligibility；
- `collected_at` 只表示系统何时采集，不用于 Daily 内容归属。

**`processed_contents.daily_date`**

- 表示该内容实际在哪一期 Daily 中首次进入 Production Workflow；
- Stage 1 在 Selected 内容写入 `processed_contents` 时赋值；
- Stage 2 / Stage 3 后续以该字段读取当前 Daily 的候选内容；
- 用于容纳延迟采集（late-arrival）的内容。

因此，late-arrival 文章即使原始 `published_at` 早于当前 Daily 的 24 小时 base scope，只要仍处于 Stage 1 catch-up window，并在当前 run 首次被选中，就归入当前 `daily_date`。

### 2.3 72 小时 Catch-up Window

Daily Workflow 中：

```text
Content Completion
Stage 1
```

不只读取 24 小时 base scope，而使用：

```text
daily_end - 72 hours
<= raw_articles.published_at <
daily_end
```

目的：覆盖 RSS / Source 延迟进入系统但仍值得处理的内容。

Daily scope 本身仍是 24 小时；72 小时只是一层 **catch-up eligibility window**。

相关环境值由 Orchestrator 统一生成并传给子步骤。子步骤不得重新按“当前时间”独立计算 Daily 范围。

---

## 3. Collection

### 3.1 Responsibility

Collection 负责：

```text
External Source
    ↓
Fetch
    ↓
Normalize
    ↓
Basic identity dedup
    ↓
raw_articles
```

不同 Collector 最终必须输出统一 Raw Article 结构。

当前正式实现以 RSS Collector 为主。

### 3.2 Source Selection

Collector 读取 `sources` 配置，只处理启用的 Source，并根据 `collection_method` 选择对应 Adapter。

概念上的 Adapter：

```text
RSS
Email
Web
```

当前没有必要建立通用复杂 Collector Framework；不同来源只在确有差异时增加轻量 Adapter。

### 3.3 Collection-level Exact Dedup

Collection 阶段优先使用来源提供的稳定 identity：

```text
source_id + source_item_origin_id
```

例如：

```text
RSS GUID
Atom ID
Gmail Message ID
```

没有稳定 item ID 时，再使用 URL 等稳定字段。

确定为同一 Source Item 的内容不再次插入 `raw_articles`。

---

## 4. Pre-Stage1 Exact Dedup

Collection 后、进入正文补全 / Stage 1 前，对 Raw Articles 做第二层 **exact duplicate** 处理。

该步骤只处理可确定为同一原文的重复，不进行语义相似度判断，也不做 Event merge。

当前规则包括：

```text
normalized / trimmed URL 相同
或
title 相同
```

若存在重复：

```text
winner → 保持可处理
loser  → raw_articles.stage1_status = ignored
          processing_error = "duplicate"
```

winner 使用确定性的 Application Code comparator，依次考虑：

1. `content_text` 长度更长；
2. Source 名称长度更短；
3. ID 作为最后稳定 tie-breaker。

当前 comparator 不使用 `created_at`。该规则只用于 exact duplicate 中选择保留记录，不表达 Source 质量或内容重要性。

跨媒体报道同一现实事件不属于这里的重复：

```text
Reuters: Fed ...
Bloomberg: Fed ...
FT: Fed ...
```

这些必须全部保留，交给 Stage 2 判断是否属于同一 Event。

---

## 5. Content Completion

### 5.1 Responsibility

Content Completion 只解决：

> 当前 Raw Article 是否有足够正文供 Stage 1 理解？

它不负责内容价值判断，也不调用 LLM。

```text
raw_articles
    ↓
content sufficient?
    ├─ yes → keep
    └─ no
        ↓
      Firecrawl scrape
        ↓
      extract article-relevant content
        ↓
      update content_text
```

### 5.2 Eligibility

只有正文不足且具有可抓取 URL 的 Raw Article 才需要进入正文补全。

典型情况：

```text
content_text = null
content_text = empty
内容明显不足以支撑 Stage 1 理解
```

具体正文充分性判断由 Content Completion implementation 维护，不在 Prompt 中实现。

### 5.3 Fetch & Persistence

当前使用 Firecrawl `/v2/scrape` 获取 Markdown。

提取优先关注：

```text
Abstract
Takeaways
Key Points
Summary
Article body
```

结果：

- Stage 1 所需正文写入 `raw_articles.content_text`；
- 原始 Firecrawl Markdown 只进入 runtime artifact；
- 只有经过清洗、足够完整且具有后续详情复用价值的正文才写入 `full_content_text`；
- Stage 1 不读取 `full_content_text`。

### 5.4 Failure

补抓失败不会删除 Raw Article。

```text
Completion failed
    ↓
Raw Article remains
    ↓
Stage 1 may still judge from available title / metadata / content
```

Content Completion 失败和 Stage 1 失败是两个独立概念。

### 5.5 Runtime

每次运行创建：

```text
runtime/content-completion/<timestamp>/run.json
```

至少记录：

- candidate count
- selected count
- success / failed / skipped
- remaining backlog
- duration
- effective limit / per-source limit
- effective scope

失败 run 也保留真实已获得 metrics；未知值保持 `null`，不根据数据库当前状态反推历史结果。

---

## 6. Stage 1 — Content Understanding & Selection

### 6.1 Eligibility

只处理：

```text
raw_articles.stage1_status IN ("pending", "failed")
```

并满足当前执行的时间范围。

两种执行方式：

**Daily Workflow**

```text
使用 daily_end 向前 72 小时的 published_at catch-up window
```

**Standalone**

```text
默认读取最近 24 小时 published_at
```

### 6.2 Micro-batch

Stage 1 为减少请求数量使用 micro-batch，但每篇文章仍独立判断。

当前默认：

```text
batch size:                15 articles
single article threshold:  20,000 characters
batch total threshold:     60,000 characters
concurrency:               3
```

Long-form 或超出单篇正文阈值的文章单独处理。

Workflow-relevant overrides：

```bash
STAGE1_CONCURRENCY=2 npm run process:stage1
STAGE1_BATCH_SIZE=10 npm run process:stage1
STAGE1_BATCH_MAX_CONTENT_CHARS=15000 npm run process:stage1
STAGE1_BATCH_MAX_TOTAL_CHARS=50000 npm run process:stage1
```

Standalone diagnostic / limited run 可使用：

```bash
STAGE1_LIMIT=20 npm run process:stage1
```

完整 CLI / environment parameter reference 后续统一维护在 Operations / Commands 文档；本文只保留影响 Workflow 行为的参数。

### 6.3 Retry and Split Fallback

一个 micro-batch 的 LLM retry 耗尽后：

```text
failed batch
    ↓
split in original order
    ↓
left half + right half
    ↓
only failed subsets continue splitting
    ↓
singleton
```

已经成功的子集不再次调用。

该机制用于隔离异常 input，而不是通过无限 retry 掩盖问题。

### 6.4 Persistence

Stage 1 的结果：

**Ignore**

```text
raw_articles.stage1_status = ignored
不创建 processed_contents
```

**Selected**

```text
raw_articles.stage1_status = selected
创建 processed_contents
processed_contents.daily_date = current workflow dailyDate
```

**Failed**

```text
raw_articles.stage1_status = failed
raw_articles.processing_error = ...
```

Stage 1 rerun 只重新处理 `pending` / `failed`；已经 `selected` / `ignored` 的文章不重复处理。

### 6.5 Runtime

每次 Stage 1 run 保存可审计 input / attempt / summary，例如：

```text
runtime/stage1/<run-id>/
    batches/
    attempts.jsonl
    summary.json
```

runtime 用于诊断、统计和 lineage，不代替 Production DB。

---

## 7. Stage 2 — Event Merge

### 7.1 Candidate Loading

Stage 2 从 Production DB 读取当前：

```text
processed_contents.daily_date = target dailyDate
routing = event
raw_articles.stage1_status = selected
```

Stage 1 runtime 只作为本次 Workflow lineage / debug 信息保存，不作为 Stage 2 业务候选筛选条件。

### 7.2 Execution

```text
Event Candidates
    ↓
build Stage2Input
    ↓
single long-context LLM call
    ↓
Stage2Output
    ↓
Event Groups
```

Stage 2 当前不做：

- batch merge；
- cross-batch reconciliation；
- Event ranking；
- 最终 Event enrichment；
- `events` persistence。

Event Group 是可重建的 Production 中间态。Stage 2 成功后，将当前 `daily_date` 的 Event Groups 作为可替换 snapshot 写入 `event_groups` / `event_group_items`。Stage 3 从该 DB snapshot 读取 Event Groups；runtime artifacts 只用于 observability / debug，不作为 Stage 3 的业务输入。

### 7.3 Validation

模型输出应满足：

```text
每个 candidate 恰好属于一个 group
不遗漏 ID
不重复 ID
不生成不存在的 ID
```

Stage 2 优先保留可安全解释的 Structured Output。assignment anomaly 分级如下：

```text
同内容跨 Group 引用 / 同 Group 重复 / missing ID
→ runtime warning
→ 保留跨 Group membership；同 Group deterministic dedupe；继续 replace snapshot

invented / modified ID
→ fatal validation
→ 写入 failed runtime diagnostic，且不 replace Event Group snapshot
```

### 7.4 Persistence and Runtime

Stage 2 成功后，以当前 `daily_date` 为 scope replace 对应的 Event Group snapshot：

```text
event_groups
    ↓
event_group_items
```

该 DB snapshot 是 Stage 3 的正式业务输入。重复执行 Stage 2 可以重建并替换当前 Daily 的 snapshot，不直接创建最终 `events`。

Stage 2 同时写入 runtime artifacts：

```text
runtime/stage2/<run-id>/
    input.json
    id-map.json
    output.json
    run.json
```

`run.json` 记录 model / prompt version、token usage、retry / duration、assignment validation、warnings、success / failed 等运行信息。warnings 保存 cross-group memberships、same-group duplicates 与 missing IDs；`pipeline_runs.metrics` 只保存相应的计数摘要。runtime artifacts 用于 observability / debug，不作为 Stage 3 的 Production Source of Truth。

---

## 8. Stage 3 — Channel Ranking

Stage 3 不是一次单一 Ranking，而是多个有顺序依赖的步骤。

### 8.1 Inputs

**Event**

```text
读取 event_groups / event_group_items
where daily_date = target dailyDate
```

Stage 3 读取 Stage 2 已持久化的当前 Daily Event Group snapshot，不从 Stage 2 runtime artifact 重建业务输入。

**Digest / Long-form**

```text
processed_contents.daily_date = target dailyDate
raw_articles.stage1_status = selected
```

### 8.2 Execution Order

```text
Event Groups
    ↓
Event Global Ranking
    ↓
persist Event Top 50 Review Snapshot
    ↓
Code selects Top N Events
    ↓
Cross-channel Exact Dedup
    ↓
Digest Global Exact Dedup
    ↓
Science Publication Enrichment
    ↓
Digest Ranking by Category
+
Long-form Global Ranking
```

### 8.3 Event Ranking

LLM 最多返回 50 个 Event Groups。

```text
AI ranking
    ↓
event_review_items snapshot
    ↓
Code Top N selection
```

最终 Top N 由 Application Code 决定，不由 LLM 自行决定展示数量。

当前正式 Stage 4 cutoff：

```text
Top 15 Events
```

### 8.4 Cross-channel Exact Dedup

Selected Events 确定后，Digest / Long-form 中与其属于**同一原文**的内容被排除。

这里只做 exact dedup，例如 normalized URL；不执行语义去重。

随后 Digest 自身还进行一次全局 exact dedup，避免同一原文通过多个 feed 重复进入 Digest Ranking。

### 8.5 Science Publication Enrichment

Science Digest 在 Ranking 前允许补充可靠 publication / journal 信息。

该步骤只补充 ranking 所需 metadata，不改写文章核心内容，也不把 subject feed 名称误当成真实 journal。

### 8.6 Digest / Long-form Ranking

```text
Digest    → 按 Category 独立排序
Long-form → 全局排序
```

Event Review snapshot、Digest Ranking 与 Long-form Ranking 分别在自身完成 parse、validation 与可确定性 normalization 后持久化。任一子 Ranking 后续失败不回滚已经完成的独立产物；Stage 3 在已有至少一个合法产物、且没有持久化错误时记录 `partial`，只有未形成任何可用产物时记录 `failed`。数据库持久化错误仍为 `failed`，不以 `partial` 掩盖。Stage 4 只依赖有效的 Event Review snapshot，不要求整个 Stage 3 execution 为 `success`。同一上游输入 snapshot 的 Retry 会复用已持久化且可验证的子 Ranking；输入 hash 变化时重新执行该子 Ranking。

结果写入：

```text
processed_contents.ai_rank
```

首次建立 rank 时：

```text
display_rank = ai_rank
```

如果已有人工 Review 修改过 `display_rank`，普通 Daily rerun 不应覆盖人工排序。

### 8.7 Event Review Snapshot

Event Ranking 成功后创建新的：

```text
event_review_items.review_run_id
```

完整保存当次 Event Top 50（不足 50 时保存全部）。

Stage 4 最终创建 Event 时，将对应：

```text
ai_rank
display_rank
event_review_item_id
```

一并写入 `events`。

---

## 9. Stage 4 — Selected Event Enrichment

### 9.1 Trigger

Stage 3 完成后，只处理最终 Selected Event Groups。

每个 Event 独立 enrichment。当前 Production DB path 按 Selected Events 顺序串行执行 enrichment；不把并发参数作为当前 Production Workflow contract。具体可执行参数见 `09-operations.md`。

### 9.2 Execution

```text
Selected Event Group
    ↓
context need pre-check
    ├─ existing sources sufficient
    │      ↓
    │   Chat Completions
    │
    └─ external context materially needed
           ↓
       Responses API + web_search
           ↓
       final structured Event
    ↓
Schema Validation
    ↓
Persistence Plan
```

普通 Structured Output 默认使用 Chat Completions。

只有当上下文预判确认现有 source 不足以理解事件时，才进入 Responses API + Web Search 路径。

是否真的执行过 Web Search，Application Code 必须根据真实 tool usage / provenance 判断，不能只相信模型在输出 JSON 中自行声明。

### 9.3 `event_date` and Daily Attribution

`event_date` 不由 LLM 输出。

当前 Production 语义中，Stage 4 Event 属于一个明确的 Workflow Daily：

```text
events.event_date = stage4_runs.daily_date = target dailyDate
```

因此 `event_date` 表示该 Event 在 Production 中所属的 Daily attribution date，不再根据组成 Event 的 source article 最早 `published_at` 单独推导。

Source article 的原始发布时间继续保存在 `raw_articles.published_at`；late-arrival 内容进入哪一期 Daily，由 Stage 1 写入的 `processed_contents.daily_date` 以及后续当前 Daily snapshot 决定。不要混用 source publication time、现实事件发生时间与 Production Daily attribution。

### 9.4 Draft Persistence and Atomic Publish

Stage 4 的持久化 scope 以当前 `daily_date` / `stage4_run` 为边界，而不是从 Event source timestamps 推导多个 `event_date` scope。

```text
target dailyDate
    ↓
create Stage 4 Run
    ↓
enrich each Selected Event
    ↓
persist durable draft Event immediately
    ↓
draft count == expected_count ?
    ├─ no  → run remains partial; do not replace previous published run
    └─ yes → atomic publish current complete set
             + archive previous published set for the same Daily
```

每个 enrichment 成功后立即把对应 Event 作为当前 `stage4_run` 的 draft 持久化，避免前面已经完成的 Event 因后续单项失败而丢失。只有当前 Run 的完整 draft 数量达到 `expected_count` 时，才允许把整套结果原子发布。

同一 Daily 的 publish / archive 只作用于该 `daily_date` 的 publication state，不影响其他 Daily 的历史 Event。发布时不得形成“部分新 Event + 部分旧 published Event”的混合正式集合。

Stage 4 创建 Event 时保存对应的：

- `stage4_run_id`；
- `publication_status`；
- `event_review_item_id`；
- `ai_rank` / `display_rank`；
- 真实 external context provenance（仅真实发生 Web Search 时）。

`event_group_items` 是组成 Event 的 source membership truth，经 `event_review_items.event_group_id` 关联到最终 Event，允许 source content 被多个 Event 共享。`processed_contents.event_id` 仅为单值兼容 backlink；共享内容不写任意一个 Event ID。系统不创建额外 `event_articles` join table。

### 9.5 Daily Brief Visibility

Daily Brief 对同一 `daily_date` 只读取一个一致的 Stage 4 generation state：

- 当前 Run 已完整 publish：读取该 Run 的 published Event set；
- 已有旧 published set、当前 Run 仍为 running / partial：继续读取旧 published Event set；不返回 draft，也不混合两套结果；
- 尚无 published set、当前 Run 仍为 running / partial：可以返回该 Run 已完成的 draft partial set，并明确保持 partial 状态；
- complete-set publish 后原子归档并替换同一 Daily 的旧 published set。

因此 Stage 4 的 durable draft、complete-set publish、previous-set archive 与 Daily Brief read behavior 共同构成同一个 Production consistency contract。

---

## 10. Failure Handling

系统只处理已经实际出现的失败模式，不引入复杂 Workflow Engine。

### Collection

- 单个 Source 失败独立记录；
- 不应删除其他 Source 已成功采集的数据；
- 可单独重新运行 Collection。

### Content Completion

- 单篇 scrape 失败不删除 Raw Article；
- 后续 Stage 1 可以使用已有内容继续判断；
- runtime 保留真实 success / failed / backlog。

### Stage 1

- 单篇最终失败写 `stage1_status = failed`；
- 后续 run 可重试 failed article；
- 已成功 selected / ignored 内容不重复执行；
- batch failure 使用 split fallback 隔离问题输入。

### Stage 2

- Event Groups 是按 `daily_date` 保存的可重建 DB snapshot；
- Stage 2 rerun 可以 replace 当前 Daily 的 Event Group snapshot；
- Stage 2 不直接写最终 `events`；
- runtime failure 不应被 Stage 3 当作业务输入来源；
- invented / modified ID 等 fatal validation 失败时保留 failed runtime diagnostic，且不替换现有 snapshot；跨 Group、同 Group 重复和 missing assignment 是 warning，不阻断可安全的 snapshot replacement。

### Stage 3

- Ranking rerun 可以重新计算 `ai_rank`；
- 不覆盖已人工调整的 `display_rank`；
- Event Ranking 每次成功创建新的 Review snapshot。

### Stage 4

- 每个成功 enrichment 先保存 durable draft；
- draft 未达到 `expected_count` 时 Run 保持 partial，不提交半套正式 Events；
- 只有 complete draft set 才能 atomic publish，并归档同一 Daily 的上一套 published Events；
- Daily Brief 不混合旧 published Events 与当前 Run drafts；
- Stage 4 publication / replacement 必须限定在当前 `daily_date` / `stage4_run` scope；
- 不修改其他 Daily 的历史 Event；
- 失败 run 保留 runtime artifacts 用于诊断。

---

## 11. Idempotency

Daily Workflow 必须能够安全重复执行。

当前核心规则：

```text
Collection
→ source item identity / URL dedup

Pre-Stage1 Dedup
→ duplicate Raw Article loser 标记 ignored，不重复进入 Stage 1

Stage 1
→ only pending / failed
→ processed_contents.raw_article_id unique

Stage 2
→ 当前 `daily_date` 的 Event Group DB snapshot 可重建 / replace
→ Stage 3 从 DB snapshot 读取
→ 不直接创建最终 events

Stage 3
→ ai_rank 可重算
→ display_rank 保护人工结果
→ Event Review 使用新 snapshot 保留历史

Stage 4
→ 以 `daily_date` / `stage4_run` 为 publication scope
→ 同一 Daily 重跑不影响其他 Daily 的历史 Event
```

显式 `DAILY_DATE` retry / backfill 必须继续使用同一 Daily scope。

---

## 12. Runtime Artifacts and Lineage

`runtime/` 用于：

- Debug；
- 可观测性；
- LLM input / output review；
- step metrics；
- upstream/downstream execution references；
- 必要时的数据恢复分析。

它不是：

- Production Database；
- Domain Source of Truth；
- 长期业务数据存储；
- 允许业务逻辑随意读取的“latest state”。

Daily Orchestrator 自身保存：

```text
runtime/daily/<run-id>/run.json
```

记录：

- `daily_date`
- timezone
- base scope
- catch-up scope / relevant step scope
- Collection / Completion / Stage 1 / Stage 2 / Stage 3 / Stage 4 run references
- step status
- duration
- failed step

核心原则：

> runtime artifacts 记录运行关系与诊断信息，但 Production stage 之间的业务输入以对应 DB state / snapshot 为准；不得通过扫描 runtime 目录寻找 “latest state” 来建立业务依赖。

---

## 13. Manual Execution

### Full Workflow

```bash
npm run daily
```

指定 Daily：

```bash
DAILY_DATE=2026-08-25 npm run daily
```

### Individual Steps

```bash
npm run collect:rss
npm run complete:content
npm run process:stage1
npm run process:stage2
npm run process:stage3
npm run process:stage4
```

Standalone 命令主要用于：

- 开发；
- 调试；
- 单步骤验证；
- 局部恢复。

正式 Daily Production 应优先通过 Orchestrator 运行，以保证统一 scope 和明确 lineage。

本文只记录影响 Workflow 语义的关键参数。Provider diagnostics、Evaluation、测试、repair/backfill、数据库命令与全部 CLI 参数统一放到单独的 Operations / Commands 文档维护，避免 README 与 Workflow Spec 同时维护一份易漂移的命令清单。

---

## 14. Workflows Outside the Production Pipeline

以下能力与 Daily Processing 有关联，但**不属于 `npm run daily` 主流程**：

### Human Review

Human Review 位于 Publish 之后：

```text
Production Result
    ↓
Event / Long-form Ranking Review
    ↓
display_rank / feedback
```

它可以修改最终展示排序，并在 Event 被人工移入 Top cutoff 且尚无最终 Event 时按需调用单 Event Stage 4 enrichment。

Long-form Review 的 Daily membership 必须与 Production 一致，按 `processed_contents.daily_date = target dailyDate` 读取和保存，不重新根据 `raw_articles.published_at` 计算 24 小时范围。这样 72 小时 catch-up 后归入当前 Daily 的 Long-form 仍属于同一期 Review。

Human Review 不重跑完整 Daily Pipeline。

### Model Evaluation

Model Evaluation 是人工实验路径：

```text
Frozen Input
    ↓
independent model runs
    ↓
validated outputs
    ↓
Dashboard comparison
```

它：

- 不进入 Cron / Daily Orchestrator；
- 不修改 Production ranking；
- 不写 `processed_contents` / `events` / `event_review_items` / `feedback`；
- Stage 4 当前不参加多模型 Evaluation。

Human Review / Model Evaluation 的详细交互、API 和实验规则应维护在独立文档，而不是继续扩张本文件。
