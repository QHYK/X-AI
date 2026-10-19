# X-AI-field Technical Spec

本文档定义 X-AI-field 当前的技术架构、系统边界、模块职责与稳定工程约束。

---

## 1. System Architecture

MVP 采用简单的三层架构：

```text
Data Layer → Processing Layer → Presentation Layer
```

MVP 保持单一 Next.js + PostgreSQL 应用，不引入微服务、Queue 或 Workflow Engine。Discovery 使用限定范围的单 Agent SDK；与 Daily Processing 是两个独立任务。Daily 执行规则见 `06-processing-workflow.md`，Discovery 执行规则见 `06a-discovery-workflow.md`，其技术实现边界见 `04a-discovery-technical-spec.md`。

### 1.1 Data Layer

核心数据关系：

```text
sources
  ↓
raw_articles
  ↓
processed_contents
    ├── Event Candidate ──→ events
    ├── Source Digest
    ├── Long-form
    └── Inspiration

Stage 3 Event Ranking → event_review_items

feedback

evaluation_inputs → evaluation_runs → evaluation_outputs
```

- `sources`：Source List 与采集配置
- `raw_articles`：Collector 标准化后的原始内容
- `processed_contents`：Stage 1 处理后的内容，Ignore 不入库
- `events`：最终生成并用于展示的 Event
- `event_review_items`：Event Ranking Human Review 的历史快照
- `feedback`：人工 Review 产生的反馈数据
- `evaluation_*`：Model Evaluation 使用的冻结输入、模型运行与输出，与正式 Production 结果隔离

具体表结构、字段、约束、关系与索引以 `05-data-model.md` 为准。

### 1.2 Processing Layer

Production Processing 主流程：

```text
Source Collection
→ Pre-Stage1 Exact Dedup
 → Content Completion
  → Stage 1 → Stage 2 → Stage 3 → Stage 4
```

#### Source Collection

主要由代码完成，负责：
- 获取新增内容；
- 保存 Source Metadata（包括 Category）；
- 尽可能保存原始正文与原始 Metadata；
- URL / GUID 等基础去重；
- 写入 `raw_articles`。

#### Pre-Stage1 Exact Dedup

由代码完成，在进入后续 Processing 前去除可确定为完全重复的内容（`raw_articles.stage1_status = ignored`），避免重复内容继续消耗 Content Completion 与 LLM Processing。

#### Content Completion

主要由代码完成，在进入 AI Processing 前尽可能补全缺失正文，为后续 Stage 提供更完整的输入。

#### Stage 1 — Content Understanding & Selection

LLM 完成，负责：Understanding、Selection、Routing、Tagging、Entity、Summary、Translation。

处理结果进入 `processed_contents`。

#### Stage 2 — Event Merge

LLM 完成，将属于 Event Channel 的候选内容（`processed_contents.routing = event`）按现实事件或紧密关联的 Event Thread 合并为 Event Groups。

Event Groups 是当前 Workflow 的中间结果，不直接写入 events 表；Stage 2 不生成最终 Event 内容，也不执行 Ranking。

Event Group membership 由 `event_group_items` 保存为 many-to-many relation：同一 candidate 可安全出现在多个不同 Groups；同一 Group 内的重复 membership 由数据库唯一约束防止。下游以 Event Group / Review Item relation 读取 source membership，不以 `processed_contents.event_id` 作为正式关系。

#### Stage 3 — Channel Ranking

LLM 完成，对不同 Channel 独立执行 Ranking：Event、Digest、Long-form。

AI 负责相对排序；最终选择与展示数量由 Application Code 决定。排序保留 AI 原始结果与独立的展示排序；Inspiration 不需要 AI Ranking。

#### Stage 4 — Selected Event Enrichment

LLM 完成，处理经过 Stage 3 Ranking 和最终选择后入选的 Event Groups。每个 Selected Event 独立完成最终 Event synthesis / enrichment，生成 publish-ready Event。

Stage 4 可在确实缺少必要外部上下文时使用 Web Search；默认仍走普通 LLM Structured Output 路径。

具体 AI 判断语义以 `03-ai-workflow-spec.md` 为准；Daily Scope、执行顺序、重试、幂等、持久化和 lineage 等执行语义以 `06-processing-workflow.md` 为准。

**In-depth Discovery 是独立 Workflow**，消费 Daily Brief 数据，不属于 Stage 1–4；业务执行语义见 `06a-discovery-workflow.md`，技术实现见 `04a-discovery-technical-spec.md`。

### 1.3 Presentation Layer

X-AI-field 负责生成和提供 publish-ready 数据，不负责最终用户侧 Daily Brief 页面。

