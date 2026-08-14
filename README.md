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

下一阶段：
- 建立 PostgreSQL / Drizzle Schema
- 实现 Source Collection
- 实现 Stage 1–3 AI Pipeline
- 实现 Daily Brief API 和基础页面

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
Raw Articles
        ↓
Stage 1: Content Understanding & Selection
        ↓
Routing
        ↓
Event / Digest / Long-form / Inspiration
        ↓
Stage 2: Event Understanding & Merge
        ↓
Stage 3: Prioritization
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
```

### Commands

```bash
npm run dev        # Start the Next.js development server
npm run lint       # Run ESLint
npm run typecheck  # Run TypeScript type checking
npm run build      # Build the Next.js app
npm run spike:rss  # Run the one-off RSS normalization spike
```

Task 0 only configures the database connection and Drizzle tooling. Business
tables and migrations will be added in the Database Schema task.

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
