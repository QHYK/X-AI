# Discovery 数据模型

Run、Trace、候选、审核队列与正文 Cache 均已有 Schema / Migration；`single_lead` 只预留数据结构，执行入口仍为 Planned。总体关联见 [Data Model](README.md)，Workflow 见 [Discovery Workflow](../06-workflow-spec/discovery.md)。字段表中的业务取值不自动等同于数据库 CHECK，以下各表单独列出数据库约束。UUID 主键与时间戳默认值沿用 [Daily 公共说明](daily.md)，Fetch Cache 除外。列出的 btree 索引未注明 DESC 时为 Schema 默认 ASC，查询的 ORDER BY 不等同于索引定义。

## `discovery_runs`

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
| `input_content_ids` | jsonb | nullable；实际送入 Topic Selection 的 Daily 内容 ID 列表（键为 event / digest / longForm，各元素为 `{dailyDate, id}`），不复制正文 |
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
  - `single_lead`：`parent_run_id` 与 `source_lead_id` 均为 NOT NULL；父 Run 类型及 Lead 归属是应用约束，不是该组合 CHECK 的验证内容。
  - `open`：`source_lead_id` 为 NULL；人工补充执行时 `parent_run_id` 为 NOT NULL，并由应用确认指向原 `regular` Run，并保存继承的 `window_start_date` / `window_end_date`。自动 Fallback Open 作为 `regular` Run 的内部阶段执行，不创建 `run_type = 'open'` 的子 Run。
- 使用 CHECK 约束上述空值组合：`regular` 只能是无父 Run，`single_lead` 必须同时提供父 Run 和 Lead，独立的 `open` Run 必须提供父 Run 且不能提供 Lead。
- `CHECK(parent_run_id IS NULL OR parent_run_id <> id)` 防止 Run 自引用；父 Run 的类型与 Lead 归属由应用层验证。
- 日期字段记录**计划输入窗口**，不从实际执行时间推导；`input_content_ids` 记录当次选入的 Event / Digest / Long-form 内容成员 ID，避免复制 Daily 正文。当前没有 `input_snapshot`，不得将成员 ID 记录视为完整模型输入文本快照。
- 上游 Daily 未就绪可记录 `blocked` 和 `upstream_not_ready`，不冒充已完成 Discovery。
- `source_lead_id` 对应应用生成并保存的 D2 Lead ID；Planned 单条执行的技术边界见 `../04-technical-spec/discovery.md` §6.3。
- **Planned**：单条 Lead 执行入口实现后，各 Lead 的执行状态及关联结果通过 Run 的 `selection_output`、关联的 `single_lead` Run 和候选记录查询计算，不新增 Lead 表或冗余状态字段。
- 自动 / 人工 Open、分支失败与 Resume 的执行语义见 `../06-workflow-spec/discovery.md` §6、§8。
- `status` 与 `end_reason` 分开：例如 `partial + timeout`、`completed + candidates_found` 与 `completed + no_candidates` 的业务含义不同；`end_reason` 只在运行结束时填写。
- `execution_state` 的数据库 CHECK 仅要求 JSON 对象；以下嵌套字段由应用定义和校验。已执行阶段以 `d2` / `d3` / `d4` / `d5` 键保存 `status`、`endReason`、`completedAt`、错误摘要、Provider / Model / API mode、累计 `elapsedMs` 与 `usage`；更新单个阶段时不得覆盖其他阶段。`running` 或字段缺失均不表示完成，历史 Run 不从缺失状态推断成功。D3 / D5 正常空结果也写入对应 `status = 'completed'` 与 `endReason = 'no_candidates'`，供 Resume 作确定性判断。
- `usage` 包含 `requests`、`inputTokens`、`outputTokens`、`cachedInputTokens` 与 `usageComplete`。缓存输入已包含在输入 Token 内，不得再次加到总 Token；Provider 未返回某字段使用 `null`，任一请求缺失完整 Usage 时 `usageComplete = false`。缓存命中率是读取端派生指标（`cachedInputTokens / inputTokens`），不持久化；统计不完整时不得展示为完整命中率。

