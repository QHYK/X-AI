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

## 3 `processed_contents`

保存 Stage 1 保留内容，以及人工 Put Back 恢复的 Digest；自动 Ignore 不创建此表记录。

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
| `put_back_at`    | timestamptz | nullable；人工追加时间；Stage3 排名 / 过期清理后清空，不作为永久恢复历史 |
| `created_at`     | timestamptz | NOT NULL                       |
| `updated_at`     | timestamptz | NOT NULL                       |


**Routing：**
```text
event | digest | long_form | inspiration
```

`daily_date` 表示该内容首次进入 Production Workflow 时所属的 Daily attribution date；具体归属与 late-arrival 规则见 `06-processing-workflow.md`。

`ai_rank` 保存 AI 排序；`display_rank` 是页面最终顺序。人工调整只改 `display_rank`。

Put Back 保持 `raw_article_id` 唯一约束；在同一事务中创建 / 更新原处理记录并将 Raw 标记 selected，不创建新的 Raw 或修改原 Source / URL。已有其他 Daily attribution 或已关联 Event 的非 Digest 记录不得被静默迁移 / 解绑。恢复时 `routing = digest`、`ai_rank = NULL`；后续 Stage3 清空追加标记并更新排名，原恢复准备记录保留在 Raw metadata。排名维护规则见 `06-processing-workflow.md` 的 Put Back。

### `content_read_more`

保存用户按需生成、且通过 Read More 输出校验的中文详细导读：

```text
id, content_id, summary_zh, created_at, updated_at
```

`content_id` 唯一且关联 `processed_contents.id`；它是 Read More 的持久化缓存，不参与 Production Stage 1–4。

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

`stage4_runs` 记录来源 Review snapshot、`daily_date`、`expected_count`、`success_count` 和 `running` / `partial` / `success` 状态；`prompt_versions JSONB NOT NULL DEFAULT '{}'` 保存该 Run 的 Request Key → Version UUID 映射，约束为 JSON object（Migration `0022_stage4_prompt_versions.sql`）。每个 enrichment 成功后立即写入对应 Run 的 draft Event；仅在 drafts 数量等于 `expected_count` 时才原子 publish。

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
- `metrics` 为小型 JSONB 摘要（调用数、重试、耗时、Stage 特有计数及 Provider usage）；LLM Stage 可记录 `input_tokens`、`output_tokens`、`total_tokens`、`cached_input_tokens` 与 `token_usage_complete`。缓存命中率是由完整统计派生的 `cached_input_tokens / input_tokens`，不持久化，也不机械复制 runtime JSON。
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

## 11 Discovery 数据模型

Discovery 与 Daily Production 独立，不修改既有 `feedback`、`pipeline_runs` 或 `raw_articles`。**Implemented**：本节各业务表、Trace 表及 Fetch Cache 已有 Schema 与 Migration。**Planned**：`single_lead` 的执行入口尚未实现，其数据库预留字段与约束仍保留。执行流程见 `06a-discovery-workflow.md`，技术边界见 `04a-discovery-technical-spec.md`。

### 11.1 `discovery_runs`

