# X-AI-field Technical Spec (MVP)

## 1. System Architecture

MVP 采用简单的三层架构：

```text
Data Layer → Processing Layer → Presentation Layer
```

MVP 保持单一 Next.js + PostgreSQL 应用，不引入微服务、Queue、Workflow Engine 或复杂 Agent Framework。

### 1.1 Data Layer

核心表：

```text
sources
  ↓
raw_articles
  ↓
processed_contents
    ├── Event Candidate (routing=event)──→ events
    ├── Source Digest
    ├── Long-form
    └── Inspiration

Stage 3 Event Ranking → event_review_items

feedback

evaluation_inputs → evaluation_runs → evaluation_outputs
```

- `sources`：Source List 与采集配置
- `raw_articles`：Collector 标准化后的原始内容
- `processed_contents`：Stage 1 保留的内容；Ignore 不入库
- `events`：Stage 4 生成的最终 Event，一个 Event 可以关联多篇 Event Candidate。
- `event_review_items`：Stage 3 Event Top 50 的历史 Ranking Review snapshot。
- `feedback`：人工 Ranking 修正记录｜False Positive｜False Negative｜Ranking Error
- `evaluation_*`：人工 Model Evaluation 的冻结输入、独立模型运行和 Structured Output；不关联或回写正式业务表。

### 1.2 Processing Layer

```text
Source Collection → Content Completion → Stage 1 → Stage 2 → Stage 3 → Stage 4
```

详细 LLM 逻辑见 `02-ai-workflow-spec.md`，`03-prompt-spec.md`，完整项目流程见 `06-workflow-overview.md`。

其他补充：

#### Source Collection
主要由代码完成，负责：
* 获取当天新增内容；
* 保存 Source Metadata（包括 Category）；
* 尽可能保存原始正文与原始 Metadata；
* URL / GUID 等基础去重；
* 写入 `raw_articles`。

#### Stage 1: Content Understanding & Selection
LLM完成，负责：Understanding, Selection, Routing, Tagging, Entity, Summary, translation
结果写入 `processed_contents`

#### Stage 2 — Merge Events
LLM完成，负责：读取当天 `processed_contents.routing = event` ，并获取对应 title / summary / entities / source / url，一次性提交给 LLM 进行 Merge Events。
本次执行生成临时 `temp_id`
Event Groups 作为当前 workflow 的中间结果，不直接写入 `events` 表。
Stage 2 不生成完整 Event 内容，不执行 Ranking。

#### Stage 3 — Channel Ranking
对不同 Channel 独立执行 Ranking；Event Ranking 只返回最重要的最多 50 个 Event Groups，
最终展示 Top N 仍由 Code 决定。
**Event Ranking**：Input 只须 Event Group 对应的 Candidate title / summary / source 等必要信息
**Output**：排序结果直接写入对应记录。保留：`ai_rank`, `display_rank`。默认：`display_rank = ai_rank`

人工调整只修改 `display_rank`，不覆盖 AI 原始排序。
Inspiration 不需要 AI 排序。

#### Top N Selection
由代码根据产品配置选择最终展示内容，不由 LLM 决定。
- Events: Top 15
- Source Digest: Top N by Category
- Long-form: Top N

#### Stage 4 — Selected Event Enrichment
只处理经过 Stage 3 Ranking 和 Top N Selection 后入选的 Event Groups。
每个 Selected Event Group 独立调用 LLM，可以有限并发执行。

当前常规 Stage 4 会在所有 Selected Event enrichment 成功后以单一 transaction 写入 `events`，
避免半套新旧最终 Event。只有 Stage 4 成功完成的 Event 才写入 `events` 表。

`event_date` 不由 LLM 输出。Application Code 从组成该 Event 的
source articles 的 `raw_articles.published_at` 确定性推导：
1. 忽略 `published_at IS NULL`；
2. 将有效 `published_at` 显式转换到 `Asia/Shanghai`；
3. 取最早的日期部分 `YYYY-MM-DD`；
4. 如果全部 source article 缺失 `published_at`，使用当前 Daily Workflow
   run timestamp 转换到 `Asia/Shanghai` 后的日期作为 fallback。

### 1.3 Presentation Layer

Daily Brief 不单独持久化为 `daily_briefs` 或 `brief_items`。
X-AI-field 当前只提供 Daily Brief API；Daily Brief 页面放在独立的 X-field 项目中。
```text
X-field → HTTP → X-AI-field /api/brief → PostgreSQL
```

API 根据日期实时组合：
```text
Today's Events + Source Digests contents + Long-form contents + Inspiration contents
```
并按照 `display_rank` 返回

后台人工操作包括：
* Review Event / Long-form Ranking；
人工操作同时写入 `feedback`。

---

## 2. Tech Stack

