# What is X-AI-field

X-AI-field 是一个 AI 驱动的信息筛选系统：持续收集可信信息源，通过 AI
完成内容理解、筛选、事件合并、排序与事件补全，生成帮助用户了解每天最重要的财经、商业、科技和科学事件的中文 Daily Brief。

## Current Status

当前已形成完整可运行链路：

-   Source Collection / Content Completion
-   Stage 1--4 AI Processing
-   Daily Workflow Orchestrator
-   PostgreSQL Production Data
-   Daily Brief API & Page
-   Internal Dashboard
-   Human Review & Feedback
-   Manual Model Evaluation

## Daily Brief

Daily Brief 包含四个部分：

-   **Today's Events** --- 重大事件，多来源合并并保留来源差异
-   **Source Digests** --- 值得关注的分析、研究、科技、商业和科学内容
-   **Long-form Reads** --- 值得投入时间完整阅读的深度内容
-   **Daily Inspiration** --- xkcd、NASA Image of the Day 等轻量内容

具体产品定义与内容标准见
[`docs/01-product-spec.md`](docs/01-product-spec.md)。

## System Overview

``` text
Sources
  ↓
Collection → Exact Dedup → Content Completion
  ↓
Stage 1 — Understand / Select / Route
  ↓
Event / Digest / Long-form / Inspiration
  ↓
Stage 2 — Event Merge
  ↓
Stage 3 — Channel Ranking + Exact Dedup
  ↓
Stage 4 — Selected Event Enrichment
  ↓
PostgreSQL
  ↓
Daily Brief API / Dashboard
```

系统同时包含 Human Review 和独立的 Model Evaluation Workflow。

完整高层工作流见
[`docs/02-workflow-overview.md`](docs/02-workflow-overview.md)。

## Tech Stack

-   **Application:** Next.js + TypeScript
-   **DB:** PostgreSQL
-   **ORM:** Drizzle ORM
-   **AI:** OpenAI-compatible LLM providers, Structured Output, optional
    Web Search
-   **Content Retrieval:** RSS + Firecrawl
-   **Scheduling:** External Cron / Scheduled Job

MVP 保持单一 Next.js Application，不引入 Microservices、Message
Queue、Workflow Engine 或复杂 Agent Framework。

## Quick Start

``` bash
npm install
cp .env.example .env.local
npm run dev
```

数据库、LLM Provider、Firecrawl 等完整环境变量说明见
[`docs/09-operations.md`](docs/09-operations.md)。

## Core Commands

``` bash
npm run dev
npm run build
npm run start

npm run typecheck
npm run lint

npm run db:migrate
npm run db:seed

npm run daily
npm run daily -- --date=YYYY-MM-DD
```

独立 Stage、Evaluation、Regression Tests、Diagnostics、Backfill /
Recovery 等操作入口统一见
[`docs/09-operations.md`](docs/09-operations.md)。

## Documentation

项目采用 **One Fact, One Source of Truth**
具体规则只在其所属文档维护，其他文档只引用。

| Document | Responsibility |
|---|---|
| [`01-product-spec.md`](docs/01-product-spec.md)               | 产品目标、产品规则、Daily Brief 结构、内容与 Review |
| [`02-workflow-overview.md`](docs/02-workflow-overview.md)     | 系统高层工作流与主要模块关系 |
| [`03-ai-workflow-spec.md`](docs/03-ai-workflow-spec.md)       | Stage 1--4 AI Capability Semantic Contract |
| [`04-technical-spec.md`](docs/04-technical-spec.md)           | 技术架构、模块边界与稳定技术决策 |
| [`05-data-model.md`](docs/05-data-model.md)                   | Production / Review / Evaluation 数据模型 |
| [`06-processing-workflow.md`](docs/06-processing-workflow.md) | Production execution、Daily Scope、persistence、retry、lineage |
| [`07-prompt-spec.md`](docs/07-prompt-spec.md)                 | Application ↔ LLM Prompt / Structured Output Contract |
| [`08-source-list.md`](docs/08-source-list.md)                 | Source 配置 |
| [`09-operations.md`](docs/09-operations.md)                   | Commands、CLI、环境变量、测试、诊断与人工操作 |

Coding Agent 的工作方式与 Context Loading 规则见 [`AGENTS.md`](AGENTS.md)。

## Engineering Principles

KISS · YAGNI · LLM-first · Rules only when necessary · One Fact, One Source of Truth
