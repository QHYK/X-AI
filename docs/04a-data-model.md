# Data Model

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
content_text, full_content_text, image_url, source_tags, metadata,
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
| `full_content_text`     | text        | nullable；仅供后续详情复用，不进入 Stage 1 |
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
id, event_date, stage4_run_id, publication_status,
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
| `stage4_run_id`           | uuid        | nullable，FK → `stage4_runs.id` |
| `publication_status`      | text        | `draft` / `published` / `archived`；默认兼容历史数据为 `published` |
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

`event_date` 是事件自身的时间属性；Daily Brief 归属使用 `stage4_runs.daily_date`。late-arrival 即使具有较早的 `event_date`，只要由当前 workflow 归属到 `processed_contents.daily_date = D`，就应沿链路 `event_groups → event_review_items → stage4_runs` 展示在 D。

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
| `event_group_id`     | uuid        | nullable，FK → `event_groups.id`；Stage 3/4 正式关联 |
| `event_hint`         | text        | NOT NULL                               |
| `ai_rank`            | integer     | NOT NULL，人工不可覆盖                 |
| `display_rank`       | integer     | NOT NULL，Review 当前排序              |
| `member_content_ids` | uuid[]      | NOT NULL，关联 `processed_contents.id` |
| `created_at`         | timestamptz | NOT NULL                               |
| `updated_at`         | timestamptz | NOT NULL                               |

### 3.6 `event_groups` / `event_group_items` / `stage4_runs`

`event_groups` 是 Stage 2 按 `daily_date` 写入的可替换业务 snapshot；`event_group_items` 保存 Group 到 Event Candidate 的关联，并保证同一 processed content 只属于一个 Group。

`stage4_runs` 记录来源 Review snapshot、`daily_date`、`expected_count`、`success_count` 和 `running` / `partial` / `success` 状态。每个 enrichment 成功后立即写入对应 Run 的 draft Event；仅在 drafts 数量等于 `expected_count` 时才原子 publish。

### 3.7 `feedback`
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
  started_at, completed_at, duration_ms, input_tokens, output_tokens, process_pid, created_at
  ↓
evaluation_outputs
  id, evaluation_run_id, item_key, output_json, created_at
```

- Stage 2/3 的 `evaluation_inputs.input_json` 是完整 Frozen Stage Input；Stage 1 只保存
  `raw_articles` ID 列表与既有 micro-batch 配置，并在执行/展示时确定性重建。
  同一次 Evaluation 的所有 Model Run 必须引用同一个 input ID。`input_hash` 是稳定 JSON + SHA-256，用于人工核对输入一致性，不作为复杂内容寻址或缓存机制。
- `stage` 当前仅支持 `stage1`、`stage2`、`stage3_event`、`stage3_digest`、
  `stage3_long_form`。Digest 的每个 Category output 使用 `item_key = category`。
- Run status 为 `running` / `success` / `failed`；一个模型失败不影响其他 Run。Provider 未提供
  token metadata 时 token 字段为 NULL。
- `evaluation_outputs.output_json` 只保存已通过当前 Stage contract 校验的 Structured Output。
  删除一个 Run 会 cascade 删除其 outputs；删除 Run 不会删除 shared input，也不会 cascade 到任何 Production Table。

Evaluation 只允许 CLI 等人工入口触发，不加入 `npm run daily`、Cron、Scheduler 或正式
Orchestrator。它绝不写 `processed_contents`、`events`、`event_review_items`、`feedback`、
`ai_rank` 或 `display_rank`；Stage 4 不参加多模型 Evaluation。
Dashboard API 会先创建持久化的 `running` runs，再用固定 detached CLI 执行；读取页面 polling
`evaluation_runs` 的状态。当前运行时是长期运行的 Node server，独立子进程不依赖原 HTTP 请求；
同一 Daily + Stage 已有 running run 时拒绝重复触发。

每个 Model Run 使用独立 detached process group，`process_pid` 只在服务端用于取消对应 Run 及其
子进程；客户端只能提交 `evaluation_run.id`，不能传入系统 PID。取消会将仍为 `running` 的 Run
原子更新为 `cancelled`，不影响同一 Frozen Input 的其他模型；已 `success`、`failed` 或
`cancelled` 的 Run 不可再次取消。

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