每次独立执行创建 Run；人工补充 Open Discovery 创建子 Run，并通过 `parent_run_id` 关联原 Regular Run。Planned 的单条 Lead 执行沿用该父子设计，当前没有执行入口。自动 Fallback Open 若属于 Regular Run 的内部执行阶段，不额外创建子 Run。相同输入允许不同输出。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | Primary Key |
| `parent_run_id` | uuid | nullable, FK → `discovery_runs.id`；`single_lead` 或人工补充 `open` 时指向原 `regular` Run；不得等于自身 `id` |
| `source_lead_id` | text | nullable；仅 `single_lead` 填写，引用父 Run 的 `selection_output.leads[].leadId`（应用层校验） |
| `run_type` | text | NOT NULL；`regular` / `single_lead` / `open` |
| `trigger_source` | text | NOT NULL；`schedule` / `manual` |
| `status` | text | NOT NULL；`pending` / `running` / `completed` / `partial` / `failed` / `blocked` |
| `end_reason` | text | 运行中为 NULL；`completed` 对应 `candidates_found`（有候选）或 `no_candidates`（无合格候选）；异常情况如 `timeout` / `budget_exhausted` / `upstream_not_ready` / `error` |
| `window_start_date` | date | nullable；常规 Run 目标 Daily 日期范围起点 |
| `window_end_date` | date | nullable；常规 Run 目标 Daily 日期范围终点 |
| `input_content_ids` | jsonb | nullable；实际送入 Topic Selection 的 Daily 内容 ID 列表（按 Event / Digest / Long-form 分类），不复制正文 |
| `selection_output` | jsonb | nullable；Topic Selection 的结构化输出（Direct + Topic 总数最多 8）；Code 为每条 Lead 分配稳定 `leadId`，保留 D2 顺序和类型 |
| `config_snapshot` | jsonb | nullable；模型、Prompt 版本、输入规则版本、资源限制、当次适用的 Memory，以及人工 Open 的补充说明 / 审核上下文等必要配置 |
| `execution_state` | jsonb | NOT NULL，默认 `{}`；保存 D2–D5 的阶段级动态执行状态与诊断，不属于不可变配置快照 |
| `started_at` | timestamptz | nullable |
| `finished_at` | timestamptz | nullable |
| `error_summary` | text | nullable |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

- `run_type` 使用 CHECK 限定为 `regular` / `single_lead` / `open`，并遵守以下父子关系：
  - `regular`：`parent_run_id` 与 `source_lead_id` 均为 NULL；独立重新执行即使输入窗口相同也创建新的无父 Run，不自动建立父子关系。
  - `single_lead`：`parent_run_id` 与 `source_lead_id` 均为 NOT NULL；父 Run 必须是原 `regular` Run，Lead 必须来自父 Run 的 `selection_output`。
  - `open`：`source_lead_id` 为 NULL；人工补充执行时 `parent_run_id` 为 NOT NULL 并指向原 `regular` Run，并保存继承的 `window_start_date` / `window_end_date`。自动 Fallback Open 作为 `regular` Run 的内部阶段执行，不创建 `run_type = 'open'` 的子 Run。
- 使用 CHECK 约束上述空值组合：`regular` 只能是无父 Run，`single_lead` 必须同时提供父 Run 和 Lead，独立的 `open` Run 必须提供父 Run 且不能提供 Lead。
- `CHECK(parent_run_id IS NULL OR parent_run_id <> id)` 防止 Run 自引用；父 Run 的类型与 Lead 归属由应用层验证。
- 日期字段记录**计划输入窗口**，不从实际执行时间推导；`input_content_ids` 记录当次选入的 Event / Digest / Long-form 内容成员 ID，避免复制 Daily 正文。当前没有 `input_snapshot`，不得将成员 ID 记录视为完整模型输入文本快照。
- 上游 Daily 未就绪可记录 `blocked` 和 `upstream_not_ready`，不冒充已完成 Discovery。
- 人工 Open 不重新执行 Topic Selection；**Planned** 的 `single_lead` 也不重新执行 Topic Selection，单条执行通过 `parent_run_id + source_lead_id` 定位原线索，Direct 复用 D4、Topic 复用 D3；原运行结果不覆盖。Lead ID 由应用代码在 D2 输出校验后生成，不能由 LLM 自由生成。
- **Planned**：单条 Lead 执行入口实现后，各 Lead 的执行状态及关联结果通过 Run 的 `selection_output`、关联的 `single_lead` Run 和候选记录查询计算，不新增 Lead 表或冗余状态字段。
- 自动 Open 仅在常规 Direct / Topic 均正常完成且合计 0 篇合格作品时触发；分支失败不自动重跑、不自动 Open。
- `status` 与 `end_reason` 分开：例如 `partial + timeout`、`completed + candidates_found` 与 `completed + no_candidates` 的业务含义不同；`end_reason` 只在运行结束时填写。
- `execution_state` 仅接受 JSON 对象。已执行阶段以 `d2` / `d3` / `d4` / `d5` 键保存 `status`、`endReason`、`completedAt`、错误摘要、Provider / Model / API mode、累计 `elapsedMs` 与 `usage`；更新单个阶段时不得覆盖其他阶段。`running` 或字段缺失均不表示完成，历史 Run 不从缺失状态推断成功。D3 / D5 正常空结果也写入对应 `status = 'completed'` 与 `endReason = 'no_candidates'`，供 Resume 作确定性判断。
- `usage` 包含 `requests`、`inputTokens`、`outputTokens`、`cachedInputTokens` 与 `usageComplete`。缓存输入已包含在输入 Token 内，不得再次加到总 Token；Provider 未返回某字段使用 `null`，任一请求缺失完整 Usage 时 `usageComplete = false`。缓存命中率是读取端派生指标（`cachedInputTokens / inputTokens`），不持久化；统计不完整时不得展示为完整命中率。

