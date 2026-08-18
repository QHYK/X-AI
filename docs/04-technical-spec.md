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

feedback
```

- `sources`：Source List 与采集配置
- `raw_articles`：Collector 标准化后的原始内容
- `processed_contents`：Stage 1 保留的内容；Ignore 不入库
- `events`：Stage 4 生成的最终 Event，一个 Event 可以关联多篇 Event Candidate。
- `feedback`：未来人工修正记录｜False Positive｜False Negative｜Ranking Error｜Classification Error

### 1.2 Processing Layer

```text
Source Collection → Content Completion → Stage 1 → Stage 2 → Stage 3 → Exact Dedup → Stage 3 → Stage 4
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
对不同 Channel 独立执行 Ranking，不决定最终展示数量。
**Event Ranking**：Input 只须 Event Group 对应的 Candidate title / summary / source 等必要信息
**Output**：排序结果直接写入对应记录。保留：`ai_rank`, `display_rank`。默认：`display_rank = ai_rank`

人工调整只修改 `display_rank`，不覆盖 AI 原始排序。
Inspiration 不需要 AI 排序。

#### Top N Selection
由代码根据产品配置选择最终展示内容，不由 LLM 决定。
- Events: Top 8–12
- Source Digest: Top N by Category
- Long-form: Top N

#### Stage 4 — Selected Event Enrichment
只处理经过 Stage 3 Ranking 和 Top N Selection 后入选的 Event Groups。
每个 Selected Event Group 独立调用 LLM，可以有限并发执行。

单个 Event 失败不应影响其他 Event 的处理。
只有 Stage 4 成功完成的 Event 才写入 `events` 表。

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
* 删除 / 恢复内容；
* 修改分类；
* 调整 `display_rank`；
* 补充遗漏内容。
人工操作同时写入 `feedback`。

---

## 2. Tech Stack

- Runtime: Next.js + TypeScript
- Database: PostgreSQL / Supabase
- ORM: Drizzle ORM
- AI: OpenAI Responses API + Structured Output
- External Retrieval: optional `web_search` in Stage 4
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
| `ai_rank`                 | integer     | nullable           |
| `display_rank`            | integer     | nullable           |
| `created_at`              | timestamptz | NOT NULL           |
| `updated_at`              | timestamptz | NOT NULL           |

一个 Event 可关联多条 `processed_contents`；MVP 假设一篇 Event Candidate 只属于一个主要 Event，因此使用 `processed_contents.event_id`，不建立 `event_articles`。

`event_date` 由 Code 从组成 Event 的 source articles 中最早有效 `published_at` 推导（Asia/Shanghai）；全部缺失时 fallback 到 workflow run 日期。

`external_context`：未发生真实 Web Search 时为 `NULL`；发生搜索时保存真实 provenance URLs 和简短 summary。

### 3.5 `feedback`
当前保留简单结构，结构未来根据实际 Feedback / Eval 需求再调整。

| Field           | Type        | Constraint / Notes        |
| --------------- | ----------- | ------------------------- |
| `id`            | uuid        | Primary Key               |
| `target_type`   | text        | event / processed_content |
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
classification_error
```

人工修改 Ranking 时：
```text
ai_rank 保持不变
display_rank 更新
feedback 写入修改记录
```

### 3.6 Initial Indexes

MVP 只建立明确需要的索引：
```text
raw_articles(source_id)
raw_articles(published_at)
raw_articles(stage1_status)

processed_contents(raw_article_id) UNIQUE
processed_contents(routing)
processed_contents(event_id)
processed_contents(display_rank)

events(event_date)
events(display_rank)
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

只设置一个 Cron Trigger。
```text
Cron 09:00
    ↓
Collection
    ↓
Stage 1: Content Understanding & Selection
    ↓
Content Completion
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

只处理最近 workflow window 内 `stage1_status = pending` 的 Raw Articles。

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
默认时间窗口与 Stage 1 一致，为最近 24 小时 collected 内容。

```text
Event Candidates → LLM Merge → Event Groups
```

Stage 2 不写 `events`。Input / Output 和 temp ID mapping 保存到 `runtime/stage2/`。

### 4.7 Stage 3

Stage 2 完成后主动触发 Stage 3。
Stage 3 分阶段执行。

```text
Event Groups
  ↓
Event Ranking
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
- Event rank 保留到 Stage 4 创建最终 Event 时写入 `events`。

Stage 3 完成后：
- Source Digest / Long-form:
  Stage 3 结果直接写入 `processed_contents.ai_rank`。
  首次排序时设置 `display_rank = ai_rank`。

- Event Groups:
  Ranking 作为当前 Workflow 的中间结果保留。
  Stage 4 创建最终 Event 时，将对应 `ai_rank` / `display_rank`
  一并写入 `events`。

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
- 所有 Event enrichment 成功后，再使用单一 transaction rebuild 当前 workflow-derived Events，避免半套新旧数据。

Stage 4 完成后：
1. 写入 `events`
2. 将组成该 Event 的 Event Candidates 回写 `processed_contents.event_id`
3. 保存最终 Event rank / display_rank
不创建 `event_articles`。

### 4.9 Failure Handling
只处理明确的常见失败，不建立复杂 Workflow Engine。

+ **Collector**: Source 独立失败, 记录错误, 重试该 Source, 不影响其他 Source Collection
+ **Stage 1**: 当前 Raw Article 标记 `failed`, 可独立重试, 不重跑已成功文章
+ **Stage 2**: 当前 Raw Article 标记 `failed`, 可独立重试, 不重跑已成功文章
+ **Stage 3**: 只重跑失败的 Channel / Category
+ **Stage 4**: 重试当前任务

### 4.10 Idempotency 幂等性

Daily Workflow 必须可以安全重复执行。

- Collection：item ID / URL 去重
- Stage 1：只处理 `stage1_status = pending`；`processed_contents.raw_article_id` UNIQUE
- Stage 2：只生成当前 Workflow 使用的 Event Groups，不直接持久化 events.runtime Event Groups 可安全重算
- Stage 3：覆盖 `ai_rank`，保护人工 `display_rank`
- Stage 4：通过最近成功 `runtime/stage4/.../persistence.json` 识别上一轮派生 Events，unlink → delete → rebuild → relink

---

## 5. Daily Brief API

```text
GET /api/brief?date=YYYY-MM-DD
```

MVP 使用 `created_at`（Asia/Shanghai）作为 Brief 日期归属依据。

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
当前版本以 runtime prompt 文件为准。

### Model Selection: 
先使用一个能力足够的通用模型。
暂不做：
* 多模型 Routing；
* Cheap / Expensive Model 分层；
* 根据任务动态选择模型。
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
实际是否搜索、以及真实 source URL provenance，来自 Responses API
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
│   │   └── api/brief/                 # Daily Brief HTTP API
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
│   │   ├── openai-client.ts            # Shared LLM client
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

完成 Stage 4 后，`/api/brief` 可直接读取 publish-ready 数据。

未来：
```text
09:00 Asia/Shanghai Cron → Daily Workflow Orchestrator
```

---

## 9. Runtime Artifacts

`runtime/` 保存 Stage 2–4 的真实 input / output / mapping / run metadata，用于 Debug、Review、重跑边界。

它不是应用数据库，也不是长期业务 Source of Truth，并保持 Git ignored。

Stage 4 rebuild 当前依赖最近一次成功 run 的 `persistence.json`，因此不要随意删除最新成功的 Stage 4 runtime 目录。