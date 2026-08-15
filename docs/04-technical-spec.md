# X-AI-field Technical Spec (MVP)

## 1. System Architecture

MVP 采用简单的三层架构：
```text
Data Layer
↓
Processing Layer
↓
Presentation Layer
```
优先保持架构简单，不引入微服务、消息队列、复杂 Agent Framework 等当前没有明确需求的基础设施。

### 1.1 Data Layer
所有核心数据统一存储在 PostgreSQL。
核心数据对象：
```text
sources
    ↓
raw_articles
    ↓
processed_contents
    ├── Event Candidate ──→ events
    ├── Source Digest
    ├── Long-form
    └── Inspiration

feedback
```

#### `sources`
保存所有已配置的信息来源及采集配置。

#### `raw_articles`
保存 Collector 获取的原始数据。

#### `processed_contents`
保存经过 Stage 1 `Content Understanding & Selection` 后保留的内容。

Routing 包括：
```text
Event
Digest
Long-form
Inspiration
```
Ignore 内容不创建 `processed_contents` 记录。

Event Candidate 在经过 Stage 2 合并后，通过 `event_id` 关联至对应 Event。

#### `events`
保存 Stage 2 `Event Understanding & Merge` 产生的 Event。
一个 Event 可以关联多篇 Event Candidate。

MVP 假设：
> 一篇 Event Candidate 只属于一个主要 Event。

#### `feedback`
保存人工对 AI 结果的修改，例如：

* False Positive
* False Negative
* Ranking Error
* Classification Error

AI 原始结果应保留，人工修改后的展示结果单独记录，以便后续 Eval 和 Prompt 优化。

---

### 1.2 Processing Layer

每日 Workflow：

```text
Source Collection
        ↓
Raw Articles
        ↓
Stage 1
Content Understanding & Selection
        ↓
processed_contents
        ↓
        ├── Event Candidate
        │       ↓
        │     Stage 2
        │ Event Understanding & Merge
        │       ↓
        │     events
        │
        ├── Source Digest
        ├── Long-form
        └── Inspiration
                ↓
              Stage 3
      Daily Brief Prioritization
                ↓
       write ranking results
                ↓
             Publish
```

#### Source Collection
主要由代码完成。

Collection Method：

```text
RSS
Email / Newsletter
Web（仅必要来源）
```

Collector 负责：

* 获取当天新增内容；
* 保存 Source Metadata（包括 Category）；
* 尽可能保存原始正文与原始 Metadata；
* URL / GUID 等基础去重；
* 写入 `raw_articles`。

#### Stage 1

调用 LLM 完成：

* Content Understanding；
* Selection；
* Routing；
* Tagging；
* Entity；
* Topic；
* Summary；
* 中文标题及摘要。

结果写入 `processed_contents`。

#### Stage 2

仅处理：
```text
processed_contents.routing = Event
```

调用 LLM 完成：

* Event Detection；
* Event Merge；
* Common Facts；
* Source Perspectives；
* 必要的 External Context Retrieval。

结果写入 `events`。

相关 Event Candidate 更新 `event_id`。

#### Stage 3

分别对以下内容排序：
```text
events

processed_contents
WHERE routing = Digest

processed_contents
WHERE routing = Long-form
```
排序结果直接写入对应记录。

保留：

```text
ai_rank
display_rank
```

默认：

```text
display_rank = ai_rank
```

人工调整只修改 `display_rank`，不覆盖 AI 原始排序。

Digest 的排序发生在每个 Source 内部，可使用：

```text
ai_source_rank
display_source_rank
```

Inspiration 不需要 AI 排序。

#### Daily Brief Composition

Daily Brief 不单独持久化为 `daily_briefs` 或 `brief_items`。

API 根据日期实时组合：

```text
events
+
Digest contents
+
Long-form contents
+
Inspiration contents
```

并按照 `display_rank` 返回。

如果未来出现以下需求，再增加 Brief Snapshot 模型：