- Runtime: Next.js + TypeScript
- Database: PostgreSQL / Supabase
- ORM: Drizzle ORM
- AI: static per-stage LLM provider configuration + Structured Output
- External Retrieval: optional OpenAI `web_search` in Stage 4
- Scheduling: Cron / Scheduled Job
- Architecture Principle: KISS, YAGNI, LLM-first, Rules only when necessary

---

## 3. Data Model

### 3.1 `sources`
保存 Source List 配置。核心字段：

```text
id, name, category, source_type, url, collection_method,
priority, enabled, event_candidate, source_digest_candidate,
language, availability, notes, created_at, updated_at
```

| Field                     | Type        | Constraint / Notes |
| ------------------------- | ----------- | ------------------ |
| `id`                      | uuid        | Primary Key        |
| `name`                    | text        | NOT NULL           |
| `category`                | text        | NOT NULL           |
| `source_type`             | text        | nullable           |
| `url`                     | text        | NOT NULL           |
| `collection_method`       | text        | NOT NULL           |
| `priority`                | text        | NOT NULL           |
| `enabled`                 | boolean     | NOT NULL           |
| `event_candidate`         | boolean     | NOT NULL           |
| `source_digest_candidate` | boolean     | NOT NULL           |
| `language`                | text        | NOT NULL           |
| `availability`            | text        | nullable           |
| `notes`                   | text        | nullable           |
| `created_at`              | timestamptz | NOT NULL           |
| `updated_at`              | timestamptz | NOT NULL           |

**Category normalization**
Source List 导入时将旧的 Economics / Business / Financial / Market 归一为 `Finance & Economy`，AI 归入 `Technology`。

### 3.2 `raw_articles`
保存标准化原始内容：

```text
id, source_id, source_item_origin_id,
title, url, author, published_at, collected_at,
content_text, image_url, source_tags, metadata,
stage1_status, stage1_processed_at, processing_error
```

| Field                   | Type        | Constraint / Notes          |
| ----------------------- | ----------- | --------------------------- |
| `id`                    | uuid        | Primary Key                 |
| `source_id`             | uuid        | FK → `sources.id`, NOT NULL |
| `source_item_origin_id` | text        | nullable                    |
| `title`                 | text        | NOT NULL                    |
| `url`                   | text        | nullable                    |
| `author`                | text        | nullable                    |
| `published_at`          | timestamptz | nullable                    |
| `collected_at`          | timestamptz | NOT NULL                    |
| `content_text`          | text        | nullable                    |
| `image_url`             | text        | nullable                    |
| `source_tags`           | text[]      | nullable                    |
| `metadata`              | jsonb       | nullable                    |
| `stage1_status`         | text        | NOT NULL                    |
| `stage1_processed_at`   | timestamptz | nullable                    |
| `processing_error`      | text        | nullable                    |

正文不足的处理逻辑属于 `Processing Workflow`：
```text
RSS item
→ normalize
→ content insufficient?
→ fetch article page if possible
→ Stage 1
```

#### source_item_origin_id
保存来源提供的 item identifier，例如：
```text
RSS GUID
Atom ID
Gmail Message ID
```
系统内部关联始终使用 `raw_articles.id`。

基础去重优先使用来源 item ID；无稳定 ID 时使用 URL。

#### metadata
用于保存来源特有但暂时不值得升格为正式字段的信息，例如：
```json
{
  "premium": true,
  "gmail_labels": [],
  "feed_specific_field": "..."
}
```

#### stage1_status
建议值：
```text
pending
selected
ignored
failed
```
暂不使用数据库 CHECK，方便运行后增加状态。

---

### 3.3 `processed_contents`

保存 Stage 1 保留内容：(Ignore 内容不入此表)

```text
id, raw_article_id, routing, category,
tags, entities, entities_zh,
title_zh, summary, summary_zh,
event_id, ai_rank, display_rank,
created_at, updated_at
```

| Field            | Type        | Constraint / Notes             |
| ---------------- | ----------- | ------------------------------ |
| `id`             | uuid        | Primary Key                    |
| `raw_article_id` | uuid        | UNIQUE, FK → `raw_articles.id` |
| `routing`        | text        | NOT NULL + CHECK               |
| `category`       | text        | NOT NULL                       |
| `tags`           | text[]      | nullable                       |
| `entities`       | text[]      | nullable                       |
| `entities_zh`    | text[]      | nullable                       |
| `title_zh`       | text        | nullable                       |
| `summary`        | text        | nullable                       |
| `summary_zh`     | text        | nullable                       |
| `event_id`       | uuid        | nullable, FK → `events.id`     |
| `ai_rank`        | integer     | nullable                       |
| `display_rank`   | integer     | nullable                       |
| `created_at`     | timestamptz | NOT NULL                       |
| `updated_at`     | timestamptz | NOT NULL                       |


**Routing：**
```text
event | digest | long_form | inspiration
```

`ai_rank` 保存 AI 排序；`display_rank` 是页面最终顺序。人工调整只改 `display_rank`。

### 3.4 `events`
保存 Stage 4 最终 Event：