```text
PostgreSQL
   ↓
X-AI-field API
   ↓ HTTP
X-field UI
```

X-AI-field 同时包含 Internal Dashboard，用于运行观察、Daily Job Report、Human Review 与 Model Evaluation。

---

## 2. Tech Stack

- Runtime：Next.js + TypeScript
- Database：PostgreSQL / Supabase
- ORM：Drizzle ORM
- AI Integration：Daily / 常规结构化调用使用共享 LLM compatibility layer；Discovery 自适应探索使用 OpenAI Agents SDK（TypeScript）
- Supported Providers：OpenAI / DeepSeek / Kimi
- Structured Output：Provider 输出 + Application Schema Validation
- External Retrieval：Daily Stage 4 可选 `web_search`；Discovery 优先使用 Agents SDK 托管 Web Search
- Scheduling：Cron / Scheduled Job
- Runtime Artifacts：Daily 等既有流程使用本地文件系统（Git ignored）；Discovery Trace 优先存 PostgreSQL

---

## 3. Data Model

PostgreSQL 是 Production System of Record。

Production 数据主要包括：

```text
Production Content Data
Review / Feedback Data
Model Evaluation Data
Discovery Runs / Candidates / Trace Data
```

数据库负责持久化业务状态；Daily 的 `runtime/` 只保存运行级 artifacts，不替代数据库。Discovery 的执行 Trace 使用 Agents SDK Tracing 扩展接口写入 PostgreSQL，具体见 `04a-discovery-technical-spec.md`。

详细表结构、字段、关系、约束和索引定义见 `05-data-model.md`。

---

## 4. Processing Workflow

Daily Production Workflow、Human Review 与 Model Evaluation 是既有的三个职责不同的流程；另有独立的 In-depth Discovery Workflow，具体见 `06a-discovery-workflow.md`。

```mermaid
flowchart TD
    PROD["Production Workflow"] --> DATA["Publish-ready Production Data"]
    DATA --> REVIEW["Human Review"]
    DATA --> EVAL["Model Evaluation"]
    REVIEW --> DATA
    REVIEW --> FEEDBACK["Feedback"]
    EVAL --> EVALDATA["Evaluation Data"]
```

### 4.1 Production Workflow

负责从 Source Collection 到 Stage 4 生成 publish-ready Production Data。

Production Workflow 必须支持安全重复执行（Idempotency），避免 Retry / Re-run 产生重复或不一致的 Production State。

具体 Processing 流程已在 §1.2 概述；Daily Scope、Idempotency、Retry、Persistence 与 Lineage 等完整执行语义见 `06-processing-workflow.md`。

### 4.2 Human Review

Human Review 作用于已经生成的 Production 结果：
- Review Event / Long-form Ranking；
- 调整展示顺序；
- 保存人工 Feedback；
- 不覆盖 AI 原始判断。

Human Review 可以调用已有 Processing 能力，但不建立第二套 Production Pipeline。

### 4.3 Model Evaluation

Model Evaluation 是独立的观察与比较流程：
- Evaluation 数据独立保存；
- 不自动回写 Production 内容；
- 不改变 Daily lineage；
- 不替代正式 Production Processing。

---

## 5. LLM Integration

常规 LLM Integration 通过共享 compatibility layer 与业务逻辑解耦。Discovery 的 Agent Loop 单独通过 Agents SDK 接入；二者共用业务契约，不要求复用同一个 SDK Client：

```mermaid
flowchart LR
    APP["Application Logic"] --> CLIENT["Shared LLM Client"]
    CLIENT --> OAI["OpenAI"]
    CLIENT --> DS["DeepSeek"]
    CLIENT --> KIMI["Kimi"]
```

LLM 的 Runtime Prompt 位于 `src/prompts/`，Prompt 与 Structured Output Contract 见 `07-prompt-spec.md`


Discovery 的 Agent 工具调用、模型兼容性与 Trace 细节由 `04a-discovery-technical-spec.md` 定义。

### 5.1 Structured Output 边界

```text
Application Input
→ LLM Request
→ Structured Output
→ Application Schema Validation
→ Business Logic / Persistence
```

不同 Provider 的原生 Structured Output 能力可以不同，但输出在被业务逻辑使用或持久化之前，都必须通过相同的 Application-side Contract Validation。

### 5.2 Provider Independence

系统通过共享 LLM Client 支持不同 Provider，使模型或 Provider 可以替换，而不要求修改对应 Workflow 的业务逻辑。具体 Provider 配置与环境变量属于运行配置，不在本节重复定义。

### 5.3 可选 External Retrieval