* Draft / Published 版本；
* 同日多次重新生成；
* Daily / Weekly Brief；
* 不同用户的不同排序；
* 历史发布版本回滚。

---

### 1.3 Presentation Layer

MVP 使用 Web 页面展示 Daily Brief。
页面通过 API 获取：
```text
Today's Events
Source Digests
Long-form Reads
Daily Inspiration
```

后台人工操作包括：
* 删除 / 恢复内容；
* 修改分类；
* 调整 `display_rank`；
* 补充遗漏内容。
人工操作同时写入 `feedback`。

---

## 2. Tech Stack

### Web / Application Runtime

**Next.js**
用于：
* Daily Brief Web 页面；
* Review 页面；
* API；
* Daily Workflow application code。
MVP 不拆独立 Backend Service。

---

### Database

**PostgreSQL via Supabase**
<!-- 选择原因：
* Raw Article、Processed Content、Event 等数据都适合关系型数据库；
* 支持 JSONB，适合存储 AI Structured Output 和原始 Metadata；
* Supabase 提供 PostgreSQL 管理界面；
* 可以支持简单 Cron / Scheduled Job；
* 当前规模无需额外数据库。
MVP 不同时使用 MySQL。 -->

所有：
```text
Raw Data
Processed Data
Events
Ranking
Feedback
```
统一存储在 PostgreSQL。

---

### ORM

**Drizzle ORM**
<!-- 选择原因：
* TypeScript 类型安全；
* 接近 SQL，抽象层较薄；
* 适合数据 Pipeline 中常见的 JOIN、批处理和复杂查询；
* 更容易直接利用 PostgreSQL / JSONB 能力；
* 避免为 MVP 引入更重的 ORM abstraction。 -->
如特殊查询使用 Drizzle 不方便，可以直接使用 SQL。

---

### Scheduling

使用：
```text
Cron / Scheduled Job
```
Cron 只负责触发 Daily Workflow。

例如：
```text
daily-job
    ↓
collect
    ↓
process-stage-1
    ↓
process-stage-2
    ↓
process-stage-3
```

Workflow 的实际业务逻辑由 Application Code 执行，而不是写入数据库 Cron。

暂不引入：
* Kafka
* RabbitMQ
* Temporal
* Workflow Engine
* Distributed Queue

只有实际出现可靠性或规模问题后再评估。

---

### AI Integration

Stage 1–3 调用 LLM。

AI 调用遵循 `03-prompt-spec.md` 定义的：
* Input Schema；
* Output Schema；
* Prompt Guidelines。

应用代码依赖 Structured Output，而不依赖 Prompt 的具体文本。

---

### External Retrieval

Stage 2 在必要情况下允许 External Context Retrieval。

外部信息主要用于：
* 补充缺失事实；
* 验证冲突信息；
* 获取必要背景。

Search 不是每个 Event 的固定步骤，只在模型判断确有需要时执行。

---

### Architecture Principle

MVP 优先遵循：
```text
KISS
YAGNI
LLM-first
Rules only when necessary
```

只有实际 Failure 出现后，再增加：
* 新规则；
* 新 Collector；
* 评分系统；
* Queue；
* Workflow Engine；
* 其他基础设施。

---

## 3. Data Model

MVP 使用单一 PostgreSQL 数据库。

核心表：

```text
sources
    ↓
raw_articles
    ↓
processed_contents
        └── routing = event → events

feedback
```

MVP 暂不建立：
* `event_articles`
* `daily_briefs`
* `brief_items`

---

### 3.1 sources

保存 Source List 中配置的信息源。

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

#### Category normalization

导入 Source List 时统一：
```text
Economics
Business
Financial
Market
```
→
```text
Finance & Economy
```

```text
AI
Technology
```
→
```text
Technology
```

`category`、`source_type` 暂时使用普通 `text`，不增加数据库 CHECK，以方便运行后继续调整分类体系。

---

### 3.2 raw_articles

保存 Collector 获取并规范化后的原始信息。

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

#### source_item_origin_id
保存来源提供的 item identifier，例如：
```text
RSS GUID
Atom ID
Gmail Message ID
```
系统内部关联始终使用 `raw_articles.id`。