- 已接受的队列任务在 `config_snapshot.dashboardJob.requestId` 保存请求标识（沿用既有键名）：Dashboard 使用随机值；Scheduled CLI 使用 `discovery:scheduled:YYYY-MM-DD` 固定值，日期为上海业务日期，同日各终态也不重复创建定时 Run，`trigger_source` 使用既有 `schedule`。标识查找与创建沿用同一提交锁，手动新请求不与定时标识冲突。已有 status / error_summary / 时间戳记录排队、执行和终态，不新增任务表。Worker 只消费带该标记的 pending Run；普通 CLI 创建的 Run 不被当作排队任务。业务窗口、父子关联和既有候选保持原义。
- Dashboard Selected Article Count 查询 `discovery_candidates.run_id = discovery_runs.id` 关联的 `in_depth_candidates` 行数，包括提交后已 Approved / Rejected 的行；不是发现数或 Approved 数。普通 Run 与 Open Run 分别统计自己的新增审核候选。

### 11.2 `discovery_trace_spans`

记录 Agent SDK Trace / Span，支持按 Run 查看 Agent 内实际搜索、阅读、模型调用和错误。**此表是执行证据，不作为候选审核状态的 Source of Truth。**

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | Primary Key；本地数据库标识 |
| `run_id` | uuid | NOT NULL, FK → `discovery_runs.id` |
| `trace_id` | text | NOT NULL；SDK Trace ID 或应用统一 Trace ID |
| `span_id` | text | NOT NULL；SDK Span ID 或应用生成 ID |
| `parent_span_id` | text | nullable；同一 Trace 中的父 Span |
| `span_type` | text | NOT NULL；如 agent / generation / function / custom，保留 SDK 原始类型 |
| `name` | text | nullable；便于 Dashboard 显示步骤 |
| `started_at` | timestamptz | nullable |
| `ended_at` | timestamptz | nullable |
| `status` | text | nullable；成功、失败等展示用状态 |
| `payload` | jsonb | nullable；经过敏感信息过滤的 SDK 原生结构或自定义业务数据 |
| `created_at` | timestamptz | NOT NULL |

- `UNIQUE(trace_id, span_id)`；不预设 SDK 的深层 JSON 字段结构。`parent_span_id` 仅作逻辑关联，不强制自引用 FK。
- SDK Tracing Processor 负责接收 / 持久化 SDK Span。首版不要求将普通 LLM Client 与 Code 检查接入 SDK Span；Topic Selection 输出、最终候选与运行结果等必要业务信息分别由 `discovery_runs`、`discovery_candidates` 等业务表保存。
- 不在每个 Span 重复保存完整抓取正文；只保存真实 URL、抓取状态、必要阅读证据和错误摘要。Token 信息若 SDK 返回，可保留在 `payload`，首版不强制独立列。
- Processor 的具体生命周期、缓冲、flush、导出策略以开发时 SDK 实验结果为准。

### 11.3 `discovery_candidates`