```text
id, event_date,
title, title_zh,
tags, tags_zh,
entities, entities_zh,
summary, summary_zh,
source_perspectives, external_context,
event_review_item_id,
ai_rank, display_rank,
created_at, updated_at
```

| Field                     | Type        | Constraint / Notes |
| ------------------------- | ----------- | ------------------ |
| `id`                      | uuid        | Primary Key        |
| `event_date`              | date        | NOT NULL           |
| `title`                   | text        | NOT NULL           |
| `title_zh`                | text        | NOT NULL           |
| `tags`                    | text[]      | nullable           |
| `tags_zh`                 | text[]      | nullable           |
| `entities`                | text[]      | nullable           |
| `entities_zh`             | text[]      | nullable           |
| `summary`                 | text        | NOT NULL           |
| `summary_zh`              | text        | NOT NULL           |
| `source_perspectives`     | jsonb       | NOT NULL           |
| `external_context`        | jsonb       | nullable           |
| `event_review_item_id`    | uuid        | nullable，FK → `event_review_items.id`；新 Event 的明确 Review 关联 |
| `ai_rank`                 | integer     | nullable           |
| `display_rank`            | integer     | nullable           |
| `created_at`              | timestamptz | NOT NULL           |
| `updated_at`              | timestamptz | NOT NULL           |

一个 Event 可关联多条 `processed_contents`；MVP 假设一篇 Event Candidate 只属于一个主要 Event，因此使用 `processed_contents.event_id`，不建立 `event_articles`。

`event_date` 由 Code 从组成 Event 的 source articles 中最早有效 `published_at` 推导（Asia/Shanghai）；全部缺失时 fallback 到 workflow run 日期。

`external_context`：未发生真实 Web Search 时为 `NULL`；发生搜索时保存真实 provenance URLs 和简短 summary。

### 3.5 `event_review_items`

保存 Stage 3 每次成功 Event Ranking 返回的完整 Top 50（不足 50 时保存全部）。
每次运行创建新的 UUID `review_run_id` snapshot，历史 snapshot 保留；Review 默认读取指定
`daily_date` 最新 snapshot。该表不是新的 Event Domain Model，不复制 Stage 4 完整内容。

| Field                | Type        | Constraint / Notes                     |
| -------------------- | ----------- | -------------------------------------- |
| `id`                 | uuid        | Primary Key                            |
| `review_run_id`      | uuid        | NOT NULL，标识一次 snapshot            |
| `daily_date`         | date        | NOT NULL                               |
| `event_temp_id`      | text        | NOT NULL，当前 Stage 3 run 内临时 ID   |
| `event_hint`         | text        | NOT NULL                               |
| `ai_rank`            | integer     | NOT NULL，人工不可覆盖                 |
| `display_rank`       | integer     | NOT NULL，Review 当前排序              |
| `member_content_ids` | uuid[]      | NOT NULL，关联 `processed_contents.id` |
| `created_at`         | timestamptz | NOT NULL                               |
| `updated_at`         | timestamptz | NOT NULL                               |

### 3.6 `feedback`
当前保留简单结构，结构未来根据实际 Feedback / Eval 需求再调整。

| Field           | Type        | Constraint / Notes        |
| --------------- | ----------- | ------------------------- |
| `id`            | uuid        | Primary Key               |
| `target_type`   | text        | event_review_item / processed_content |
| `target_id`     | uuid        | NOT NULL                  |
| `feedback_type` | text        | NOT NULL                  |
| `before_value`  | jsonb       | nullable                  |
| `after_value`   | jsonb       | nullable                  |
| `note`          | text        | nullable                  |
| `created_at`    | timestamptz | NOT NULL                  |

初始 feedback 类型：
```text
ranking_error
false_positive
false_negative
```

人工修改 Ranking 时：
```text
ai_rank 保持不变
display_rank 更新
feedback 写入修改记录
```

### 3.7 `evaluation_inputs` / `evaluation_runs` / `evaluation_outputs`

Model Evaluation 使用三张独立表保存人工实验：

```text
evaluation_inputs
  id, daily_date, stage, input_json, input_hash, created_at
  ↓
evaluation_runs
  id, evaluation_input_id, provider, model, prompt_version, status, error,
  started_at, completed_at, duration_ms, input_tokens, output_tokens, created_at
  ↓
evaluation_outputs
  id, evaluation_run_id, item_key, output_json, created_at
```

- `evaluation_inputs.input_json` 是一次评测开始时构造的完整 Frozen Stage Input；同一次
  Evaluation 的所有 Model Run 必须引用同一个 input ID。`input_hash` 是稳定 JSON + SHA-256，
  用于人工核对输入一致性，不作为复杂内容寻址或缓存机制。
- `stage` 当前仅支持 `stage1`、`stage2`、`stage3_event`、`stage3_digest`、
  `stage3_long_form`。Digest 的每个 Category output 使用 `item_key = category`。