#### content_text
允许为空。
部分 RSS，例如 Nature Chemistry，可能只提供标题和链接而不提供正文或摘要。

正文不足的处理逻辑属于 `Processing Workflow`：
```text
RSS item
→ normalize
→ content insufficient?
→ fetch article page if possible
→ Stage 1
```

#### metadata
用于保存来源特有但暂时不值得升格为正式字段的信息，例如：
```json
{
  "premium": true,
  "gmail_labels": [],
  "feed_specific_field": "..."
}
```

稳定、跨来源、被系统逻辑直接依赖的数据应使用正式字段，不应长期全部塞入 `metadata`。

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

### 3.3 processed_contents

保存 Stage 1 `Content Understanding & Selection` 后被保留的内容。
Ignore 内容不创建 `processed_contents`。

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

#### routing
MVP routing：
```text
event
digest
long_form
inspiration
```

`routing` 决定后续程序流程，不应允许任意字符串,因此使用：
```text
text + CHECK
```

#### Ranking

`ai_rank`：Stage 3 的原始 AI 排序结果。
`display_rank`：最终页面展示顺序。
默认：
```text
display_rank = ai_rank
```
人工调整只修改 `display_rank`，保留 `ai_rank` 用于后续 Eval。

对于 Source Digest，`ai_rank` / `display_rank` 表示**同一 Source 内部的顺序**。

---

### 3.4 events

保存 Stage 2 `Event Understanding & Merge` 的结果。

一个 Event 可以对应多篇 Event Candidate。
MVP 假设：
> 一篇 Event Candidate 只属于一个主要 Event。
因此直接通过：
```text
processed_contents.event_id
```
建立关系，不创建 `event_articles`。

| Field                     | Type        | Constraint / Notes |
| ------------------------- | ----------- | ------------------ |
| `id`                      | uuid        | Primary Key        |
| `event_date`              | date        | NOT NULL           |
| `title`                   | text        | NOT NULL           |
| `title_zh`                | text        | NOT NULL           |
| `entities`                | text[]      | nullable           |
| `entities_zh`             | text[]      | nullable           |
| `summary`                 | text        | NOT NULL           |
| `summary_zh`              | text        | NOT NULL           |
| `source_perspectives`     | jsonb       | NOT NULL           |
| `conflicting_information` | text[]      | nullable           |
| `external_context`        | jsonb       | nullable           |
| `ai_rank`                 | integer     | nullable           |
| `display_rank`            | integer     | nullable           |
| `created_at`              | timestamptz | NOT NULL           |
| `updated_at`              | timestamptz | NOT NULL           |

#### source_perspectives

使用 JSONB，例如：

```json
[
  {
    "source": "Reuters",
    "summary": "..."
  },
  {
    "source": "Bloomberg",
    "summary": "..."
  }
]
```

#### external_context
没有进行 External Context Retrieval 时：
```text
NULL
```
执行外部检索后保存：
```json
{
  "sources": [],
  "summary": ""
}
```

---

### 3.5 feedback

保存人工对 AI 输出的修改。
MVP 保持简单，结构未来根据实际 Feedback / Eval 需求再调整。

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

---

### 3.6 Main Relationships

```text
sources
   1
   │
   N
raw_articles
   1
   │
  0..1
processed_contents
   N
   │
   0..1
events
```

其中 Event 关系实际为：
```text
events 1
   ↑
   N
processed_contents
```
仅 `routing = event` 的 processed content 会关联 Event。

---

### 3.7 Initial Indexes

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

## 4. Processing Workflow & Job Design
描述代码如何调用我们已经定义好的 AI stages。

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
Stage 2: Event Understanding & Merge
    ↓
Stage 3: Daily Brief Prioritization
    ↓
Publish-ready data
```
后续 Stage 由前一个 Stage 成功完成后主动触发，不使用固定时间分别调度。

---

### 4.2 Collection Job

Collection Job 根据 `sources.collection_method` 使用不同 Collector Adapter。
MVP 支持：
```text
RSS
Email
Web
```

逻辑：
```text
source
   ↓