记录进入实质阅读 / 评价的候选作品，包括最终未入选者；不要求把每条搜索结果都落为 Candidate。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | Primary Key |
| `run_id` | uuid | FK → `discovery_runs.id`；仅 manual 为 NULL，其余路径 NOT NULL |
| `discovery_path` | text | NOT NULL；`direct` / `topic` / `open` / `manual` |
| `source_content_type` | text | nullable；明确 Daily 来源存在时为 `event` / `processed_content` |
| `source_content_id` | uuid | nullable；来源内容 ID；按 `source_content_type` 解释为 `events.id` 或 `processed_contents.id` |
| `source_lead_id` | text | nullable；候选所来自的 D2 Lead；由应用代码生成并校验，不由 LLM 生成 |
| `topic_context` | jsonb | nullable；知识探索问题、来源 Daily IDs、News Context 等 |
| `url` | text | NOT NULL；作品原始 URL |
| `normalized_url` | text | nullable；去重用规范化 URL |
| `title` | text | nullable；作品原始标题 |
| `title_zh` | text | nullable；中文标题，来自 D3 / D5 输出或后续编辑补充 |
| `author` | text | nullable |
| `publication` | text | nullable；作品发布来源；各路径共用归一化规则，见 `04a-discovery-technical-spec.md` §5.1 |
| `content_type` | text | nullable；`article` / `video` / `podcast` |
| `published_at` | timestamptz | nullable |
| `estimated_duration_minutes` | integer | nullable |
| `summary` | text | nullable；中文内容概要，来自 D3 / D5 或后续编辑补充 |
| `why_worth_reading` | text | nullable；中文推荐理由，来自 D3 / D5 或后续编辑补充 |
| `extra_info` | jsonb | NOT NULL，默认 `{}`；D3 / D4 / D5 的非固定结构补充信息，仅接受 JSON 对象 |
| `evidence` | jsonb | nullable；实际阅读来源、正文获取程度、引用证据、局限 |
| `evaluation` | jsonb | nullable；编辑判断、入选或淘汰理由 |
| `status` | text | NOT NULL；`discovered` / `evaluated` / `selected` / `rejected` / `unverifiable` |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

- 一篇作品可在不同 Run 或不同路径中再次发现，不设置全局 URL UNIQUE；在**同一次审核汇总**时由 Code 进行去重。
- `source_content_type` 与 `source_content_id` 使用组合 CHECK：`(source_content_type IS NULL AND source_content_id IS NULL) OR (source_content_type IN ('event', 'processed_content') AND source_content_id IS NOT NULL)`，因此二者必须同时为 NULL 或同时非 NULL：
  - Daily Event 来源：`source_content_type = 'event'`，`source_content_id = events.id`。
  - Digest / Long-form 来源：`source_content_type = 'processed_content'`，`source_content_id = processed_contents.id`。
  - 无明确单条 Daily 来源（例如 Open Discovery，或由多个 Event 共同启发且不应任选一个作为唯一来源的 Topic Lead）：两个字段均为 NULL。
- `source_content_id` 表示候选的**来源内容**，不是候选作品本身的 ID。由于它按类型分别引用两张表，不建立单一 FK；应用层负责验证来源存在性以及 ID 与类型匹配。多个来源的完整关系通过 D2 Lead 的输入与 `topic_context` 追溯，首版不增加多对多关系表。
- `source_lead_id` 的语义取决于执行 Run：
  - `regular` Run 的 Direct / Topic 候选：引用当前 Run 的 `selection_output.leads[].leadId`。
  - `single_lead` Run 的候选：引用父 Run 的 `selection_output.leads[].leadId`，并且必须等于子 Run 的 `discovery_runs.source_lead_id`。
  - `open` 路径候选：为 NULL。
  Lead 存在 JSONB 中，因此不建立数据库 FK，由应用层校验归属。Lead ID 由应用代码稳定生成，不能由 LLM 自由生成。
