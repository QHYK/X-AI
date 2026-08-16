# X-AI-field

X-AI-field 是一个 AI 驱动的信息筛选系统。

系统从可信信息源持续收集财经、商业、科技和科学内容，通过 AI 完成内容理解、筛选、事件合并、排序、摘要和中文翻译，并生成一份帮助用户了解每天最重要的商业、科技和财经事件的中文 Daily Brief。

## Current Status

已完成：
- Product Spec
- AI Workflow Spec
- Prompt Spec
- Technical Spec
- Source List
- RSS ingestion spike
- Project Bootstrap
- PostgreSQL / Supabase / Drizzle setup and migrations
- Source List Import
- RSS Collector
- Content Completion for sparse RSS items
- Stage 1 Contract / LLM validation
- Stage 1 Batch Processing & Persistence
- Stage 2 — Event Merge, with runtime artifacts
- Stage 3 — Top N Event selection, exact dedup, Science publication enrichment, and Channel Ranking
- Stage 4 — Selected Event Enrichment

下一阶段：
- 实现 Daily Brief API 和基础页面
- 实现 Daily Brief composition / Top N presentation rules
- 增加 Review / feedback workflow

## Core Features

### Daily Brief

Daily Brief 包含四个部分：

- **Today's Events** — 合并不同媒体对同一重大事件的报道，并保留来源差异。
- **Source Digests** — 按来源整理当天值得关注的科技、商业和科学内容。
- **Long-form Reads** — 筛选值得投入时间认真阅读的深度内容。
- **Daily Inspiration** — 展示 xkcd、NASA Image of the Day 等轻量内容。

### AI Processing Pipeline

```text
Source Collection
        ↓
Raw Articles -> eligible ? complete:content
        ↓
Stage 1: Content Understanding & Selection
        ↓
Routing
        ↓
Event / Digest / Long-form / Inspiration
        ↓
Stage 2: Merge Events
        ↓
Stage 3: Channel Ranking
        ↓
Stage 4: Selected Event Enrichment
        ↓
Daily Brief
```

### Human Feedback

支持人工：
* 删除 False Positive
* 补充 False Negative
* 调整 Ranking
* 修改 Classification

人工反馈用于后续 Eval 和 Prompt 优化。

## Tech Stack
* Application: Next.js
* Language: TypeScript
* Database: PostgreSQL / Supabase
* ORM: Drizzle ORM
* AI: LLM + Structured Output
* Scheduling: Cron / Scheduled Job

MVP 使用单一 Next.js Application，不引入 Microservices、Message Queue、Workflow Engine 或复杂 Agent Framework。

## Local Development

### Requirements

* Node.js 20+
* npm
* PostgreSQL connection string, for example from Supabase

### Setup

```bash
npm install
cp .env.example .env.local
```

Update `.env.local` with the real database connection:

```bash
DATABASE_URL="postgresql://..."
DATABASE_SSL="true"
OPENAI_API_KEY="..."
OPENAI_BASE_URL="openai_url"
OPENAI_MODEL="gpt-5.4"
```

### Commands

```bash
npm run dev                              # Start the Next.js development server
npm run lint                             # Run ESLint
npm run typecheck                        # Run TypeScript type checking
npm run build                            # Build the Next.js app

npm run db:generate                      # Generate Drizzle migrations from src/db/schema.ts
npm run db:check                         # Validate Drizzle migration metadata
npm run db:migrate                       # Apply Drizzle migrations
npm run db:seed                          # Sync docs/05-source-list.md into the sources table

npm run collect:rss                      # Collect enabled RSS sources into raw_articles
npm run complete:content                 # 对 raw_articles.content_text 内容不足的文章补充正文
npm run process:stage1                   # Stage 1: process raw_articles from the last 24 hourspending raw_articles from the last 24 hours
npm run process:stage2                   # Stage 2: merge Event candidates and write runtime artifacts
npm run process:stage3                   # Stage 3: rank Events / Digest / Long-form and persist ranks
npm run process:stage4                   # Stage 4: enrich selected Events and persist events

npm run test:openai                      # Run one minimal model connectivity check
npm run test:stage3-persistence          # Validate Stage 3 display_rank protection rules
npm run test:stage4-event-date           # Validate deterministic event_date derivation
npm run test:stage4-persistence          # Validate Stage 4 rebuild / rollback persistence rules
```

Useful workflow environment controls:
```bash
STAGE1_LIMIT=20 npm run process:stage1
STAGE1_CONCURRENCY=2 npm run process:stage1
STAGE1_COLLECTED_WITHIN_HOURS=24 npm run process:stage1

STAGE3_EVENT_TOP_N=10 npm run process:stage3
STAGE4_CONCURRENCY=3 npm run process:stage4
```

Runtime/debug artifacts are written under `runtime/`, which is gitignored. The latest successful `runtime/stage4/<timestamp>/persistence.json` is used as the rebuild boundary for Stage 4 derived Events, so do not delete the latest successful Stage 4 runtime directory unless you intentionally want to reset that boundary.

### Updating Sources

1. 更新 `docs/05-source-list.md` 中的 CSV。
2. Run `npm run db:seed` to sync the `sources` table.
3. Run `npm run collect:rss` to collect RSS sources.
4. Run the workflow commands as needed: `collect:rss` → `complete:content` → `process:stage1` → `process:stage2` → `process:stage3` → `process:stage4`.

The source sync uses `Source + Collection Method` as the source identity, so URL changes update existing records.

## Documentation

项目设计以以下文档为准：
* `docs/01-product-spec.md` — 产品目标、Daily Brief 结构、Selection / Merge / Ranking 原则
* `docs/02-ai-workflow-spec.md` — AI Processing Stages
* `docs/03-prompt-spec.md` — LLM Input / Output 和 Prompt Guidelines
* `docs/04-technical-spec.md` — Architecture、Data Model、Workflow 和工程规范
* `docs/05-source-list.md` — 信息来源配置

## Engineering Principles
* KISS
* YAGNI
* LLM-first
* Rules only when necessary
* 优先解决真实 Failure，不提前设计复杂基础设施