collector adapter
   ↓
normalize
   ↓
deduplicate
   ↓
raw_articles
```

Collector Adapter：
```js
collectRSS(source)
collectEmail(source)
collectWeb(source)
```
不同 Collector 最终统一输出标准化 `Raw Article`。

#### RSS Collector

1. 获取 Feed；
2. 使用成熟 RSS Parser 解析；
3. 将 RSS Item 映射为标准字段；
4. 保存来源特有字段到 `metadata`；
5. 基础去重；
6. 写入 `raw_articles`。

已通过 RSS spike 验证：
* Bloomberg Technology
* Dow Jones
* BLS
* TechCrunch
* Nature Chemistry
* SemiAnalysis
* NASA Image of the Day
均可解析为统一 Raw Article 结构。

部分 Feed 特殊情况：
* BLS 需要浏览器式 User-Agent；

不为单个特殊 Feed 增加专用数据库字段。

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

---

### 4.3 Raw Content Completion

Collector 优先保存来源直接提供的正文或摘要。
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

---

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
这不是重复 Article。
保留全部内容，并在 Stage 2 进行 Event Merge。

---

### 4.5 Stage 1 Job

处理：
```js
raw_articles.stage1_status = pending
```

采用：
> 单篇 LLM 调用 + 有限并发,例如 5–10。
每个 Raw Article 独立执行：
```text
1 Raw Article
    ↓
1 Stage 1 LLM call
    ↓
Selected → processed_contents
Ignored  → update raw_articles status
Failed   → update raw_articles status
```
不使用一个大型 Batch Prompt 处理全部文章。

#### Stage 1 Result

Selected：
```js
raw_articles.stage1_status = selected
```
并创建对应 `processed_contents`。

Ignored：
```text
raw_articles.stage1_status = ignored
```
不创建 `processed_contents`。

Failed：
```text
raw_articles.stage1_status = failed
processing_error = ...
```

---

### 4.6 Stage 2 Job

Stage 1 全部可处理内容完成后触发 Stage 2。

查询当天：
```text
processed_contents
WHERE routing = 'event'
```
作为 Event Candidates。

Stage 2 对当天 Event Candidates 做整体或分组理解：
* 判断哪些报道属于同一现实事件；
* 创建 Events；
* 保留共同事实；
* 保留不同来源 Perspective；
* 必要时执行 External Context Retrieval。

生成：
```text
events
```
并更新相关：
```text
processed_contents.event_id
```
不创建 `event_articles`。

---

### 4.7 Stage 3 Job

Stage 2 完成后主动触发 Stage 3。

输入：
```text
当天 events

processed_contents
WHERE routing = 'digest'