- D3 Final Output 的每篇 Candidate 必须显式提供一个 `sourceLeadId`，且必须属于本次输入的 Topic Leads。Agent 选择作品的主要归属 Lead，Code 严格校验并映射到 `source_lead_id`；首版不猜测默认 Lead，也不建立多对多来源关系。
- Candidate 使用 CHECK 将 `discovery_path` 限定为 `direct` / `topic` / `open` / `manual`，并约束 `direct` / `topic` 必须提供 `source_lead_id`、`open` / `manual` 必须保持 `source_lead_id` 为 NULL。manual 的 `run_id` 必须为 NULL，其余路径必须非 NULL；既有 Run / Lead 关系不变。
- manual 候选初始 `status = discovered`，直接创建 pending 审核记录；生成后为 evaluated，不写入 D4 decision。`evaluation.tags` 保存人工或模型 Tags，`manualTags` 标记是否有人工标签，`manualGenerated` 标记已完成生成；正文通过关联 URL 读取既有 Fetch Cache / Daily。`evidence` 只保存抓取诊断、来源与 Cover，不伪造机器筛选证据。Generate 同时保存 `title_zh`、`summary`、`why_worth_reading` 及 §11.4 三段 Editorial；人工修改继续只更新 Editorial，原始生成介绍保留。无需新增表，Migration 放宽 Run 必填并增加 manual 路径及对应 CHECK，历史记录不回填或重写。
- D3 / D4 / D5 的 `title_zh`、`summary`、`whyWorthReading` 分别映射为已有列 `title_zh`、`summary`、`why_worth_reading`。D4 的 `decision` / `reason` 保存于 `evaluation`，内容证据 / `limitations` 保存于 `evidence`，不挪作读者介绍。历史 Direct 未生成介绍时允许 NULL，不重写历史输出。归一化后的 Source 写入已有 `publication`；Topic / Open 的 Fetch 来源元数据随 `evidence.fetch.metadata.publication` 保存，Direct 可用元数据摘要保存在 `evidence.sourceMetadata.publication`。这些字段映射复用既有列；独立原文 Cache 的新增表见 §11.5。
- D3 / D4 / D5 的 `extra_info` 统一保存于 `extra_info` JSONB；缺失时规范化为 `{}`，只允许 JSON 对象，禁止数组、字符串等非对象值。应用层应限制序列化大小并过滤敏感、重复、无关内容；`extra_info` 不得替代固定字段、证据或业务校验。
- `evidence` 保存实际获取的内容证据及其来源，不把 Agent 的自然语言声明当成已阅读证据。
- `evaluation.tags` 保存最终内容评价生成的双语标签：`[{ "zh": "科学方法", "en": "Scientific Method" }]`，最多 3 对，每对中英文均非空；按任一语言名称去重，历史缺失按空数组读取。它是评价的固定键，不写入自由补充字段 `extra_info`。
- Cover 复用 `evidence` JSONB：Direct 使用 `evidence.coverImage`，Topic / Open 使用实际 Fetch 摘要中的 `evidence.fetch.coverImage`，不重复保存。值为 `{ url, source, width, height }` 或 `null`；`source` 为 `og:image` / `twitter:image` / `article` / `raw_article`，尺寸为可获得的正整数，否则为 `null`。它只来自 Code 验证的抓取或已有来源元数据，不接受模型输出的图片。历史缺失按无图片读取。本次不新增数据库列，也不回写历史输出。
- 若某篇作品由多个路径发现，可在 `topic_context` / `evidence` 中保留额外来源关联；首版不增加候选来源关系表。

### 11.4 `in_depth_candidates`

正式进入人工审核的作品。与 `discovery_candidates` 分离，避免把探索记录误当作待上架内容。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | Primary Key |
| `discovery_candidate_id` | uuid | NOT NULL, FK → `discovery_candidates.id` |
| `review_status` | text | NOT NULL；`pending` / `approved` / `rejected` |
| `editorial_notes` | text | nullable；人工审核意见 |
| `editorial_summary` | text | nullable；「讲了什么」Markdown |
| `editorial_why_worth_reading` | text | nullable；「为什么值得用心阅读」Markdown |
| `editorial_extra_info` | text | nullable；面向读者的「其他具体评估」Markdown |
| `reviewed_at` | timestamptz | nullable |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