- Run status 为 `running` / `success` / `failed`；一个模型失败不影响其他 Run。Provider 未提供
  token metadata 时 token 字段为 NULL。
- `evaluation_outputs.output_json` 只保存已通过当前 Stage contract 校验的 Structured Output。
  删除一个 Run 会 cascade 删除其 outputs；删除 Run 不会删除 shared input，也不会 cascade 到任何 Production Table。

Evaluation 只允许 CLI 等人工入口触发，不加入 `npm run daily`、Cron、Scheduler 或正式
Orchestrator。它绝不写 `processed_contents`、`events`、`event_review_items`、`feedback`、
`ai_rank` 或 `display_rank`；Stage 4 不参加多模型 Evaluation。

### 3.8 Initial Indexes

MVP 只建立明确需要的索引：
```text
raw_articles(source_id)
raw_articles(published_at)
raw_articles(collected_at)
raw_articles(stage1_status)

processed_contents(raw_article_id) UNIQUE
processed_contents(routing)
processed_contents(event_id)
processed_contents(display_rank)

events(event_date)
events(display_rank)
events(event_review_item_id) UNIQUE

event_review_items(daily_date)
event_review_items(review_run_id, event_temp_id) UNIQUE
event_review_items(review_run_id, ai_rank) UNIQUE
event_review_items(review_run_id, display_rank) UNIQUE

evaluation_inputs(daily_date, stage)
evaluation_runs(evaluation_input_id)
evaluation_outputs(evaluation_run_id)
```

Source Digest 查询后续如有性能需求，再增加：
```text
source_id + date
```
等组合索引。不要提前优化。

---

## 4. Processing Workflow

### 4.1 Daily Workflow

每天执行一次完整 Daily Workflow。
触发时间：
```text
09:00 Asia/Shanghai
```

每个 Daily 使用固定的 `raw_articles.published_at` 半开区间，Daily 日期对应区间结束的
09:00 boundary。例如：

```text
Daily 2026-08-25
= 2026-08-24 09:00 <= published_at < 2026-08-25 09:00 (Asia/Shanghai)
```

Orchestrator 启动时只计算一次 scope；默认选择最近一个已经结束的 09:00 boundary。
`DAILY_DATE=YYYY-MM-DD npm run daily` 可显式选择相同 scope 进行 retry / backfill。
`published_at` 决定新闻属于哪一期 Daily；`collected_at` 只记录系统何时采集。
因此 late retry / backfill 不改变 Daily membership，`published_at IS NULL` 的文章不进入任何 Daily scope。
Orchestrator 通过 `DAILY_PUBLISHED_SCOPE_START_AT` / `DAILY_PUBLISHED_SCOPE_END_AT`
传递范围；旧 `DAILY_SCOPE_START_AT` / `DAILY_SCOPE_END_AT` 仅保留为部署兼容 alias。

只设置一个 Cron Trigger。
```text
Cron 09:00
    ↓
Collection
    ↓
Content Completion
    ↓
Stage 1: Content Understanding & Selection
    ↓
Stage 2: Merge Events
    ↓
Stage 3: Channel Ranking
    ↓
Stage 4: Selected Event Enrichment
    ↓
Publish-ready data
```
后续 任务 由前一个 任务 成功完成后主动触发，不使用固定时间分别调度。

### 4.2 Collection

根据 `sources.collection_method` 使用不同 Collector Adapter。
```js
collectRSS(source)
collectEmail(source)
collectWeb(source)
```
不同 Collector 最终统一输出标准化 `Raw Article`。

#### RSS Collector
当前正式实现
```text
Source → RSS fetch → normalize → deduplicate → raw_articles
```

#### Email Collector

Newsletter Email 不假设“一封邮件等于一篇文章”。
允许：
```text
1 Email
   ↓
1..N Raw Articles
```
不同 Newsletter 可通过轻量 Adapter 处理。
MVP 不建立通用复杂 Newsletter Parser。

#### Web Collector

仅用于明确没有 RSS / Email，但仍需要采集的来源。
Web Collector 应尽量输出与 RSS Collector 相同的标准 Raw Article 结构。

### 4.3 Content Completion
正文不足时执行
```text
raw_articles → need completion? → article extraction → update content_text
```

如果：
```text
content_text is null / empty
```
且存在有效 `url`：
```text
try fetch article page
    ↓
extract readable text
    ↓
update raw_articles.content_text
```
该步骤主要用于 Nature 等只提供标题和链接的 Feed。

如果补抓仍失败：
* Raw Article 保留；
* Stage 1 根据现有 Title / Metadata 判断是否可以继续处理；
* 必要时记录处理错误或低内容状态。

每次 `npm run complete:content` 写入独立的
`runtime/content-completion/<timestamp>/run.json`。其中：

