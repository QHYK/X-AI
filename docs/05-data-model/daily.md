# Daily / Review / Evaluation / Admin 数据模型

本文件每张表独立定义字段、索引和数据库约束。总体关联与核验边界见 [Data Model](README.md)。未另注时 UUID 主键默认 `gen_random_uuid()`，`created_at` / `updated_at` 默认 `now()`；`updated_at` 没有自动更新时间 Trigger，由写入代码维护。应用取值、JSON 内容校验与数据库 CHECK 明确区分。

## `sources`

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

### 索引与数据库约束

- 除主键外无额外索引或唯一约束。

## `raw_articles`

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
系统内部关联始终使用 `raw_articles.id`。具体 Collection / Dedup 行为见 `../06-workflow-spec/daily.md`。

#### metadata
用于保存来源特有但暂时不值得升格为正式字段的信息，例如：
```json
{
  "premium": true,
  "gmail_labels": [],
  "feed_specific_field": "..."
}
```

`raw_articles.metadata.put_back_preparation` 保存小型、经 Schema 校验的恢复准备结果（dailyDate、fields、ignoreType），不是新的 Pipeline 状态；独立于最终恢复事务提交，最终写入失败时可复用已付费生成结果。成功恢复保留该来源记录。准备缓存本身保存失败时返回生成字段并明确报错，不声称已经恢复；不保存重复正文。

#### stage1_status
建议值：
```text
pending
selected
ignored
failed
```
暂不使用数据库 CHECK，方便运行后增加状态。