- 队列提交标记为 `config_snapshot.dashboardJob.requestId`；Dashboard 为随机标识，Scheduled 为 `discovery:scheduled:YYYY-MM-DD`（上海业务日期），`trigger_source` 使用 `schedule`。它不是独立任务表，也没有 Request ID 唯一索引；提交幂等、窗口互斥及 Worker 消费边界见 [Discovery Technical Spec](../04-technical-spec/discovery.md#71-dashboard-持久化异步执行)。
- 审核候选计数为通过 `discovery_candidates.run_id = discovery_runs.id` 关联的 `in_depth_candidates` 行数，包括提交后已 Approved / Rejected 的行；不是发现数或 Approved 数。普通 Run 与 Open Run 分别统计自己的新增审核候选。

`config_snapshot.dashboardJob.d2RetryRequestIds` 保存同 Run D2 Retry 请求标识数组，原 `requestId` 保留；这些 JSONB 键没有 UNIQUE / FK 或数据库结构 CHECK，幂等依赖提交服务。`config_snapshot.promptVersions` 见 [版本绑定载体](prompt-registry.md#版本绑定载体)。

`status` / `end_reason` 的允许值分别有 CHECK，但数据库不强制二者组合、Lead 数量或父 Run 类型，也没有同窗口唯一索引。

### 索引与数据库约束

- `discovery_runs_parent_run_id_idx`：INDEX (`parent_run_id`)。
- `discovery_runs_status_started_at_idx`：INDEX (`status, started_at`)。
- FK (`parent_run_id`) → `discovery_runs` (`id`)，ON DELETE `NO ACTION`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- discovery_runs_type_check
CHECK ("run_type" in ('regular', 'single_lead', 'open'));
-- discovery_runs_trigger_source_check
CHECK ("trigger_source" in ('schedule', 'manual'));
-- discovery_runs_status_check
CHECK ("status" in ('pending', 'running', 'completed', 'partial', 'failed', 'blocked'));
-- discovery_runs_end_reason_check
CHECK ("end_reason" is null or "end_reason" in ('candidates_found', 'no_candidates', 'timeout', 'budget_exhausted', 'upstream_not_ready', 'error'));
-- discovery_runs_relationship_check
CHECK (( ("run_type" = 'regular' and "parent_run_id" is null and "source_lead_id" is null) or ("run_type" = 'single_lead' and "parent_run_id" is not null and "source_lead_id" is not null) or ("run_type" = 'open' and "parent_run_id" is not null and "source_lead_id" is null) ));
-- discovery_runs_parent_not_self_check
CHECK ("parent_run_id" is null or "parent_run_id" <> "id");
-- discovery_runs_window_check
CHECK (("window_start_date" is null and "window_end_date" is null) or ("window_start_date" is not null and "window_end_date" is not null and "window_start_date" <= "window_end_date"));
-- discovery_runs_execution_state_object_check
CHECK (jsonb_typeof("execution_state") = 'object');
```

## `discovery_trace_spans`

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
- Processor 生命周期、失败隔离和 Usage 采集见 [Discovery Technical Spec](../04-technical-spec/discovery.md#61-trace-与-usage-的失败边界)；不由此表推导业务完成状态。

### 索引与数据库约束

- `discovery_trace_spans_run_started_idx`：INDEX (`run_id, started_at`)。
- `discovery_trace_spans_trace_span_unique`：UNIQUE (`trace_id, span_id`)。
- FK (`run_id`) → `discovery_runs` (`id`)，ON DELETE `CASCADE`。

## `discovery_candidates`

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
| `title_zh` | text | nullable；中文标题，来自 D3 / D4 / D5 或 Manual Generate；历史可为空 |
| `author` | text | nullable |
| `publication` | text | nullable；作品发布来源；各路径共用归一化规则，见 `../04-technical-spec/discovery.md` §5.1 |
| `content_type` | text | nullable；`article` / `video` / `podcast` |
| `published_at` | timestamptz | nullable |
| `estimated_duration_minutes` | integer | nullable |
| `summary` | text | nullable；中文内容概要，来自 D3 / D4 / D5 或 Manual Generate |
| `why_worth_reading` | text | nullable；中文推荐理由，来自 D3 / D4 / D5 或 Manual Generate |
| `extra_info` | jsonb | NOT NULL，默认 `{}`；D3 / D4 / D5 的非固定结构补充信息，仅接受 JSON 对象 |
| `evidence` | jsonb | nullable；实际阅读来源、正文获取程度、引用证据、局限 |
| `evaluation` | jsonb | nullable；编辑判断、入选或淘汰理由 |
| `status` | text | NOT NULL；`discovered` / `evaluated` / `selected` / `rejected` / `unverifiable` |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

- 一篇作品可在不同 Run 或不同路径中再次发现，不设置全局 URL UNIQUE；在**同一次审核汇总**时由 Code 进行去重。
- `source_content_type` 与 `source_content_id` 使用组合 CHECK：`(source_content_type IS NULL AND source_content_id IS NULL) OR (source_content_type IN ('event', 'processed_content') AND source_content_id IS NOT NULL)`，应用要求二者同时为空或同时有效：
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
- manual 候选初始 `status = discovered`，直接创建 pending 审核记录；生成后为 evaluated，不写入 D4 decision。`evaluation.tags` 保存人工或模型 Tags，`manualTags` 标记是否有人工标签，`manualGenerated` 标记已完成生成；正文通过关联 URL 读取既有 Fetch Cache / Daily。`evidence` 只保存抓取诊断、来源与 Cover，不伪造机器筛选证据。Generate 同时保存 `title_zh`、`summary`、`why_worth_reading` 及 [in_depth_candidates](#in_depth_candidates) 三段 Editorial；人工修改继续只更新 Editorial，原始生成介绍保留。Migration `0019` 放宽 Run 必填并增加 manual 路径及对应 CHECK，历史记录不回填或重写。
- D3 / D4 / D5 的 `title_zh`、`summary`、`whyWorthReading` 分别映射为已有列 `title_zh`、`summary`、`why_worth_reading`。D4 的 `decision` / `reason` 保存于 `evaluation`，内容证据 / `limitations` 保存于 `evidence`，不挪作读者介绍。历史 Direct 未生成介绍时允许 NULL，不重写历史输出。归一化后的 Source 写入已有 `publication`；Topic / Open 的 Fetch 来源元数据随 `evidence.fetch.metadata.publication` 保存，Direct 可用元数据摘要保存在 `evidence.sourceMetadata.publication`。这些字段映射复用既有列；独立原文 Cache 见 [discovery_fetch_cache](#discovery_fetch_cache)。
- D3 / D4 / D5 的 `extra_info` 统一保存于 `extra_info` JSONB；缺失时规范化为 `{}`，只允许 JSON 对象，禁止数组、字符串等非对象值。应用层应限制序列化大小并过滤敏感、重复、无关内容；`extra_info` 不得替代固定字段、证据或业务校验。
- `evidence` 保存实际获取的内容证据及其来源，不把 Agent 的自然语言声明当成已阅读证据。
- `evaluation.tags` 保存最终内容评价生成的双语标签：`[{ "zh": "科学方法", "en": "Scientific Method" }]`，最多 3 对，每对中英文均非空；按任一语言名称去重，历史缺失按空数组读取。它是评价的固定键，不写入自由补充字段 `extra_info`。
- Cover 复用 `evidence` JSONB：Direct 使用 `evidence.coverImage`，Topic / Open 使用实际 Fetch 摘要中的 `evidence.fetch.coverImage`，不重复保存。值为 `{ url, source, width, height }` 或 `null`；`source` 为 `og:image` / `twitter:image` / `article` / `raw_article`，尺寸为可获得的正整数，否则为 `null`。它只来自 Code 验证的抓取或已有来源元数据，不接受模型输出的图片。历史缺失按无图片读取。无独立 Tags / Cover 列，历史缺失保持兼容。
- 若某篇作品由多个路径发现，可在 `topic_context` / `evidence` 中保留额外来源关联；首版不增加候选来源关系表。

**数据库边界**：PostgreSQL CHECK 接受 UNKNOWN；现有 source CHECK 在 `source_content_type IS NULL` 且 `source_content_id IS NOT NULL` 时仍可通过。不能把应用要求的“双空 / 双非空”描述为数据库完全保证；本次只记录，不修改约束。

Tags 数量、双语完整性与去重、Cover URL / 尺寸、Lead 归属和文本长度均是应用校验，不是 JSONB 字段的数据库 CHECK。

### 索引与数据库约束

- `discovery_candidates_run_path_idx`：INDEX (`run_id, discovery_path`)。
- `discovery_candidates_run_lead_idx`：INDEX (`run_id, source_lead_id`)。
- `discovery_candidates_normalized_url_idx`：INDEX (`normalized_url`)。
- FK (`run_id`) → `discovery_runs` (`id`)，ON DELETE `CASCADE`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- discovery_candidates_path_check
CHECK ("discovery_path" in ('direct', 'topic', 'open', 'manual'));
-- discovery_candidates_run_check
CHECK (("discovery_path" = 'manual' and "run_id" is null) or ("discovery_path" <> 'manual' and "run_id" is not null));
-- discovery_candidates_source_check
CHECK (( ("source_content_type" is null and "source_content_id" is null) or ("source_content_type" in ('event', 'processed_content') and "source_content_id" is not null) ));
-- discovery_candidates_lead_check
CHECK (( ("discovery_path" in ('direct', 'topic') and "source_lead_id" is not null) or ("discovery_path" in ('open', 'manual') and "source_lead_id" is null) ));
-- discovery_candidates_content_type_check
CHECK ("content_type" is null or "content_type" in ('article', 'video', 'podcast'));
-- discovery_candidates_status_check
CHECK ("status" in ('discovered', 'evaluated', 'selected', 'rejected', 'unverifiable'));
-- discovery_candidates_extra_info_object_check
CHECK (jsonb_typeof("extra_info") = 'object');
```

## `in_depth_candidates`

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
- 候选提交数量由 `../06-workflow-spec/discovery.md` 定义，不通过数据库复杂 CHECK 实现。
- 人工触发 Open 后，新增 Run 和审核候选，不覆盖原有记录。
- In-depth Reads 以 `review_status = 'approved'` 作为上架与前台可见条件；`pending` / `rejected` 不可见。`approved` 改为 `rejected` 即撤下。标题和作者使用 Candidate 客观字段。
- 「完善介绍」独立保存到以上三个 TEXT 列；Generate 自动保存与 Save changes 写入同一组列，不覆盖 Candidate 原始 Agent 字段。非空 Editorial summary / why worth reading 优先于 Candidate 原字段；NULL / 空字符串按无覆盖处理。Editorial extra_info 缺失时返回空字符串，禁止回退到内部 `discovery_candidates.extra_info`。
- 管理 API 继续以 `editorialOverrides` 对象返回这三个值，仅作为传输结构，由查询从独立列组装；公开 API 字段名不变。
- 介绍、Notes、审核状态独立写入：介绍仅更新三列，Notes 仅更新 `editorial_notes`；只有审核操作改变 `review_status` / `reviewed_at`。均更新 `updated_at`，不维护版本历史。
- 历史 `editorial_overrides` 已由 Migration `0018` 回填到三列后删除，不再是存储字段；API 对象不是 JSONB 列。Editorial 三列没有数据库文本长度、Markdown 或中文 CHECK。

### 索引与数据库约束

- `in_depth_candidates_candidate_unique`：UNIQUE (`discovery_candidate_id`)。
- `in_depth_candidates_review_created_idx`：INDEX (`review_status, created_at`)。
- FK (`discovery_candidate_id`) → `discovery_candidates` (`id`)，ON DELETE `CASCADE`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- in_depth_candidates_review_status_check
CHECK ("review_status" in ('pending', 'approved', 'rejected'));
```

## `discovery_fetch_cache`

独立于 Candidate / Run 保存成功获取的原文，避免为同一规范化 URL 在不同运行重复保存大段正文；不建立 Candidate FK，读取时用已有 URL 规范化规则关联。Daily 已存全文仍以 `raw_articles.full_content_text` 为来源，不复制到 Cache。

| Field | Type | Constraint / Notes |
|---|---|---|
| `normalized_url` | text | Primary Key；规范化请求 URL，去追踪参数 / fragment、排序保留参数 |
| `normalized_final_url` | text | NOT NULL；索引；支持已知最终 URL 复用 |
| `original_url` | text | NOT NULL；请求 URL |
| `final_url` | text | NOT NULL；最终 URL 使用抓取响应的 url / sourceURL，无时保留请求 URL |
| `fetched_at` | timestamptz | NOT NULL；实际取得内容时间 |
| `status` | text | NOT NULL，当前仅 `success`；失败 / 空正文不入表 |
| `markdown` | text | NOT NULL，非空；抓取返回的完整 Markdown，不存 Agent 截断副本 |
| `is_complete` | boolean | NOT NULL；与 Agent 交付截断状态独立；不完整响应不能作为完整正文复用 |
| `metadata` | jsonb | NOT NULL，默认 `{}`，必须为对象 |

`metadata` 只保留有用站点信息：title、description、author、publishedTime、sourceURL / url、HTTP 状态、站点 / publisher、OG / Twitter 图像及可得尺寸、语言和完整性提示；同次 HTML 的 meta 可补齐相应字段。`metadata.coverImage` 保存 Code 验证的优选封面。不保存大型 HTML、截图或整个原始 Firecrawl 响应。元数据缺失允许，不让模型生成来源或封面 URL。

同一规范化 URL 使用 UPSERT 更新，不维护正文版本历史；不完整结果不能覆盖已有完整正文。成功结果正常在工具返回前独立提交；若 Cache 写入失败，已取得正文可携带 warning 返回，不能声称已经持久化。后续 Agent / Candidate / Editorial 失败不回滚已提交的 Cache。并发和错误处理见 `../04-technical-spec/discovery.md` §4.3；部署 Migration 见 `../09-operations.md`。

此表无 `created_at` / `updated_at`，最终 URL 仅普通索引，不是唯一键；没有 Candidate / Run 外键。

### 索引与数据库约束

- `discovery_fetch_cache_final_url_idx`：INDEX (`normalized_final_url`)。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- discovery_fetch_cache_success_check
CHECK ("status" = 'success' and length(trim("markdown")) > 0);
-- discovery_fetch_cache_metadata_object_check
CHECK (jsonb_typeof("metadata") = 'object');
```