- `candidate_count`：执行开始时符合相同 eligibility 条件的总数，不受总 LIMIT 和 per-source limit 影响；
- `selected_count`：应用 per-source limit 和总 LIMIT 后实际进入本次处理的数量；
- `success_count` / `failed_count` / `skipped_count`：本次所选内容的真实处理结果；
- `remaining_count`：执行结束后按相同 eligibility 条件重新查询的 backlog；
- `duration_ms`、`limit`、`per_source_limit`：本次实际运行配置和时长。

运行失败时 artifact 保留已经获得的真实 metrics；未知字段为 `null`，不估算。

### 4.4 Deduplication
区分两类重复。

#### Exact Duplicate

同一来源中的相同内容，例如：
* 相同 `source_item_origin_id`
* 相同 URL
* 同一 Feed 被重复抓取
应在 Collection 阶段去重。

优先使用：
```text
source_id + source_item_origin_id
```
如来源没有 item id，则使用 URL 等稳定字段辅助判断。
Exact Duplicate 不再次插入 `raw_articles`。

#### Same Event Across Different Sources
例如：
```text
Reuters: Fed ...
Bloomberg: Fed ...
FT: Fed ...
```
保留全部内容，并在 Stage 2 进行 Merge Events。

### 4.5 Stage 1

只处理最近 workflow window 内 `stage1_status IN ('pending', 'failed')` 的 Raw Articles。

Daily Workflow 使用本次 Daily 固定的 `raw_articles.published_at` scope；
单独运行 Stage 1 时使用基于 `published_at` 的最近 24 小时默认窗口。

Stage 1 对普通文章使用小型 micro-batch，但每篇 Raw Article 仍独立判断；较大的 input 可以单独处理。
```text
Raw Article → LLM → Ignore / Event / Digest / Long-form / Inspiration
```

Ignore: `raw_articles.stage1_status = ignored` 不创建 `processed_contents`
Selected: `raw_articles.stage1_status = selected` 创建对应 `processed_contents`
Failed：
```js
raw_articles.stage1_status = failed
processing_error = ...
```

### 4.6 Stage 2

Stage 1 全部可处理内容完成后触发 Stage 2。
读取当前 workflow 的 Event Candidates；生成轻量 Event Groups。
默认时间窗口与 Stage 1 一致，为最近 24 小时 published 内容。
在 Daily Workflow 中改用本次 Daily 固定的 `raw_articles.published_at` scope；单独运行
Stage 2 时继续使用基于 `published_at` 的最近 24 小时默认窗口。

```text
Event Candidates
  → 构造完整 Stage2Input
  → 单次 DeepSeek V4 Pro long-context 调用
  → Stage2Output
  → Event Groups
```

Stage 2 不进行 batch merge 或 reconciliation，也不写 `events`。
Input / Output、temp ID mapping 和 run metadata 保存到 `runtime/stage2/`。

Stage 2 assignment validation 当前处于临时 diagnostic 模式：记录 missing / duplicate /
invented IDs，但暂时不阻断 runtime output。这是已知限制，后续单独决定何时恢复 blocking validation。

### 4.7 Stage 3

Stage 2 完成后主动触发 Stage 3。
Stage 3 分阶段执行。

Daily Workflow 中 Digest / Long-form 候选使用与 Stage 1/2 相同的固定 `raw_articles.published_at` scope；
单独运行 Stage 3 时继续使用基于 `published_at` 的最近 24 小时默认窗口。
Event Groups 读取 Orchestrator 明确传入的本次 Stage 2 runtime run。

```text
Event Groups
  ↓
Event Ranking
  ↓
DB Event Top 50 Review Snapshot
  ↓
Code Top N
  ↓
Cross-channel exact dedup → 排除已经被 Selected Events 覆盖的 exact duplicate
  ↓
Digest global exact dedup
  ↓
Science publication enrichment
  ↓
Digest Ranking by Category + Long-form Ranking
```

- Exact dedup 仅处理确定的同一原文，使用 normalized URL，不做语义去重。
- Digest / Long-form rank 写入 `processed_contents.ai_rank`。
- `display_rank` 默认跟随 AI；若已人工修改则普通重跑不覆盖。
- Event 完整 Top 50 rank 先写入新的 DB Review snapshot；Top 15 继续由 Stage 4 创建最终 Event 时写入 `events`。

Stage 3 完成后：
- Source Digest / Long-form:
  Stage 3 结果直接写入 `processed_contents.ai_rank`。
  首次排序时设置 `display_rank = ai_rank`。

- Event Groups:
  完整 Event Ranking（最多 50）创建新的 `event_review_items` snapshot。
  Stage 4 创建最终 Event 时，将对应 `ai_rank` / `display_rank`
  与 `event_review_item_id` 一并写入 `events`。

人工修改只改变 `display_rank`
Inspiration 不需要 AI Ranking。

### 4.8 Stage 4

Stage 3 完成后主动触发 Stage 4。
只处理 Selected Event Groups，每个 Event 独立调用 LLM。

```text
Selected Event Group
  ↓
Event Enrichment
  ├─ existing sources sufficient → no search
  └─ context materially needed → optional Web Search
  ↓
Event persistence
```