processed_contents
WHERE routing = 'long_form'
```

三个分支分别排序。
Stage 3 结果直接写回原表。

#### Events
```text
events.ai_rank
events.display_rank
```

#### Source Digest
```text
processed_contents.ai_rank
processed_contents.display_rank
```
Digest Rank 表示同一 Source 内部排序。

#### Long-form
```text
processed_contents.ai_rank
processed_contents.display_rank
```

首次写入时：
```text
display_rank = ai_rank
```
人工修改只改变 `display_rank`。

Inspiration 不需要 AI Ranking。

---

### 4.8 Failure Handling

MVP 只处理明确的常见失败，不建立复杂 Workflow Engine。

#### Collector Failure

可能原因：
* network error
* timeout
* HTTP 4xx / 5xx
* RSS parse error
* source-specific blocking

处理：
* 当前 Source 独立失败；
* 记录错误；
* 允许重试该 Source；
* 不影响其他 Source Collection。

#### Stage 1 Failure

可能原因：
* LLM timeout
* rate limit
* invalid structured output
* temporary API error

处理：
* 当前 Raw Article 标记 `failed`；
* 可独立重试；
* 不重跑已成功文章。

#### Stage 2 Failure

Stage 2 属于 derived data。
失败时：
* 保留 Stage 1 数据；
* 重新执行当天 Event Understanding & Merge；
* 不需要重新 Collection 或 Stage 1。

#### Stage 3 Failure

失败时：
* 重新读取已有 Events / Digest / Long-form；
* 单独重跑 Stage 3；
* 不重新执行前序 Stage。

---

### 4.9 Idempotency 幂等性

Daily Workflow 必须可以安全重复执行。
重复运行不应：
* 重复插入相同 Raw Article；
* 重复生成同一 Processed Content；
* 重复调用已经成功完成的 Stage 1；
* 创建重复 Event。

#### Collection
通过来源 item ID / URL 等去重。

#### Stage 1
只处理：
```text
stage1_status = pending
```
同时：
```text
processed_contents.raw_article_id
```
保持 UNIQUE。

#### Stage 2
应支持安全重跑当天 Event Merge。
实现时可选择：
* 清理并重建当天 derived Events；
* 或根据 Event 结果进行 upsert。
优先采用实现更简单且可预测的方式。

#### Stage 3
Stage 3 只更新 Rank 字段。
重复执行时覆盖 `ai_rank`。
人工已经修改过的 `display_rank` 不应在普通重跑时被静默覆盖；如果需要重新同步 AI 排序，应显式执行。

---

### 4.10 Publish
MVP 不建立独立 Publish Job 或 Brief Snapshot。
Stage 3 完成后：
```text
events
processed_contents
```
即为页面可读取的最新 Daily Brief 数据。
API 根据当天日期、routing 和 `display_rank` 实时组合页面内容。

---

## 5. LLM Integration
Prompt 文件怎么管理、Structured Output、Web Search、失败重试、模型选择

### 5.1 Overview

LLM is used in three processing stages:
```text
Stage 1：Content Understanding & Selection
Stage 2：Event Understanding & Merge
Stage 3：Ranking
```
The behavior and output requirements of each stage are defined in `03-prompt-spec.md`.
Technical implementation should keep model invocation separate from business logic.

---

### 5.2 Prompt Organization

Each Stage uses an independent prompt.
```text
prompts/
├── stage1-content-understanding.ts
├── stage2-event-merge.ts
└── stage3-ranking.ts
```
Each prompt should follow the corresponding Stage definition in `03-prompt-spec.md`.
Prompts should not contain database or workflow implementation details.

---

### 5.3 Structured Output

All three Stages should return structured output.
Use schema validation for model responses.
```text
LLM Response
    ↓
Structured Output
    ↓
Schema Validation
    ↓
Application Logic
    ↓
Database
```
具体 Output Schema 以 `03-prompt-spec.md` 为准。
Schema Validation 失败时，不直接写入数据库。

---

### 5.4 Model Selection

先使用一个能力足够的通用模型。
暂不做：
* 多模型 Routing；
* Cheap / Expensive Model 分层；
* 根据任务动态选择模型。
模型调用应与业务逻辑解耦，未来可以替换模型而不修改 Workflow。

---

### 5.5 Stage 1 Invocation

```text
1 Raw Article
      ↓
1 LLM Call
      ↓
Structured Output
      ↓
processed_contents
```
采用单篇处理 + 有限并发。
输入包含理解文章所需的 Raw Article 和 Source 信息。

---

### 5.6 Stage 2 Invocation

Stage 2 输入当天全部 Event Candidates，LLM 需要：
```text
identify events
merge related reports
summarize shared facts
preserve different source perspectives
identify when external context may be useful
```

#### External Context Retrieval

Stage 2 may request additional Web Search when existing Event Candidates are insufficient to understand an important event.
Conceptually:
```text
Event Candidates
      ↓
Stage 2 reasoning
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
必要的信息保存到 `events.external_context`

---

### 5.7 Stage 3 Invocation

Stage 3 ranks the three content groups independently:
```text
Events
Source Digests
Long-form Reads
```

模型返回：
ID + Rank

Application Code 将结果写入对应数据的：
```text
ai_rank
display_rank
```

