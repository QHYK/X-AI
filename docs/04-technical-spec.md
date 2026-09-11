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
- Events: Stage 4 published Events（默认最多 15）
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

数据库 Schema、表关系、字段约束与索引定义见：→ `./04a-data-model.md`

核心数据流：

sources
→ raw_articles
→ processed_contents
→ events

另外：
- event_review_items：Ranking Review snapshot
- feedback：人工反馈
- evaluation_*：Model Evaluation


---

## 4. Processing Workflow

Daily worlflow 的步骤、设计细节等相关说明见：→ `./04b-processing-workflow.md`

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
- Event cutoff 由 Stage 4 配置（默认 15），Long-form cutoff 为 10；跨入 cutoff 为 `false_negative`，跨出为
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

人工执行 `npm run eval:stage1`、`eval:stage2`、`eval:stage3:event`、`eval:stage3:digest` 或 `eval:stage3:long-form` 时，
Evaluation Service 先从 Production DB 或对应成功 Stage 3 runtime 构造一次 Frozen Input，随后才创建多个 Model Run。
Stage 1 保留当前 micro-batch 输入边界；同一 Daily 的成功 Stage 1 model runs 可跨不同
`evaluation_input_id` 以 `raw_article_id` 交集两两比较。Stage 2/3 仍要求相同 Frozen Input。
Stage 2 使用该 Daily 的已选 Event Candidates；
Stage 3 使用指定日期最近一次成功正式 Stage 3 runtime 中已经去重后的 Event、Digest 分类和 Long-form 输入。
所有模型读取同一 `evaluation_input_id`，但每个 Run 独立保存 success / failed、耗时、可用 token 和输出。
Evaluation 不启动或重跑任何正式 Job，不进入 Daily lineage，也不创建新的 runtime artifact。
`review/models` 通过薄 API 读取或手动触发这项 service；读取时固定选择最近一次
`evaluation_inputs`，只取该 input 下每个模型的最新 Run，禁止跨 input 比较。该 UI 为 Observation
工具，不修改任何 Production 表、Daily 结果或人工 Feedback；Stage 4 不参与。

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
= 前一天 08:30 <= raw_articles.published_at < 当天 08:30 (Asia/Shanghai)
```

- Digest / Long-form / Inspiration 通过 `processed_contents.daily_date` 归属；`published_at` 仍返回，
  但不再是最终展示归属，确保 late-arrival 能显示在其实际参与的 Daily。
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

Event items retain their existing `tags`, `tags_zh`, `entities`, and `entities_zh` fields.
Digest and Long-form items additionally expose `has_full_content`, derived from whether the
associated `raw_articles.full_content_text` is non-null and non-blank. The field never exposes
the full text itself; Inspiration and Event items do not expose it.

Original links：
- Event → API 通过 `processed_contents → raw_articles` 组装 `sources[]`
- Digest / Long-form / Inspiration → `url`

API 不创建 `daily_briefs` / `brief_items` snapshot；当前是实时 composition。

CORS 使用环境变量配置允许的 X-field origin。

### Read More API

```text
POST /api/content/read-more
{ "contentId": "processed_contents.id" }
```

The API only accepts Digest and Long-form content IDs. It joins to the associated Raw Article and
reads `full_content_text` server-side. If no non-blank full text exists, it returns
`{ "status": "not_available" }`; otherwise it uses the shared LLM client to return an on-demand
structured Chinese detailed summary. The original full text is never returned to the client.

The route is independent of `GET /api/brief`, has no cache or persistence, and makes no automatic
LLM retries. Provider or structured-output failures are logged server-side and return
`{ "status": "temporarily_unavailable" }` without affecting the Brief API.

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

OpenAI、DeepSeek / Kimi 的普通 Structured Output 调用使用各自 OpenAI-compatible Chat Completions API。
OpenAI Responses API 仅保留给 Stage 4 的实际 Web Search 路径；该路径由一次不持久化的
Stage 4 上下文需求判断触发，默认不搜索。
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
Stage 4 默认使用 Chat Completions 生成 Structured Output。仅当上下文需求判断确认现有 Source
不足以理解事件时，才使用 OpenAI Responses API `web_search` tool。
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

Orchestrator 固定本次 24 小时 Daily scope；Content Completion 与 Stage 1 另以 Daily end 为右边界
使用 72 小时 catch-up window。它将本次 Stage 1 run 明确传给 Stage 2、本次 Stage 2 run 明确传给
Stage 3、本次 Stage 3 run 明确传给 Stage 4，避免 Daily 依赖全局 latest runtime。显式 retry / backfill：

```bash
DAILY_DATE=2026-08-25 npm run daily
```

完成 Stage 4 后，`/api/brief` 可直接读取 publish-ready 数据。

未来：
```text
08:30 Asia/Shanghai Cron → Daily Workflow Orchestrator
```

---

## 9. Runtime Artifacts

`runtime/` 保存 Stage 1–4 的真实 input / output / mapping / run metadata，用于 Debug、Review、重跑边界。

`runtime/daily/.../run.json` 额外记录 `daily_date`、`timezone`、
`scope_start_at`、`scope_end_at`，以及本次 `content_completion_run`、`stage1_run`、`stage2_run`、
`stage3_run`、`stage4_run`，
同时保留各 step status / duration / failed_step。

它不是应用数据库，也不是长期业务 Source of Truth，并保持 Git ignored。

Stage 4 rebuild 使用 runtime artifacts 识别同一 `event_date` scope 的上一轮派生 Events。runtime artifacts 也用于 Debug、Review 和必要时的数据恢复分析；不要把它作为 Stage 间传递数据的正式接口。

Internal Dashboard 按 Asia/Shanghai 运行日期读取每天最新一次 Content Completion runtime，
展示 Completion success/selected、remaining backlog、duration，并在 Date Details 展示完整计数。
缺少 runtime 时显示 `N/A`，不从当前数据库状态反推历史指标。