- Web Search 使用 Responses API `web_search` + `tool_choice: auto`。
- 是否真实搜索 由 Application Code 从 tool usage 判断，不完全信任模型自报。
- 所有 Event enrichment 成功后，再使用单一 transaction 持久化当前 workflow-derived Events，避免半套新旧数据。
- Stage 4 persistence 对不同 `event_date` 采用 append 语义；重跑时只允许 rebuild 当前输出涉及的 `event_date` scope。
- 删除上一轮派生 Events 前必须校验 cleanup candidates 的 `event_date` 全部属于当前 rebuild scope；如果包含其他日期，应直接失败而不是静默删除。

Stage 4 完成后：
1. 写入 `events`
2. 将组成该 Event 的 Event Candidates 回写 `processed_contents.event_id`
3. 保存最终 Event rank / display_rank
不创建 `event_articles`。

### 4.9 Human Review v1

Human Review 位于 Publish 之后，不阻塞 Daily Workflow：

```text
AI Pipeline → Publish → Event / Long-form Ranking Review
```

- Event Review 默认读取指定 `daily_date` 最新 `event_review_items.review_run_id`；
- Long-form Review 读取同一 `raw_articles.published_at` Daily scope 内所有 `ai_rank IS NOT NULL` 内容；
- drag / Move to N 只修改前端 local state，`Save Changes` 才提交完整顺序；
- Save 在单一 transaction 内校验 scope、完整 ID 集合、重复 ID 和连续 rank，更新全部受影响
  `display_rank`，仅为 `touchedIds` 中最终 rank 改变的 Item 写 feedback；
- Event cutoff 为 15，Long-form cutoff 为 10；跨入 cutoff 为 `false_negative`，跨出为
  `false_positive`，未跨越为 `ranking_error`；
- Event Review 保存会同步该 snapshot 的 `events.display_rank`，`/api/brief` 仍只读取 `events`；
  被移出 Top 15 的 Event 保留 enrichment，之后再次进入时可复用；
- 最终 Top 15 中没有对应最终 Event 的 Item 会在 transaction 外按需执行单个 Stage 4 enrichment，
  成功后才在短 transaction 内创建 Event、同步所有已有 Event rank、更新 Review rank 和写 feedback；
  enrichment 失败则不提交本次排序；
- 正常 Stage 4 和 Review 按需 enrichment 复用相同 Prompt、LLM、Structured Output validation 与
  Event persistence；不重跑完整 Stage 4 或 Daily Workflow。

Classification Editing 与 Model Evaluation 不在 v1 范围。

内部 API：

```text
GET   /api/review/events?date=YYYY-MM-DD
PATCH /api/review/events/ranking
GET   /api/review/long-form?date=YYYY-MM-DD
PATCH /api/review/long-form/ranking
```

### 4.10 Failure Handling
只处理明确的常见失败，不建立复杂 Workflow Engine。

+ **Collector**: Source 独立失败, 记录错误, 重试该 Source, 不影响其他 Source Collection
+ **Stage 1**: 当前 Raw Article 标记 `failed`, 可独立重试, 不重跑已成功文章
+ **Stage 2**: 当前 Raw Article 标记 `failed`, 可独立重试, 不重跑已成功文章
+ **Stage 3**: 只重跑失败的 Channel / Category
+ **Stage 4**: 重试当前任务

### 4.10.1 Manual Model Evaluation

人工执行 `npm run eval:stage1`、`eval:stage2`、`eval:stage3:event`、
`eval:stage3:digest` 或 `eval:stage3:long-form` 时，Evaluation Service 先从 Production DB
或对应成功 Stage 3 runtime 构造一次 Frozen Input，随后才创建多个 Model Run。Stage 1 保留
当前 micro-batch 输入边界；Stage 2 使用该 Daily 的已选 Event Candidates；Stage 3 使用指定
日期最近一次成功正式 Stage 3 runtime 中已经去重后的 Event、Digest 分类和 Long-form 输入。

所有模型读取同一 `evaluation_input_id`，但每个 Run 独立保存 success / failed、耗时、可用 token
和输出。Evaluation 不启动或重跑任何正式 Job，不进入 Daily lineage，也不创建新的 runtime artifact。

### 4.11 Idempotency 幂等性

Daily Workflow 必须可以安全重复执行。

- Collection：item ID / URL 去重
- Stage 1：只处理 `stage1_status IN ('pending', 'failed')`；`processed_contents.raw_article_id` UNIQUE
- Stage 2：只生成当前 Workflow 使用的 Event Groups，不直接持久化 events.runtime Event Groups 可安全重算
- Stage 3：覆盖 `ai_rank`，保护人工 `display_rank`
- Stage 4：根据当前输出的 `event_date` scope，从历史 `runtime/stage4/.../persistence.json` / `persistence-plan.json` 中识别同一日期 scope 的上一轮派生 Events，unlink → delete → rebuild → relink；不同 `event_date` 的历史 Events 必须保留。