首次排序：display_rank = ai_rank
后续人工调整只修改 `display_rank`。

---

### 5.8 Validation & Retry

### Technical Failure

Examples:
```text
timeout
rate limit
API error
network error
```
Retry the same request with limited retries.

### Invalid Output
Examples:
```text
schema validation failure
missing required fields
invalid IDs
```
Allow a limited retry.
If still unsuccessful:
```text
mark processing as failed
record error
allow later manual/job retry
```
Do not silently accept invalid structured output.

---

### 5.9 Prompt Versioning
Prompt 文件随项目代码通过 Git 进行版本管理。
当 Prompt 发生影响模型行为的修改时，更新对应 Stage 的版本号，例如：
Stage 1 → v2
Stage 2 → v1
Stage 3 → v3

每次 Daily Workflow 执行时，在运行日志中记录：
date
model
stage1_prompt_version
stage2_prompt_version
stage3_prompt_version

---

## 6. Project Structure & Engineering Rules
目录、模块边界、环境变量、日志、测试以及 Codex 应遵守的基本规范。

### 6.1 Project Structure

MVP 采用单一 Next.js 项目，不拆分独立 Backend Service。
建议目录：
```text
x-ai-field/
├── src/
│   ├── app/                 # Next.js pages / API
│   │
│   ├── db/
│   │   ├── schema.ts
│   │   └── index.ts
│   │
│   ├── collectors/
│   │   ├── rss.ts
│   │   ├── email.ts
│   │   └── web.ts
│   │
│   ├── processing/
│   │   ├── stage1.ts
│   │   ├── stage2.ts
│   │   └── stage3.ts
│   │
│   ├── prompts/
│   │   ├── stage1.ts
│   │   ├── stage2.ts
│   │   └── stage3.ts
│   │
│   └── lib/
│
├── scripts/
│
├── docs/
│   ├── 01-product-spec.md
│   ├── 02-ai-workflow-spec.md
│   ├── 03-prompt-spec.md
│   ├── 04-technical-spec.md
│   └── 05-source-list.md
│
├── AGENTS.md
└── README.md
```

### 6.2 Module Boundaries

保持各模块职责单一：
```text
collectors → 获取并规范化外部数据

processing → 控制 Stage 1–3 的 Processing Workflow

prompts → 定义 LLM Prompt

db → Schema 和数据库访问

app → API 和页面
```

避免把：
* 数据抓取；
* Prompt；
* 数据库操作；
* 页面逻辑
混合在同一个模块中。

### 6.3 Engineering Principles

开发优先遵循：
* KISS
* YAGNI
* 保持模块职责清晰
* 优先使用成熟 Library，不重复实现基础能力
* 不为尚未出现的问题增加抽象层
* 新增复杂基础设施前，应有明确的实际需求

MVP 暂不引入：
* Microservices
* Message Queue
* Workflow Engine
* Agent Framework
* Repository / Service 等无实际必要的抽象层

### 6.4 Type & Schema

数据库 Schema、Structured Output 和核心数据结构应保持类型明确。
避免在应用代码中重复定义相同的数据结构。
LLM 输出必须经过 Schema Validation 后才能进入后续 Workflow。

### 6.5 Configuration

以下配置不得硬编码在业务逻辑中：
* Database connection
* LLM API key
* Model
* Prompt version
* Cron configuration
* External API credentials
Secrets 通过 Environment Variables 管理。

### 6.6 Error Handling

* 错误应在最接近发生位置处理和记录。
* 单个 Source、Article 或 LLM Request 的失败不应导致无关任务的数据丢失。
* 允许失败任务独立重试。
* 不要静默忽略错误。

### 6.7 Testing

MVP 优先测试真正影响 Pipeline 正确性的部分：
* Collector normalization
* Database constraints
* Structured Output validation
* Workflow state transitions
* Ranking / display rank update

Prompt 内容质量主要通过真实 Daily Brief + Human Feedback 评估，不为自然语言判断编写大量脆弱的传统 Unit Tests。
