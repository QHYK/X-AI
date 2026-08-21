# X-AI-field

X-AI-field 是一个 AI 驱动的信息筛选系统：持续收集可信信息源，通过 AI 完成理解、筛选、事件合并、排序、摘要和事件补全，并生成一份帮助用户了解每天最重要的财经、商业、科技和科学事件的中文 Daily Brief。

## Current Status

已完成：
- Product / AI Workflow / Prompt / Technical Spec
- Source List
- Project Bootstrap / PostgreSQL / Supabase / Drizzle persistence
- RSS Collector / Content Completion
- Stage 1 - Content Understanding & Selection
- Stage 2 - Event Merge
- Stage 3 - Channel Ranking + Exact Dedup
- Stage 4 — Selected Event Enrichment + Optional Web Search
- Daily Workflow Orchestrator
- Daily Brief API `GET /daily-brief?date=YYYY-MM-DD`
- Internal Dashboard `/dashboard`

下一步：
- X-field Daily Brief 页面
- 09:00 Asia/Shanghai Cron
- 增加 Review / feedback workflow

## Daily Brief

Daily Brief 包含四个部分：

- **Today's Events** — 重大事件，多来源合并并保留来源差异
- **Source Digests** — 按 Category 排序值得关注的科技、商业和科学内容
- **Long-form Reads** — 值得投入时间完整阅读的深度内容
- **Daily Inspiration** — xkcd、NASA Image of the Day 等轻量内容

## AI Processing Pipeline

```text
RSS Sources
    ↓
Collection → Content Completion
    ↓
Stage 1 - Understand / Select / Route
    ↓
Event / Digest / Long-form / Inspiration
    ↓
Stage 2 - Merge Event Candidates
    ↓
Stage 3 - Channel Ranking + Exact Dedup
    ↓
Top Events → Stage 4 - Event Enrichment (+ optional Web Search)
    ↓
PostgreSQL
    ↓
Daily Brief API
```

完整工作流见 `docs/06-workflow-overview.md`。

当前正式 provider routing：

| Stage | Provider |
| --- | --- |
| Stage 1 | OpenAI |
| Stage 2 | DeepSeek |
| Stage 3 | OpenAI |
| Stage 4 | OpenAI |

## Human Feedback

支持人工：
* 删除 False Positive
* 补充 False Negative
* 调整 Ranking
* 修改 Classification

人工反馈用于后续 Eval 和 Prompt 优化。

## Tech Stack
* App: Next.js + TypeScript
* DB: PostgreSQL / Supabase
* ORM: Drizzle ORM
* AI: OpenAI Responses API、DeepSeek OpenAI-compatible API、Structured Output、optional Web Search
* Scheduling: Cron / Scheduled Job

MVP 使用单一 Next.js Application，不引入 Microservices、Message Queue、Workflow Engine 或复杂 Agent Framework。

## Local Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

核心环境变量：

```bash
DATABASE_URL="postgresql://..."
DATABASE_SSL="true"
STAGE1_LLM_PROVIDER="openai"
STAGE2_LLM_PROVIDER="deepseek"
STAGE3_LLM_PROVIDER="openai"
STAGE4_LLM_PROVIDER="openai"
OPENAI_API_KEY="..."
OPENAI_BASE_URL="..."
OPENAI_MODEL="gpt-5.4"
# DEEPSEEK_API_KEY="..."
# DEEPSEEK_MODEL="deepseek-v4-pro"
# KIMI_API_KEY="..."
# KIMI_MODEL="kimi-k3"
```

### Main Commands

```bash
npm run dev                              # Next.js dev server
npm run lint
npm run typecheck
npm run build                            # Build the Next.js app

npm run db:generate                      # Generate Drizzle migrations from src/db/schema.ts
npm run db:migrate                       # Apply Drizzle
npm run db:check                         # 检查 Drizzle migration 一致性
npm run db:seed                          # Sync docs/05-source-list.md → sources

npm run daily                            # Run the complete daily pipeline.
npm run collect:rss                      # RSS sources → `raw_articles`
npm run complete:content                 # rss.content_text 内容不足的补充正文
npm run process:stage1                   # Stage 1: Process the last 24 hours Raw Articles
npm run process:stage2                   # Stage 2: Merge Event and write runtime intermediate data
npm run process:stage3                   # Stage 3: Channel rank, exact dedup and persist
npm run process:stage4                   # Stage 4: enrich Events and persist events

#### Tests and Diagnostics
# npm run test:stage3-persistence          # Validate Stage 3 display_rank protection rules
# npm run test:stage4-event-date           # Validate deterministic event_date 推导
# npm run test:stage4-persistence          # 验证 Stage 4 跨日 append、同日 rebuild 和 rollback
npm run test:openai                      # Structured-output provider smoke testsmoke test
npm run test:deepseek
npm run test:kimi

npm run recover:stage4-events:dry-run      # 只读分析 Stage 4 runtime 与数据库，输出可恢复候选，不写库

常用运行参数：

```bash
STAGE1_LIMIT=20 npm run process:stage1
STAGE1_CONCURRENCY=2 npm run process:stage1
STAGE3_EVENT_TOP_N=10 npm run process:stage3
STAGE4_CONCURRENCY=3 npm run process:stage4
```
`runtime/` 保存运行时 input/output/debug artifacts，并被 Git 忽略。
Stage 4 persistence 会使用最近一次成功 runtime artifacts 识别同一 `event_date` scope 的上一轮输出，因此不要随意删除仍参与 rebuild/recovery 的 Stage 4 runtime 目录。

### Production

```bash
npm run build
npm run start
```

当前不内置 Cron。部署环境可由外部 scheduler 在 `09:00 Asia/Shanghai` 触发 `npm run daily`。

### Updating Sources

1. 更新 `docs/05-source-list.md`。
2. 执行 `npm run db:seed` sync `sources`.
3. 需要立即采集RSS时执行 `npm run collect:rss`.
4. 顺序执行 `collect:rss` → `complete:content` → `process:stage1` → `process:stage2` → `process:stage3` → `process:stage4`.

Use `Source + Collection Method` as the source identity, so URL changes update existing records.

## Daily Brief API

```text
GET /daily-brief?date=YYYY-MM-DD
```

返回：
- `events` — Top 10
- `digests` — 按 Category 分组，返回全部已排序内容
- `long_form` — Top 10
- `inspiration`
- `meta`

所有可阅读内容都返回原文链接。MVP 使用 `created_at`（Asia/Shanghai）作为 Brief 日期归属依据。

## Internal Dashboard

启动 `npm run dev` 后访问：

```text
http://localhost:3000/dashboard
```

- 页面需要可用的 `DATABASE_URL`，默认展示最近 7 天的数据量与 Daily Workflow 运行情况。
- 数据库是业务数据 Source of Truth；所有每日统计按 `Asia/Shanghai` 日期边界计算。
- `runtime/stage1~4/` 只补充运行指标，例如 LLM calls、retry、实际记录的 token、duration、Stage 2/3/4 的中间与结果数量。
- 某个字段没有时显示 `N/A`，不会估算或写入新的 metrics 数据。

## Documentation

- `docs/01-product-spec.md` — 产品目标与内容标准
- `docs/02-ai-workflow-spec.md` — 四个 AI Stage 的职责
- `docs/03-prompt-spec.md` — LLM Input / Output / Prompt Guidelines
- `docs/04-technical-spec.md` — 架构、数据、Workflow 与工程约束
- `docs/05-source-list.md` — Source 配置
- `docs/06-workflow-overview.md` — 完整项目工作流

## Engineering Principles
* KISS · YAGNI · LLM-first · Rules only when necessary