---

## 5. Daily Brief API

```text
GET /api/brief?date=YYYY-MM-DD
```

Daily Date 由 Raw Article 的新闻发布时间 scope 决定，而不是采集时间或任一结果记录的
`created_at`：

```text
Daily YYYY-MM-DD
= 前一天 09:00 <= raw_articles.published_at < 当天 09:00 (Asia/Shanghai)
```

- Digest / Long-form / Inspiration 通过 `processed_contents.raw_article_id → raw_articles`
  按该 `published_at` scope 归属。
- Event 通过 `events ← processed_contents.event_id ← raw_articles` 归属；只要至少一条
  `routing = event` 的 Candidate 属于 scope 即归入该 Daily，且一个 Event 只返回一次。
- `/api/brief` 不使用 `processed_contents.created_at` 或 `events.created_at` 判断 Daily 归属。
- `collected_at` 只表示系统采集时间；`published_at IS NULL` 的 Raw Article 不归入任何 Daily。
- retry / backfill 继续使用同一 `published_at` scope，不改变 Daily membership。

返回：
- `events` — Top 10
- `digests` — 按 Category 分组，返回全部 ranked contents
- `long_form` — Top 10
- `inspiration`
- `meta`

Original links：
- Event → API 通过 `processed_contents → raw_articles` 组装 `sources[]`
- Digest / Long-form / Inspiration → `url`

API 不创建 `daily_briefs` / `brief_items` snapshot；当前是实时 composition。

CORS 使用环境变量配置允许的 X-field origin。

---

## 6. LLM Integration

Runtime Prompt 位于 `src/prompts/`，Prompt contract 位于 `03-prompt-spec.md`。

```text
LLM Response → Structured Output → Schema Validation → Application Logic
```

Prompt 发生影响行为的变化时更新版本号，并在 runtime log 中记录版本。
Prompt 文件随项目代码通过 Git 进行版本管理。
Prompt 行为以 `03-prompt-spec.md` 为 Source of Truth；runtime prompt 与 Structured Output contract 必须保持同步。

正式 Daily Workflow 使用静态 per-stage provider 配置：
```text
Stage 1 → OpenAI
Stage 2 → DeepSeek
Stage 3 → OpenAI
Stage 4 → OpenAI
```
对应环境变量为 `STAGE1_LLM_PROVIDER` 至 `STAGE4_LLM_PROVIDER`。这不是根据输入动态选择模型。
`LLM_PROVIDER` / `LLM_MODEL` 只保留给 standalone provider diagnostics 或显式通用调用；
正式 Stage 1–4 commands 不依赖它们。
Shared compatibility layer 支持 OpenAI / DeepSeek / Kimi；Kimi 当前不用于正式 Daily Workflow。

OpenAI 继续使用 Responses API；DeepSeek / Kimi 使用各自的 OpenAI-compatible Chat Completions API。
所有 provider 输出原则上都必须经过相同的 Application Schema Validation 后才能使用或持久化。
Stage 2 当前处于临时 diagnostic 模式，严格 output / assignment 问题会被记录但不阻断 runtime output；
该例外是已知限制，不改变 Prompt Spec 定义的长期 contract。
OpenAI / Kimi 请求 provider-side JSON Schema Structured Output；
DeepSeek 当前使用官方 JSON Object mode 并在 instruction 中提供 schema，返回结果仍须通过相同的严格 Application validation。

### Model Selection:
先使用一个能力足够的通用模型。
除非能力不足：
* 根据任务上下文长度和输出质量选择模型
暂不做：
* Cheap / Expensive Model 分层；
模型调用应与业务逻辑解耦，未来可以替换模型而不修改 Workflow。

### External Context Retrieval
Stage 4 uses the OpenAI Responses API `web_search` tool as an optional built-in tool.
The request provides:
```json
{
  "tools": [{ "type": "web_search" }],
  "tool_choice": "auto"
}
```

The model may request additional Web Search when existing Event Candidates are insufficient to understand an important event.
Conceptually:
```text
Event Candidates
      ↓
Stage 4 reasoning
      ↓
Need more context?
   ↙       ↘
 no        yes
 ↓          ↓
merge    Web Search
            ↓
        additional context
            ↓
        continue merge
```
Search 获得的信息作为补充 Context，不替代原始 Source。
必要的信息保存到 `events.external_context`。

Application Code 不完全信任模型在 Structured Output 中自行声明的
`external_context.performed` / `external_context.sources`。
实际是否搜索、以及真实 source URL provenance，来自 OpenAI Responses API
response output items 中的 `web_search_call` 和 URL citation metadata。

Persistence:
- 如果没有真实 Web Search call：`events.external_context = null`
- 如果发生真实 Web Search call：
  `events.external_context = { sources: [...real source urls], summary: "..." }`

---

## 7. Project Structure & Engineering Rules

