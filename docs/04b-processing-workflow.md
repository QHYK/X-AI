# Processing Workflow

## 4.1 Daily Workflow

每天执行一次完整 Daily Workflow。
触发时间：
```text
08:30 Asia/Shanghai
```

每个 Daily 使用固定的 `raw_articles.published_at` 半开区间，Daily 日期对应区间结束的
08:30 boundary。例如：

```text
Daily 2026-08-25
= 2026-08-24 08:30 <= published_at < 2026-08-25 08:30 (Asia/Shanghai)
```

Orchestrator 启动时只计算一次 scope；默认选择最近一个已经结束的 08:30 boundary。
`DAILY_DATE=YYYY-MM-DD npm run daily` 可显式选择相同 scope 进行 retry / backfill。
`published_at` 决定新闻属于哪一期 Daily；`collected_at` 只记录系统何时采集。
因此 late retry / backfill 不改变 Daily membership，`published_at IS NULL` 的文章不进入任何 Daily scope。
Orchestrator 通过 `DAILY_PUBLISHED_SCOPE_START_AT` / `DAILY_PUBLISHED_SCOPE_END_AT`
传递范围；旧 `DAILY_SCOPE_START_AT` / `DAILY_SCOPE_END_AT` 仅保留为部署兼容 alias。

只设置一个 Cron Trigger。
```text
Cron 08:30
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

## 4.2 Collection

根据 `sources.collection_method` 使用不同 Collector Adapter。
```js
collectRSS(source)
collectEmail(source)
collectWeb(source)
```
不同 Collector 最终统一输出标准化 `Raw Article`。

### RSS Collector
当前正式实现
```text
Source → RSS fetch → normalize → deduplicate → raw_articles
```

### Email Collector

Newsletter Email 不假设“一封邮件等于一篇文章”。
允许：
```text
1 Email
   ↓
1..N Raw Articles
```
不同 Newsletter 可通过轻量 Adapter 处理。
MVP 不建立通用复杂 Newsletter Parser。

### Web Collector

仅用于明确没有 RSS / Email，但仍需要采集的来源。
Web Collector 应尽量输出与 RSS Collector 相同的标准 Raw Article 结构。

## 4.3 Content Completion
正文不足时执行
```text
raw_articles → need completion? → Firecrawl scrape → extract Stage 1 input → update content_text
```

如果：
```text
content_text is null / empty
```
且存在有效 `url`：
```text
use Firecrawl `/v2/scrape` to request Markdown
    ↓
extract article-relevant Markdown (Abstract / Takeaways / Key Points / Summary / body)
    ↓
update raw_articles.content_text and content_completion metadata
```
该步骤只补足 Stage 1 理解所需内容，不调用 LLM。原始 Firecrawl Markdown 只保存在 runtime；
只有清洗后的长且完整正文具备后续详情复用价值时，才写入 `full_content_text`，且 Stage 1 不读取它。

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

Daily Workflow 的 Content Completion 使用 `daily_end - 72 hours <= published_at < daily_end`
的 catch-up window，以涵盖延迟进入 RSS 的文章；runtime 的 `scope_start_at` /
`scope_end_at` 记录这一实际窗口。Daily Scope 本身仍保持 24 小时。

## 4.4 Deduplication
区分两类重复。

### Exact Duplicate

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

在 Collection 后、Content Completion 前，系统还会在当前 Daily scope 的 pending Raw Articles
中标记跨 RSS Channel 的 exact duplicate：trim 后 URL 相同或 title 相同即视为重复。
winner 依次取现有 `content_text` 较长、`source.name` 较长、较早 `created_at`、较小 id；loser 保留
Raw Article，但写为 `stage1_status = ignored` 且 `processing_error = 'duplicate'`。

### Same Event Across Different Sources
例如：
```text
Reuters: Fed ...
Bloomberg: Fed ...
FT: Fed ...
```
保留全部内容，并在 Stage 2 进行 Merge Events。

## 4.5 Stage 1

只处理最近 workflow window 内 `stage1_status IN ('pending', 'failed')` 的 Raw Articles。

Daily Workflow 使用以本次 `daily_end` 倒推 72 小时的 `raw_articles.published_at` catch-up window；
单独运行 Stage 1 时使用基于 `published_at` 的最近 24 小时默认窗口。

Stage 1 对普通文章使用小型 micro-batch，但每篇 Raw Article 仍独立判断；较大的 input 可以单独处理。
默认 batch 为 15 篇、单篇 20,000 characters、总计 60,000 characters；超限和 Long-form 仍单篇处理。
多篇 batch 在既有 LLM retry 耗尽后按原顺序递归二分，只有失败子集继续拆分至 singleton。
每次运行保存 `runtime/stage1/<run-id>/batches/*.input.json`、`attempts.jsonl` 与 `summary.json`。
```text
Raw Article → LLM → Ignore / Event / Digest / Long-form / Inspiration
```

Ignore: `raw_articles.stage1_status = ignored` 不创建 `processed_contents`
Selected: `raw_articles.stage1_status = selected` 创建对应 `processed_contents`
，并写入本次 workflow 的 `daily_date`。该字段表示内容实际参与的 Daily，不等同于
`raw_articles.published_at`；因此当前 Daily 的 72 小时 catch-up 中首次选中的 late-arrival 仍归入当前 Daily。
Failed：
```js
raw_articles.stage1_status = failed
processing_error = ...
```

## 4.6 Stage 2

Stage 1 全部可处理内容完成后触发 Stage 2。
读取目标 `processed_contents.daily_date` 下全部 Event Candidates；候选必须同时满足
`routing = event` 与 `raw_articles.stage1_status = selected`。Stage 1 runtime lineage 仅保留供 debug，
不作为 Stage 2 的业务筛选条件。

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

## 4.7 Stage 3

Stage 2 完成后主动触发 Stage 3。
Stage 3 分阶段执行。

Digest / Long-form 候选按目标 `processed_contents.daily_date` 全量读取，并保留
`raw_articles.stage1_status = selected` 条件。Event Ranking 从正式 `event_groups` / `event_group_items` 读取；runtime 仅供 debug 与 lineage。重跑同一
Daily 会重新计算 `ai_rank`，但保持既有 `display_rank` 保护规则。

```text
Event Groups
  ↓
Event Ranking
  ↓
DB Event Top 50 Review Snapshot
  ↓
完整 Review Snapshot（Stage 3 不选择 Stage 4 数量）
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
- Event 完整 Top 50 rank 先写入新的 DB Review snapshot；Stage 4 决定最终处理数量。

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

## 4.8 Stage 4

Stage 3 完成后主动触发 Stage 4。
从目标 `daily_date` 最新 Review snapshot 按 `display_rank` 取前 N（默认 15），每个 Event 独立调用 LLM。

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
- 每条成功 enrichment 立即写入 draft Event；draft 不修改 `processed_contents.event_id`。
- `expected_count = min(N, snapshot 可用 Event 数量)`。全部 draft 完成后，短事务归档同一 `stage4_runs.daily_date` 的旧 published Events、发布新 drafts，并切换 `processed_contents.event_id`。
- API 只读取 published Events；partial retry 的 drafts 不影响线上旧版。

Stage 4 完成后：
1. 写入 `events`
2. 将组成该 Event 的 Event Candidates 回写 `processed_contents.event_id`
3. 保存最终 Event rank / display_rank
不创建 `event_articles`。