Stage 4 存在两条技术执行路径：

```mermaid
flowchart TD
    E["Selected Event Context"] --> J["Context Sufficiency Check"]
    J -->|enough| CHAT["Normal Structured LLM Call"]
    J -->|missing necessary context| SEARCH["Tool-enabled Web Search Path"]
    SEARCH --> FINAL["Structured Enrichment"]
    CHAT --> FINAL
```

External Retrieval 是可选能力，不是每个 Event 的默认路径。何时需要外部上下文由 `03-ai-workflow-spec.md` 定义。

---

## 6. API 与展示边界

X-AI-field 不负责最终用户侧 Daily Brief UI。Daily Brief 页面位于独立的 X-field 项目中：

```text
PostgreSQL
   ↓
X-AI-field Application API
   ↓ HTTP
X-field UI
```

X-AI-field 当前提供的 Application API 主要服务于 Daily Brief、Read More、Human Review 和 Model Evaluation。

具体 Endpoint 的 Request / Response Contract 由对应实现与代码注释维护，不在 Technical Spec 中重复维护。

### 6.1 Daily Brief API
```text
GET /api/brief?date=YYYY-MM-DD
```
Daily Brief API 按指定日期提供 publish-ready 内容。它读取 Production 数据，不额外创建 `daily_briefs` snapshot 层，并作为 X-AI-field 与 X-field 之间的 Presentation Boundary。

Daily membership、Ranking 与 Composition 的执行语义见 `06-processing-workflow.md`。

### 6.2 Read More
```text
POST /api/content/read-more
{ "contentId": "processed_contents.id" }
```
Read More 是 Presentation Layer 按需触发的 AI 能力：

```text
User Request → Read More API → Server-side Full Content → LLM → Detailed Reading Guide
```

原始 Full Content 保持在 Server-side，不返回给 Client。Read More 的 AI 语义见 `03-ai-workflow-spec.md`；Prompt / Structured Output Contract 见 `07-prompt-spec.md`。

### 6.3 管理路由与认证

`/dashboard/*` 与 `/review/*` 是后台页面，保留现有 URL；`/api/admin/*` 是后台 API。二者均要求单管理员 Session。未登录页面跳转 `/login`，未登录 API 返回 JSON 401。`/`、`/in-depth`、`/api/brief` 和 `/api/content/read-more` 保持匿名访问。登录与退出端点位于 `/api/auth/*`。

管理员密码以服务端环境变量中的 scrypt hash 配置。登录后生成随机、不透明的 Session Cookie；服务端文件存储其 hash 对应的会话记录和过期时间，独立于业务数据库及 `runtime/` Pipeline Artifacts。退出删除记录；密码 hash 变化会使旧会话失效。不使用用户表或 RBAC。Proxy 保护页面和管理 API，每个管理 Route Handler 还独立校验 Session；修改数据或触发任务的请求校验同源 Origin。Cookie 的 Secure 属性由部署配置决定，具体设置和 HTTP 风险见 `09-operations.md`。

浏览器 URL 遵循**相对路径优先**：既有 `./`、`../` 构造保持相对形式，迁移 API 时只改必要路径；复用 URL 时须按每个调用页面核对层级。Next.js `Link`、服务端重定向和 Proxy Matcher 按各自路径规则处理。`basePath=/ai` 由 Next.js 路由配置处理，不在浏览器相对 URL 或 Matcher 中重复加入 `/ai`。

---

## 7. Internal Dashboard

X-AI-field 包含一个 Internal Dashboard，用于运行观察、Human Review 与 Model Evaluation。

Dashboard 不是 Production Source of Truth。它读取 Production 数据与 Runtime Artifacts，并调用已有 Application Services，不应在 UI 层复制 Processing、Review 或 Evaluation 的业务逻辑。

### 7.1 最近 7 天 Overview

展示最近 7 天 Daily Processing 状态与关键运行指标。

### 7.2 Daily Job Report

查看指定日期的 Daily Job 运行情况与各 Processing Step 的结果，用于判断该次运行是否正常完成以及定位问题。

### 7.3 Human Review

提供人工 Review 界面：
- Review Event Ranking；
- Review Long-form Ranking；
- 调整 Display Order；
- 保存 Ranking Feedback。

### 7.4 Model Evaluation

提供 Model Evaluation 界面，用于比较不同模型在已支持 AI Stage 上的输出结果。

Dashboard 的具体 UI Layout 与交互细节以实现为准，不在 Technical Spec 中维护。

---

## 8. Project Structure & Engineering Rules

### 8.1 Project Structure

项目保持相对平铺的目录结构：

