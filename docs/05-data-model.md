# Data Model

## 1 `sources`
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

## 2 `raw_articles`
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

#### source_item_origin_id
保存来源提供的 item identifier，例如：
```text
RSS GUID
Atom ID
Gmail Message ID
```
系统内部关联始终使用 `raw_articles.id`。具体 Collection / Dedup 行为见 `06-processing-workflow.md`。

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

## 3 `processed_contents`

保存 Stage 1 保留内容：(Ignore 内容不入此表)

```text
id, raw_article_id, daily_date, routing, category,
tags, entities, entities_zh,
title_zh, summary, summary_zh,
event_id, ai_rank, display_rank,
created_at, updated_at
```

| Field            | Type        | Constraint / Notes             |
| ---------------- | ----------- | ------------------------------ |
| `id`             | uuid        | Primary Key                    |
| `raw_article_id` | uuid        | UNIQUE, FK → `raw_articles.id` |
| `daily_date`     | date        | NOT NULL；Production Daily attribution |
| `routing`        | text        | NOT NULL + CHECK               |
| `category`       | text        | NOT NULL                       |
| `tags`           | text[]      | nullable                       |
| `entities`       | text[]      | nullable                       |
| `entities_zh`    | text[]      | nullable                       |
| `title_zh`       | text        | nullable                       |
| `summary`        | text        | nullable                       |
| `summary_zh`     | text        | nullable                       |
| `event_id`       | uuid        | nullable, FK → `events.id`；仅兼容 convenience backlink |
| `ai_rank`        | integer     | nullable                       |
| `display_rank`   | integer     | nullable                       |
| `created_at`     | timestamptz | NOT NULL                       |
| `updated_at`     | timestamptz | NOT NULL                       |


**Routing：**
```text
event | digest | long_form | inspiration
```

`daily_date` 表示该内容首次进入 Production Workflow 时所属的 Daily attribution date；具体归属与 late-arrival 规则见 `06-processing-workflow.md`。

`ai_rank` 保存 AI 排序；`display_rank` 是页面最终顺序。人工调整只改 `display_rank`。

## 4 `events`
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

一个 Event 可关联多条 `processed_contents`。正式 source membership 由 `event_review_items.event_group_id → event_group_items` 表达，允许同一 `processed_content` 属于多个不同 Event Groups；Daily Brief 也由这条链读取来源。`processed_contents.event_id` 不能表达多对多，只保留为兼容 convenience backlink：仅当当前 published Stage 4 Run 中该内容恰好对应一个 Event 时写入；共享内容保持 `NULL`，不得用它判断正式 membership。

`event_date` 表示 Event 在 Production 中所属的 Daily attribution date，与对应 `stage4_runs.daily_date` 一致。它不表示 source article 的原始发布时间，也不单独推导现实事件发生时间。具体 Daily attribution 与 late-arrival 处理语义见 `06-processing-workflow.md`。

`external_context`：未发生真实 Web Search 时为 `NULL`；发生搜索时保存真实 provenance URLs 和简短 summary。

## 5 `event_review_items`

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

## 6 `event_groups` / `event_group_items` / `stage4_runs`

`event_groups` 是 Stage 2 按 `daily_date` 写入的可替换业务 snapshot；`event_group_items` 保存 Group 到 Event Candidate 的正式 many-to-many membership。唯一约束是 `(event_group_id, processed_content_id)`：同一 Group 内不重复，同一内容可出现在多个 Group。

`stage4_runs` 记录来源 Review snapshot、`daily_date`、`expected_count`、`success_count` 和 `running` / `partial` / `success` 状态。每个 enrichment 成功后立即写入对应 Run 的 draft Event；仅在 drafts 数量等于 `expected_count` 时才原子 publish。

## 7 `pipeline_runs`

跨机器持久化的 Pipeline 执行摘要，供 Dashboard 的运行观测与后续手动 Retry 使用；不保存完整
runtime artifact 或原始模型输出。

```text
id, daily_date, step, status, trigger_source, provider, model,
started_at, finished_at, metrics, error_summary, created_at, updated_at
```

- `step`: `daily`、`content_completion`、`exact_duplicate_filter`、`stage1` 至 `stage4`。
- `status`: `running`、`success`、`partial`、`failed`；Stage 4 的 `partial` 与其 business table
  `stage4_runs.status` 保持同一 canonical 值。
- `trigger_source`: `daily_orchestrator`、`standalone`、`dashboard`。
- `metrics` 为小型 JSONB 摘要（调用数、重试、耗时、Stage 特有计数等），不机械复制 runtime JSON。
- Dashboard 对指定 `daily_date + step` 选择 `started_at` 最新的一条，即 Latest Attempt。
- 索引：`(daily_date, step, started_at DESC)`。

## 8 `feedback`
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

## 9 `evaluation_inputs` / `evaluation_runs` / `evaluation_outputs`

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

Evaluation 数据与 Production 数据隔离，不自动写回 `processed_contents`、`events`、
`event_review_items`、`feedback`、`ai_rank` 或 `display_rank`。

`process_pid` 是 Evaluation Run 的服务端运行时关联信息，用于支持对对应 Run 的进程管理；它不是客户端可提交的业务标识。

Evaluation 的触发、并发控制、Polling、进程生命周期与取消流程属于运行 / Workflow 行为，见 `06-processing-workflow.md` 与 `09-operations.md`。

## 10 Initial Indexes

MVP 只建立明确需要的索引：
```text
raw_articles(source_id)
raw_articles(published_at)
raw_articles(collected_at)
raw_articles(stage1_status)

processed_contents(raw_article_id) UNIQUE
processed_contents(daily_date)
processed_contents(routing)
processed_contents(event_id)
processed_contents(display_rank)

events(event_date)
events(display_rank)
events(stage4_run_id, event_review_item_id) UNIQUE

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