### 7.1 Project Structure

当前目录保持平铺结构。

```text
X-AI-field/
├── src/
│   ├── app/
│   │   └── daily-brief/                 # Daily Brief HTTP API
│   ├── collectors/
│   │   └── rss.ts                     # RSS collection / normalization
│   ├── db/
│   │   ├── index.ts                   # PostgreSQL connection
│   │   └── schema.ts                  # Drizzle schema
│   ├── lib/
│   │   ├── brief-date.ts              # Brief date / timezone helpers
│   │   └── daily-brief.ts             # API composition queries
│   ├── processing/
│   │   ├── content-completion.ts       # Stage 0: Sparse content completion
│   │   ├── event-date.ts               # Deterministic event_date
│   │   ├── llm-client.ts               # Shared provider selection / LLM client
│   │   ├── science-publication.ts      # Science publication enrichment
│   │   ├── stage1-*.ts                 # Stage 1 contract / LLM / job
│   │   ├── stage2-*.ts                 # Stage 2 candidates / contract / LLM / job / runtime
│   │   ├── stage3-*.ts                 # Stage 3 ranking / dedup / persistence
│   │   └── stage4-*.ts                 # Stage 4 contract / LLM / job / persistence
│   └── prompts/
│       ├── stage1-content-understanding.ts
│       ├── stage2-event-merge.ts
│       ├── stage3-event-ranking.ts
│       ├── stage3-digest-ranking.ts
│       ├── stage3-long-form-ranking.ts
│       └── stage4-event-enrichment.ts
│
├── scripts/                             # CLI entry points / focused tests
├── drizzle/                             # Database migrations
├── runtime/                             # Gitignored operational/debug artifacts
├── docs/
│   ├── 01-product-spec.md
│   ├── 02-ai-workflow-spec.md
│   ├── 03-prompt-spec.md
│   ├── 04-technical-spec.md
│   ├── 05-source-list.md
│   └── 06-workflow-overview.md
├── AGENTS.md
└── README.md
```

### 7.2 Module Boundaries

保持各模块职责单一：
```text
collectors  → 外部数据采集 / 标准化
processing  → Stage 1–4 workflow + persistence
prompts     → Runtime LLM prompts
db          → Schema / DB connection
lib         → API composition / shared application helpers
app.        → HTTP presentation layer
runtime     → Debug / operational artifacts，不是数据库
```

### 7.3 Engineering Principles

- KISS / YAGNI / LLM-first
- Secrets / environment config / Model / Prompt version 不硬编码
- Structured Output 必须验证后再使用
- 优先使用成熟 Library，不重复实现基础能力
- 不静默忽略错误
- 不为未出现的问题提前引入基础设施或抽象层
- 保持模块职责清晰

### 7.4 Error Handling

* 错误应在最接近发生位置处理和记录。
* 单个 Source、Article 或 LLM Request 的失败不应导致无关任务的数据丢失。
* 允许失败任务独立重试。
* 不要静默忽略错误。

### 7.5 Testing

保留影响 Pipeline 正确性的测试：
- DB constraints / migrations
- Structured Output validation
- Ranking / display_rank semantics
- Stage 4 rebuild / rollback
- deterministic event_date

---

## 8. Daily Workflow Orchestrator

当前已实现统一 Orchestrator，按顺序调用现有命令：

```bash
npm run daily
```

Orchestrator 固定本次 Daily scope，并将本次 Stage 2 run 明确传给 Stage 3、本次 Stage 3
run 明确传给 Stage 4，避免 Daily 依赖全局 latest runtime。显式 retry / backfill：

```bash
DAILY_DATE=2026-08-25 npm run daily
```

完成 Stage 4 后，`/api/brief` 可直接读取 publish-ready 数据。

未来：
```text
09:00 Asia/Shanghai Cron → Daily Workflow Orchestrator
```

---

## 9. Runtime Artifacts

`runtime/` 保存 Stage 2–4 的真实 input / output / mapping / run metadata，用于 Debug、Review、重跑边界。

`runtime/daily/.../run.json` 额外记录 `daily_date`、`timezone`、
`scope_start_at`、`scope_end_at`，以及本次 `content_completion_run`、`stage2_run`、
`stage3_run`、`stage4_run`，
同时保留各 step status / duration / failed_step。

它不是应用数据库，也不是长期业务 Source of Truth，并保持 Git ignored。

Stage 4 rebuild 使用 runtime artifacts 识别同一 `event_date` scope 的上一轮派生 Events。runtime artifacts 也用于 Debug、Review 和必要时的数据恢复分析；不要把它作为 Stage 间传递数据的正式接口。

Internal Dashboard 按 Asia/Shanghai 运行日期读取每天最新一次 Content Completion runtime，
展示 Completion success/selected、remaining backlog、duration，并在 Date Details 展示完整计数。
缺少 runtime 时显示 `N/A`，不从当前数据库状态反推历史指标。