`collected_at` 默认 `now()`。当前未声明来源加日期的组合索引；如有实际查询性能需求再评估，不列为已实现索引。Metadata 中的 Prompt UUID / 执行标记形状见 [Prompt 绑定载体](prompt-registry.md#版本绑定载体)，不是数据库外键。

### 索引与数据库约束

- `raw_articles_source_id_idx`：INDEX (`source_id`)。
- `raw_articles_published_at_idx`：INDEX (`published_at`)。
- `raw_articles_collected_at_idx`：INDEX (`collected_at`)。
- `raw_articles_stage1_status_idx`：INDEX (`stage1_status`)。
- FK (`source_id`) → `sources` (`id`)，ON DELETE `NO ACTION`。

## `processed_contents`

保存 Stage 1 保留内容，以及人工 Put Back 恢复的 Digest；自动 Ignore 不创建此表记录。

```text
id, raw_article_id, daily_date, routing, category,
tags, entities, entities_zh,
title_zh, summary, summary_zh,
event_id, ai_rank, display_rank, put_back_at,
created_at, updated_at
```

| Field            | Type        | Constraint / Notes             |
| ---------------- | ----------- | ------------------------------ |
| `id`             | uuid        | Primary Key                    |
| `raw_article_id` | uuid        | NOT NULL, UNIQUE, FK → `raw_articles.id` |
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
| `put_back_at`    | timestamptz | nullable；人工追加时间；Stage3 排名 / 过期清理后清空，不作为永久恢复历史 |
| `created_at`     | timestamptz | NOT NULL                       |
| `updated_at`     | timestamptz | NOT NULL                       |


**Routing：**
```text
event | digest | long_form | inspiration
```

`daily_date` 表示该内容首次进入 Production Workflow 时所属的 Daily attribution date；具体归属与 late-arrival 规则见 `../06-workflow-spec/daily.md`。

`ai_rank` 保存 AI 排序；`display_rank` 是页面最终顺序。人工调整只改 `display_rank`。

Put Back 复用 `raw_article_id` 唯一记录，追加阶段为 `routing = digest`、`ai_rank = NULL`，准备结果位于 Raw metadata。归属校验、状态写入、排序和后续 Stage3 重排规则统一见 `../06-workflow-spec/manual-operations.md` §2。

### 索引与数据库约束

- `processed_contents_raw_article_id_unique`：UNIQUE (`raw_article_id`)。
- `processed_contents_routing_idx`：INDEX (`routing`)。
- `processed_contents_event_id_idx`：INDEX (`event_id`)。
- `processed_contents_display_rank_idx`：INDEX (`display_rank`)。
- `processed_contents_daily_date_idx`：INDEX (`daily_date`)。
- FK (`raw_article_id`) → `raw_articles` (`id`)，ON DELETE `NO ACTION`。
- FK (`event_id`) → `events` (`id`)，ON DELETE `NO ACTION`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- processed_contents_routing_check
CHECK ("routing" in ('event', 'digest', 'long_form', 'inspiration'));
-- processed_contents_put_back_check
CHECK ("put_back_at" is null or ("routing" = 'digest' and "ai_rank" is null and "display_rank" is not null));
```

## `content_read_more`

保存用户按需生成、且通过 Read More 输出校验的中文详细导读：

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `content_id` | uuid | NOT NULL；FK → `processed_contents.id` |
| `summary_zh` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL；默认 now() |
| `updated_at` | timestamptz | NOT NULL；默认 now() |

`content_id` 唯一且关联 `processed_contents.id`；它是 Read More 的持久化缓存，不参与 Production Stage 1–4。

数据库不校验摘要非空或中文要求；输出校验与互斥见 [Read More](../04-technical-spec/admin-api.md#62-read-more)。

### 索引与数据库约束

- `content_read_more_content_id_unique`：UNIQUE (`content_id`)。
- FK (`content_id`) → `processed_contents` (`id`)，ON DELETE `CASCADE`。

## `events`

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
| `publication_status`      | text        | NOT NULL，默认 `published`；应用使用 `draft` / `published` / `archived`，无枚举 CHECK |
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

`event_date` 表示 Event 在 Production 中所属的 Daily attribution date，与对应 `stage4_runs.daily_date` 一致。它不表示 source article 的原始发布时间，也不单独推导现实事件发生时间。具体 Daily attribution 与 late-arrival 处理语义见 `../06-workflow-spec/daily.md`。

`external_context`：未发生真实 Web Search 时为 `NULL`；发生搜索时保存真实 provenance URLs 和简短 summary。

### 索引与数据库约束

- `events_event_date_idx`：INDEX (`event_date`)。
- `events_display_rank_idx`：INDEX (`display_rank`)。
- `events_stage4_run_id_idx`：INDEX (`stage4_run_id`)。
- `events_publication_status_idx`：INDEX (`publication_status`)。
- `events_run_review_item_unique`：UNIQUE (`stage4_run_id, event_review_item_id`)。
- FK (`event_review_item_id`) → `event_review_items` (`id`)，ON DELETE `NO ACTION`。
- FK (`stage4_run_id`) → `stage4_runs` (`id`)，ON DELETE `NO ACTION`。

普通 UNIQUE 对含 NULL 的旧关联不作去重；它不是跨 Run 的发布唯一约束。

## `event_review_items`

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
| `member_content_ids` | uuid[]      | NOT NULL，逻辑关联 `processed_contents.id`；数组元素无 FK |
| `created_at`         | timestamptz | NOT NULL                               |
| `updated_at`         | timestamptz | NOT NULL                               |

`review_run_id` 是快照标识，不关联单独的 Review Run 表。

### 索引与数据库约束

- `event_review_items_daily_date_idx`：INDEX (`daily_date`)。
- `event_review_items_run_temp_unique`：UNIQUE (`review_run_id, event_temp_id`)。
- `event_review_items_run_ai_rank_unique`：UNIQUE (`review_run_id, ai_rank`)。
- `event_review_items_run_display_rank_unique`：UNIQUE (`review_run_id, display_rank`)。
- `event_review_items_run_group_unique`：UNIQUE (`review_run_id, event_group_id`)。
- FK (`event_group_id`) → `event_groups` (`id`)，ON DELETE `SET NULL`。

Migration `0010` 中的 Group 唯一索引名为 `eri_run_group_unique`；Drizzle 为 `event_review_items_run_group_unique`。

`event_group_id` 可为空，普通 UNIQUE 允许同一 Review Snapshot 存在多条空 Group 关联；数组成员不因此获得外键保护。

## `event_groups`

Stage2 按 `daily_date` 保存可替换的 Group snapshot，不复制最终 Event 内容。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `daily_date` | date | NOT NULL |
| `event_hint` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL；默认 now() |
| `updated_at` | timestamptz | NOT NULL；默认 now() |

### 索引与数据库约束

- `event_groups_daily_date_idx`：INDEX (`daily_date`)。

## `event_group_items`

Group 到 Event Candidate 的正式 many-to-many membership；没有独立 `id`、主键或时间戳。

| Field | Type | Constraint / Notes |
|---|---|---|
| `event_group_id` | uuid | NOT NULL；FK → `event_groups.id` |
| `processed_content_id` | uuid | NOT NULL；FK → `processed_contents.id` |

同一 Group 内不重复，同一内容可以属于多个 Group。Migration `0012_event_group_many_to_many.sql` 已删除旧的 `egi_content_unique`；当前不对 `processed_content_id` 单列设唯一约束。

Migration `0010` 将组合唯一索引命名为 `egi_group_content_unique`，Drizzle 命名为 `event_group_items_group_content_unique`；定义相同，实际名称依部署路径而定。

### 索引与数据库约束

- `event_group_items_group_content_unique`：UNIQUE (`event_group_id, processed_content_id`)。
- FK (`event_group_id`) → `event_groups` (`id`)，ON DELETE `CASCADE`。
- FK (`processed_content_id`) → `processed_contents` (`id`)，ON DELETE `NO ACTION`。

## `stage4_runs`

记录一个 Review Snapshot 的 Stage4 生成与发布执行。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `daily_date` | date | NOT NULL |
| `review_run_id` | uuid | NOT NULL；逻辑对应 event_review_items.review_run_id，无 FK |
| `status` | text | NOT NULL；应用使用 running / partial / failed / success；无状态 CHECK |
| `prompt_versions` | jsonb | NOT NULL；默认 {}；Request Key → Version UUID；JSON 对象，值与 key 归属由应用校验 |
| `expected_count` | integer | NOT NULL |
| `success_count` | integer | NOT NULL；默认 0 |
| `created_at` | timestamptz | NOT NULL；默认 now() |
| `completed_at` | timestamptz | nullable |

Review Snapshot 唯一；Migration `0010` 中索引名为 `stage4_runs_review_unique`，Drizzle 为 `stage4_runs_review_run_unique`。Event 复用、当前入选集合检查和原子发布见 [Daily Technical Spec](../04-technical-spec/daily.md#3-stage4-run-与-event-复用)，不能仅凭 draft 数量推断可以发布。Prompt 载体见 [版本绑定载体](prompt-registry.md#版本绑定载体)。

该列及对象 CHECK 由 `0022_stage4_prompt_versions.sql` 引入；已有数据库的部署状态核验见 [Operations §2.3](../09-operations.md#23-prompt-基线导入与生产接入)。

### 索引与数据库约束

- `stage4_runs_daily_date_idx`：INDEX (`daily_date`)。
- `stage4_runs_review_run_unique`：UNIQUE (`review_run_id`)。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- stage4_runs_prompt_versions_object_check
CHECK (jsonb_typeof("prompt_versions") = 'object');
```

## `pipeline_runs`

跨机器持久化的 Pipeline 执行摘要，供 Dashboard 的运行观测与后续手动 Retry 使用；不保存完整
runtime artifact 或原始模型输出。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `daily_date` | date | NOT NULL |
| `step` | text | NOT NULL |
| `status` | text | NOT NULL |
| `trigger_source` | text | NOT NULL |
| `provider` | text | nullable |
| `model` | text | nullable |
| `started_at` | timestamptz | NOT NULL；默认 now() |
| `finished_at` | timestamptz | nullable |
| `metrics` | jsonb | NOT NULL；默认 {} |
| `error_summary` | text | nullable |
| `created_at` | timestamptz | NOT NULL；默认 now() |
| `updated_at` | timestamptz | NOT NULL；默认 now() |

- `step`（应用取值，无数据库 CHECK）: `daily`、`content_completion`、`exact_duplicate_filter`、`stage1` 至 `stage4`。
- `status`（应用取值，无数据库 CHECK）: `running`、`success`、`partial`、`failed`；Stage 4 的 `partial` 与其 business table
  `stage4_runs.status` 保持同一 canonical 值。
- `trigger_source`（应用取值，无数据库 CHECK）: `daily_orchestrator`、`standalone`、`dashboard`。
- `metrics` 为小型 JSONB 摘要（调用数、重试、耗时、Stage 特有计数及 Provider usage）；LLM Stage 可记录 `input_tokens`、`output_tokens`、`total_tokens`、`cached_input_tokens` 与 `token_usage_complete`。缓存命中率是由完整统计派生的 `cached_input_tokens / input_tokens`，不持久化，也不机械复制 runtime JSON。
- Stage3 的 `metrics.stage3_digest_checkpoints[category]` 为分类成功记录：`status=success`、category、input_hash、prompt_version_id、system_fragment_versions、按排名排列的 processed content UUID 数组 `ranked_ids`，以及本次 execution 摘要。它与对应业务排名同事务提交，不保存正文或模型原始响应。去重后空分类只清理过期排名，`prompt_version_id=null`，不加载 Prompt 或调用模型；父 Run 为 partial / failed / running 并不否定已提交的分类。不存在标记、版本 / Hash 不符或实际排名不完整时，不可据此复用。`digest_categories` 和 `category_corrections` 提供本次执行诊断；结束日志不得覆盖已提交标记。这是现有 JSONB 的应用结构扩展，无新增 Schema / Migration。
- Dashboard 对指定 `daily_date + step` 选择 `started_at` 最新的一条，即 Latest Attempt。

Migration `0011` 的索引尾列为 `started_at DESC`；当前 Drizzle `.on()` 未声明 DESC。这里分别记录定义，不声称两者方向完全相同。`metrics` 只声明 JSONB 非空及默认对象，没有 JSON 对象类型 CHECK。

### 索引与数据库约束

- `pipeline_runs_daily_step_started_idx`：INDEX (`daily_date, step, started_at`)。

## `feedback`

当前保留简单结构，结构未来根据实际 Feedback / Eval 需求再调整。

| Field           | Type        | Constraint / Notes        |
| --------------- | ----------- | ------------------------- |
| `id`            | uuid        | Primary Key               |
| `target_type`   | text        | NOT NULL；应用使用 event_review_item / processed_content，无 CHECK |
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

`target_id` 是多态逻辑关联，没有数据库 FK；`feedback_type` 的示例值也不是枚举 CHECK。

### 索引与数据库约束

- 除主键外无额外索引或唯一约束。

## `evaluation_inputs`

保存人工评测输入，独立于 Production 输出。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `daily_date` | date | NOT NULL |
| `stage` | text | NOT NULL |
| `input_json` | jsonb | NOT NULL |
| `input_hash` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL；默认 now() |

`stage` 应用支持 stage1、stage2、stage3_event、stage3_digest、stage3_long_form；数据库无枚举 CHECK。Stage2/3 的 `input_json` 是 Frozen Stage Input；Stage1 保存 Raw IDs 与 micro-batch 配置，执行 / 展示时重建。`input_hash` 为稳定 JSON 的 SHA-256，由应用计算；不是 UNIQUE 或数据库格式 CHECK。

### 索引与数据库约束

- `evaluation_inputs_daily_stage_idx`：INDEX (`daily_date, stage`)。

## `evaluation_runs`

同一输入可以有多个 Provider / Model Run，均通过 `evaluation_input_id` 关联，不向正式内容表写入。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `evaluation_input_id` | uuid | NOT NULL；FK → `evaluation_inputs.id` |
| `provider` | text | NOT NULL |
| `model` | text | NOT NULL |
| `prompt_version` | text | NOT NULL；text；当前保存精确 Prompt UUID；历史标签兼容见 Prompt 载体 |
| `status` | text | NOT NULL |
| `error` | text | nullable |
| `started_at` | timestamptz | NOT NULL；默认 now() |
| `completed_at` | timestamptz | nullable |
| `duration_ms` | integer | nullable |
| `input_tokens` | integer | nullable |
| `output_tokens` | integer | nullable |
| `process_pid` | integer | nullable；内部进程关联信息，不是客户端业务输入 |
| `created_at` | timestamptz | NOT NULL；默认 now() |

应用状态 running / success / failed，无数据库 CHECK；Provider 未返回 Usage 时 Token 字段为 NULL。`prompt_version` 不是数据库 FK，同一输入的绑定一致性由服务层维护。一个模型失败不影响其他 Run，删除 Run 不删除共享 input。触发、互斥、Polling 与取消见 [Manual Operations](../06-workflow-spec/manual-operations.md#5-model-evaluation)。

### 索引与数据库约束

- `evaluation_runs_input_idx`：INDEX (`evaluation_input_id`)。
- FK (`evaluation_input_id`) → `evaluation_inputs` (`id`)，ON DELETE `NO ACTION`。

## `evaluation_outputs`

保存通过当前 Stage Contract 校验的 Structured Output；校验不由数据库 JSONB 类型自动完成。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `evaluation_run_id` | uuid | NOT NULL；FK → `evaluation_runs.id` |
| `item_key` | text | nullable |
| `output_json` | jsonb | NOT NULL |
| `created_at` | timestamptz | NOT NULL；默认 now() |

Digest 每个分类输出的 `item_key` 使用 category；该字段 nullable，没有 `(evaluation_run_id, item_key)` UNIQUE。删除 Run cascade 删除其 outputs，不影响共享 input 或 Production 表。评测不回写 `processed_contents`、`events`、`event_review_items`、`feedback` 或正式排名。

### 索引与数据库约束

- `evaluation_outputs_run_idx`：INDEX (`evaluation_run_id`)。
- FK (`evaluation_run_id`) → `evaluation_runs` (`id`)，ON DELETE `CASCADE`。