- `UNIQUE(discovery_candidate_id)`；同一候选不重复进入审核队列。
- 常规路径每次最多 Direct 3 篇 + Topic 3 篇；自动或人工 Open 每次最多 3 篇。数量由 Workflow 校验，不通过数据库复杂 CHECK 实现。
- 人工触发 Open 后，新增 Run 和审核候选，不覆盖原有记录。
- In-depth Reads 以 `review_status = 'approved'` 作为上架与前台可见条件；`pending` / `rejected` 不可见。`approved` 改为 `rejected` 即撤下。标题和作者使用 Candidate 客观字段。
- 「完善介绍」独立保存到以上三个 TEXT 列；Generate 自动保存与 Save changes 写入同一组列，不覆盖 Candidate 原始 Agent 字段。非空 Editorial summary / why worth reading 优先于 Candidate 原字段；NULL / 空字符串按无覆盖处理。Editorial extra_info 缺失时返回空字符串，禁止回退到内部 `discovery_candidates.extra_info`。
- 管理 API 继续以 `editorialOverrides` 对象返回这三个值，仅作为传输结构，由查询从独立列组装；公开 API 字段名不变。
- 介绍、Notes、审核状态独立写入：介绍仅更新三列，Notes 仅更新 `editorial_notes`；只有审核操作改变 `review_status` / `reviewed_at`。均更新 `updated_at`，不维护版本历史。
- 本轮不改 `feedback`；明确要求长期记住的偏好由独立 Memory 流程处理。

### 11.5 `discovery_fetch_cache`

独立于 Candidate / Run 保存成功获取的原文，避免为同一规范化 URL 在不同运行重复保存大段正文；不建立 Candidate FK，读取时用已有 URL 规范化规则关联。Daily 已存全文仍以 `raw_articles.full_content_text` 为来源，不复制到 Cache。

| Field | Type | Constraint / Notes |
|---|---|---|
| `normalized_url` | text | Primary Key；规范化请求 URL，去追踪参数 / fragment、排序保留参数 |
| `normalized_final_url` | text | NOT NULL；索引；支持已知最终 URL 复用 |
| `original_url` / `final_url` | text | NOT NULL；最终 URL 使用抓取响应的 url / sourceURL，无时保留请求 URL |
| `fetched_at` | timestamptz | NOT NULL；实际取得内容时间 |
| `status` | text | NOT NULL，当前仅 `success`；失败 / 空正文不入表 |
| `markdown` | text | NOT NULL，非空；抓取返回的完整 Markdown，不存 Agent 截断副本 |
| `is_complete` | boolean | NOT NULL；与 Agent 交付截断状态独立；不完整响应不能作为完整正文复用 |
| `metadata` | jsonb | NOT NULL，默认 `{}`，必须为对象 |

`metadata` 只保留有用站点信息：title、description、author、publishedTime、sourceURL / url、HTTP 状态、站点 / publisher、OG / Twitter 图像及可得尺寸、语言和完整性提示；同次 HTML 的 meta 可补齐相应字段。`metadata.coverImage` 保存 Code 验证的优选封面。不保存大型 HTML、截图或整个原始 Firecrawl 响应。元数据缺失允许，不让模型生成来源或封面 URL。

同一规范化 URL 使用 UPSERT 更新，不维护正文版本历史；不完整结果不能覆盖已有完整正文。成功结果在工具返回前独立提交，后续 Agent / Candidate / Editorial 失败不回滚原文 Cache。并发和错误处理见 `04a-discovery-technical-spec.md` §4.3；部署 Migration 见 `09-operations.md`。

### 11.6 索引与实现边界

```text
discovery_runs(parent_run_id)
discovery_runs(status, started_at DESC)
discovery_trace_spans(run_id, started_at)
discovery_trace_spans(trace_id, span_id) UNIQUE
discovery_candidates(run_id, discovery_path)
discovery_candidates(run_id, source_lead_id)
discovery_candidates(normalized_url)
in_depth_candidates(discovery_candidate_id) UNIQUE
in_depth_candidates(review_status, created_at DESC)
```

当前实现边界：

1. **Implemented**：Daily 输入适配和 Trace 持久化已有代码；执行与技术边界分别见 `06a-discovery-workflow.md` 和 `04a-discovery-technical-spec.md`。Trace 列是业务持久化字段，不代表 SDK 提供完全相同字段。
2. **Implemented**：审核通过 Candidate → Run → Parent Run 关联，不额外建立审核批次表。上架及公开读取使用 §11.4 的审核状态，无需迁移到另一张内容库表。
3. **Planned**：单条 Lead 执行保留 §11.1 的字段和约束，不能据此认定已有 CLI / API / UI 支持。