```text
X-AI-field/
├── src/
│   ├── app/            # HTTP Routes / Internal Dashboard UI
│   ├── collectors/
│   ├── db/
│   ├── lib/
│   ├── processing/
│   ├── discovery/     # In-depth Discovery 独立模块
│   └── prompts/
├── scripts/
├── drizzle/
├── runtime/
├── docs/               # Project Specs / operational documentation
│   ├── 01-product-spec.md
│   ├── 02-workflow-overview.md
│   ├── 03-ai-workflow-spec.md
│   ├── 04-technical-spec.md
│   ├── 04a-discovery-technical-spec.md
│   ├── 05-data-model.md
│   ├── 06-processing-workflow.md
│   ├── 06a-discovery-workflow.md
│   ├── 07-prompt-spec.md
│   ├── 08-source-list.md
│   └── 09-operations.md
├── AGENTS.md
└── README.md
```

Technical Spec 维护目录级职责，不需要镜像每一个具体 Source File。

### 8.2 Module Boundaries

- `collectors`：外部数据采集与标准化。
- `processing`：Daily Production Processing、Review / Evaluation Services 与相关 Persistence Orchestration。
- `discovery`：独立 Discovery Workflow 编排、Agent、候选验证与持久化协调；不依赖 Daily Stage 内部执行入口。
- `prompts`：Runtime LLM Prompts。
- `db`：Database Schema 与 Connection。
- `lib`：共享 Application Logic 与 API Composition Helpers。
- `app`：HTTP Routes 与 Internal UI。
- `runtime`：运行级 Operational / Debug Artifacts。
- `scripts`：CLI Entry Points 与专用 Operational Tools。

核心业务逻辑应放在可复用的 Application / Processing Modules 中，不应重复写入 Route Handler、UI Component 或 CLI Script。

### 8.3 Dependency Direction

优先保持依赖方向：

```text
app / scripts
    ↓
application / processing modules
    ↓
db / llm / external adapters
```

除非逻辑确实只属于对应 Boundary，否则不要把核心业务行为直接放入 UI Component、API Route Glue、CLI Entry Point 或 Runtime Artifact Reader。

### 8.4 Engineering Rules

- KISS
- YAGNI
- 同一事实只在唯一 Source of Truth 中定义
- 模块保持单一、清晰职责。
- 优先显式代码，不做过早抽象。不为假设中的未来规模提前引入基础设施。
- 通用基础能力优先使用成熟 Library。
- 不静默忽略错误。
- Secrets 与环境相关配置不得硬编码。
- Model / Provider 应保持可替换。
- Structured AI Output 必须验证后再使用。

### 8.5 Error Handling

- 错误尽量在最接近发生位置处理并记录；
- 无关工作能够安全继续时，应隔离局部失败；
- 保留足够信息支持针对性 Retry 与 Diagnosis；
- 不通过 Silent Fallback 隐藏异常。

Daily 的 Step Retry / Recovery 语义见 `06-processing-workflow.md`；
Discovery 的失败与重跑语义见 `06a-discovery-workflow.md`；Operational Commands 见 `09-operations.md`。

### 8.6 Testing Boundary

测试应保护会造成实质性 Regression 的架构与行为 Contract。具体 Test Commands 与 Test Inventory 见 `09-operations.md`。

---

## 9. Runtime Architecture

`runtime/` 保存 Production Processing 与相关工具生成的 Run-level Artifacts。

主要用途：

- 保存真实 Model Input / Output；
- Debug；
- Operational Inspection；
- Run Metadata；
- Diagnostics；
- 支持对失败运行进行可复现的调查。

### 9.1 Runtime 不是 Production State

Runtime Artifacts：

- Git ignored；
- 不是 Application Database；
- 不是 Durable Business Source of Truth；
- 不应静默成为 Processing Stages 之间的正式数据接口。

如果某个事实会影响持久化业务行为，它应进入 Production Data 或明确的 Application Contract，而不能只存在于 `runtime/`。

### 9.2 Runtime 与 Dashboard

Internal Dashboard 可以读取 Runtime Artifacts，用于 Daily Job Report 与历史运行 Diagnostics。

当 Runtime 数据不存在时，不应根据当前 Production State 反推出虚假的历史 Runtime Metrics。

### 9.3 Runtime 与 Recovery

Runtime Artifacts 可以在明确需要时辅助 Debug 与 Recovery Analysis，但 Recovery Semantics 应由 Processing Workflow 定义，而不是依赖未文档化的文件系统约定。

Daily 执行语义见 `06-processing-workflow.md`；
Discovery 执行语义见 `06a-discovery-workflow.md`；
操作规程见 `09-operations.md`。
