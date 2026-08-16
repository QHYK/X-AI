# AGENTS.md

本文档定义 Coding Agent 在 X-AI-field 项目中进行开发时需要遵守的工作规则。

项目的产品行为、AI Workflow 和技术架构由 `/docs` 下的 Spec 定义。
Do not treat this file as a replacement for the Specs.

## Before Coding

开始实现任务前：

1. 阅读当前任务相关的 `/docs` 文档。
2. 如果任务影响产品行为，阅读 `01-product-spec.md`。
3. 如果任务影响 AI Workflow，阅读 `02-ai-workflow-spec.md`。
4. 如果任务涉及 LLM 行为或 Prompt，阅读 `03-prompt-spec.md`。
5. 如果任务涉及架构、数据库、Workflow 或项目结构，阅读 `04-technical-spec.md`。
6. 只读取实现当前任务范围内的内容。

如果实现需求与现有 Spec 冲突，不要自行修改架构或绕过 Spec，应先明确指出冲突。

## Source of Truth

以下 Spec 是项目设计的 Source of Truth：
- `docs/01-product-spec.md`
- `docs/02-ai-workflow-spec.md`
- `docs/03-prompt-spec.md`
- `docs/04-technical-spec.md`

Source 配置维护在：
- `docs/05-source-list.md`

如果现有代码与 Spec 不一致，在进行结构性修改前，应先指出两者之间的差异。

## Engineering Principles

开发遵循：
- KISS
- YAGNI
- LLM-first
- Rules only when necessary

优先选择能够满足当前 Spec 的最简单实现。
不要为了假设中的未来需求提前增加基础设施、抽象层或复杂设计。

## Architecture Boundaries

保持模块职责清晰：
```text
collectors → 外部数据采集和标准化
processing → Stage 1–4 Workflow
prompts → LLM Prompts
db → Database Schema 和数据访问
app → API 和 UI
```

避免不必要地混合：
* 数据采集
* LLM Prompt
* 数据库访问
* UI 逻辑
* Data & AI Contracts

数据库结构遵循：`04-technical-spec.md`

LLM 行为和 Structured Output 遵循：`03-prompt-spec.md`

不要在无关任务中顺带修改：
* Database Schema
* Routing Values
* LLM Output Contract

如果当前任务确实需要修改 Schema 或 Contract，应在实现前明确指出。

## Implementation Rules
* 使用 TypeScript。
* 优先使用成熟 Library，不重复实现已有基础能力。
* 系统边界的数据结构应保持明确类型。
* LLM Structured Output 必须通过 Schema Validation 后才能使用或持久化。
* Secrets 和环境相关配置不得硬编码。
* Error 应尽可能在发生位置处理和记录。
* 不要静默忽略 Error。
* Workflow 应遵守 Technical Spec 中定义的 Idempotency 要求。

## Testing

MVP 优先测试真正影响 Pipeline 正确性的部分：
* Collector normalization
* Database constraints
* Structured Output validation
* Workflow state transitions
* Ranking / display rank behavior
对于主观的自然语言质量，不建立大量脆弱的传统 Unit Tests。

Prompt 质量主要通过实际 Daily Brief、Human Feedback 和后续 Eval 判断。

## Scope Control

除非当前任务或 Spec 明确要求，否则不要引入：
* Microservices
* Message Queue
* Workflow Engine
* Agent Framework
* 不必要的 Repository / Service Layer
* 提前进行的性能抽象和优化
存在简单方案时，优先使用简单方案。

## Documentation

如果实现改变了：
* Architecture Decision
* Data Contract
* Processing Workflow
* LLM Contract
应同步更新对应 Spec。

如果只是实现细节变化，没有改变系统行为或设计，不需要修改 Spec。