## 12 Prompt Registry / Versions

`prompt_registry` 保存稳定唯一 key、kind（request / fragment）、workflow、step、request_type、display_name、active_version_id 与时间戳。`prompt_versions` 保存 UUID、registry_id、递增 version、draft / published、body JSONB、content_hash、source_commit、legacy_version、change_note、created_at。body 的明确 TypeScript / 校验形状见 `src/lib/prompts/contracts.ts`：System / User 可 null 或空，variants 为角色模板对象，fragments 为有序 slot / Version ID 列表。

- `(registry_id, version)` 唯一；首次基线导入将代码标签 `vN` 的 N 用作初始序号，没有旧标签则从 1 开始；后续 Draft 按该 Registry 当前最大序号加 1。已导入版本不因重跑导入而重新编号。版本 ID、所属 Registry、序号及创建时间不可修改。
- Active 由 Registry 指针确定；复合外键 `(active_version_id, id)` → `(version.id, version.registry_id)` 防跨 Registry 引用，Trigger 拒绝 Draft Active。
- Published 版本不可 UPDATE / DELETE；编辑派生新 Draft。历史 Published 可重新 Activate。Registry key / kind / ID 不可修改。
- Fragment 引用必须指向 Published Fragment；数据库 Trigger 拒绝不存在、指向 Request 或 Draft 的引用、重复 slot、嵌套引用。已发布目标不可删除。模板变量及占位顺序由应用层校验。
- Content Hash 为规范序列化 body 的 SHA-256，包含有序精确版本引用；加载校验完整性，不包含动态业务输入。导入 provenance 不参与文本 Hash。
- 新建版本和 Active 更新锁定对应 Registry 行；导入在单事务中串行执行，对已有任何版本的 Registry 不修改版本、元数据或 Active，避免覆盖后续人工编辑。无旧标签的 Prompt 保存 null，不虚构版本。

发布不可变、引用校验等 Trigger 由 `0021_prompt_registry.sql` 管理，不能只依赖 ORM Schema 推断其存在。

### 12.1 B3.2 版本绑定载体

- Daily Stage1–3：对应 `run.json.promptVersionIds` 保存 Request Key → 精确 UUID；`promptVersions` 保存同一映射的可读编号（如 `v5`），仅用于展示。Daily Orchestrator 同步汇总，不存 Prompt 文本。读取兼容此前仅有 UUID `promptVersions` 的文件；Resume 始终用 UUID，不能只凭 `vN` 恢复。`prompt_version` 等诊断展示字段写可读编号时，精确引用保留在 `prompt_version_id` / `promptVersionIds`。原 `legacy_prompt_version(s)` 仅为静态基线标签。
- Stage4：`stage4_runs.prompt_versions` 为权威，runtime JSON 只镜像；同一 Review snapshot 的 Run 唯一，Decision / Enrichment 分开存 UUID。
- Discovery：`discovery_runs.config_snapshot.promptVersions`，与既有 d2–d5 配置并存。
- Evaluation：同一 `evaluation_input_id` 的 `evaluation_runs.prompt_version` 保存同一个精确 UUID；已有字段为 text，无新列。
- Introduction / Manual Generate：`discovery_candidates.evaluation.promptVersions` 保存最近一次相应生成尝试的版本；不是跨 HTTP 请求 Resume 或完整历史。
- Put Back / Read More：`raw_articles.metadata.promptVersions`；Put Back 的失败重试复用文章已有绑定。
- Manual / Put Back 的同一 JSONB 下 `promptAttempt = {key, status}` 是短事务领取后的执行标记（running / completed / failed），防止释放事务后的重复付费。既有业务数据与其他 metadata 保留。进程硬退出留下 running 时不自动接管，恢复操作见 Operations。

除 Stage4 列外不新增业务字段、表或 Schema；JSONB 版本关联由服务层加载时验证所属 key、Published 状态、Hash 和精确 Fragment 引用。
