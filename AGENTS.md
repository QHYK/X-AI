# AGENTS.md

本文档定义 Coding Agent 在 X-AI-field 项目中的工作规则。

它只负责：
- 如何选择并读取项目文档
- 如何控制修改范围
- 如何遵守架构与工程边界
- 如何验证改动

产品行为、Workflow、架构、数据模型、Prompt、Operations 等具体事实由 `/docs` 下各自的 Source of Truth 定义。
不要把本文件当作任何 Spec 的替代品。

## 1. Source of Truth & Context Loading

重要：**一个事实只能存在于一个 Source of Truth。**

开始编码前，先判断当前任务影响哪个领域，只读取对应文档和相关章节，不要默认加载全部 `/docs`。

| 任务影响 | Source of Truth |
|---|---|
| 产品目标、用户行为、Brief 内容标准 | `docs/01-product-spec.md` |
| 系统整体流程、Production / Review / Evaluation 全貌 | `docs/02-workflow-overview.md` |
| AI Stage 的职责、判断目标、语义规则 | `docs/03-ai-workflow-spec.md` |
| 系统架构、技术选型、模块边界、稳定架构决策 | `docs/04-technical-spec.md` |
| Database Schema、表关系、字段约束、Index | `docs/05-data-model.md` |
| Production Pipeline 的执行、scope、eligibility、retry、persistence、lineage | `docs/06-processing-workflow.md` |
| Prompt、Structured Output、LLM Input / Output Contract | `docs/07-prompt-spec.md` |
| Source 配置 | `docs/08-source-list.md` |
| Commands、CLI 参数、环境变量、Tests、Diagnostics、Backfill / Repair | `docs/09-operations.md` |

读取规则：
1. 先读取当前任务最直接相关的文档和章节。
2. 大文档只读取必要章节，不要一次加载整份。
3. 只有任务跨越多个边界时，才继续加载额外 Spec。
4. 如果实现需求与现有 Spec 冲突，不要自行绕过或静默修改；先指出冲突。
5. 如果代码与 Spec 不一致，在结构性修改前先指出差异，并确认目标状态。

文档更新规则：
1. 只更新拥有该事实的 Source of Truth。
2. 其他文档需要该事实时，只保留链接或一句引用。
3. 不要为了“保持一致”把相同规则复制到多个文档。
4. 不要因为修改了代码，就自动更新所有“相关文档”。
5. 只有文档拥有的事实确实发生变化时，才修改该文档。
6. 如果发现同一事实已经散落在多个文档，保留职责所属文档中的定义，其余位置改为引用或删除。

示例：
- 修改 Daily scope
  → 读 `06-processing-workflow.md` 对应章节。
- 修改 Stage 3 ranking
  → 先读 `03-ai-workflow-spec.md` Stage 3；
  如果涉及执行、dedup、review snapshot、persistence，再读 `06-processing-workflow.md` Stage 3；
  如果涉及 Prompt / Structured Output，再读 `07-prompt-spec.md` Stage 3。
- 修改 CLI / env / test / diagnostic
  → 读 `09-operations.md`；
  不要把 Workflow 规则复制到 Operations。

## 2. Engineering Principles

开发遵循：
- KISS
- YAGNI
- LLM-first
- Rules only when necessary
优先选择能够满足当前 Spec 的最简单实现。

不要为了假设中的未来需求提前增加：
- Microservices
- Message Queue
- Workflow Engine
- Agent Framework
- 不必要的 Repository / Service Layer
- 提前进行的性能抽象和优化

如果简单方案已经足够，不要引入更复杂方案。

## 3. Architecture Boundaries

遵守 `04-technical-spec.md` 中 **Project Structure & Engineering Rules** 定义的模块与依赖边界。不要为了当前局部任务改变无关的 Database Schema、Routing values、LLM Output Contract、Daily Scope、Persistence semantics 或 Public API contract；确需改变时，先明确影响范围并读取对应 Source of Truth。

## 4. Implementation Rules

- 使用 TypeScript。
- 优先使用成熟 Library，不重复实现已有基础能力。
- 系统边界的数据结构保持明确类型。
- LLM Structured Output 必须通过 Schema Validation 后才能进入 Application Logic 或 Persistence。
- Secrets 与环境相关配置不得硬编码。
- Error 应尽量在最接近发生位置处理、记录和传播。
- 不要静默忽略 Error。
- Production data、runtime artifact 与 Stage lineage 的边界遵循 `04-technical-spec.md` 和 `06-processing-workflow.md`，不要自行建立新的业务 Source of Truth 或隐式 lineage。
- 修改 Prompt、runtime prompt implementation 或 Structured Output contract 时，检查三者是否仍一致。

## 5. Change Scope

只修改完成当前任务真正需要的内容。
除非任务明确要求：
- 不进行顺手的大规模重构；
- 不重命名无关文件；
- 不清理与任务无关的代码；
- 不修改无关 Schema；
- 不调整无关 Prompt；
- 不改变无关 Workflow；
- 不引入未来可能需要但当前没有需求的能力。

如果发现值得后续处理的问题，可以在最终报告中列出，但不要自动扩大本次修改范围。

## 6. Operations & Scripts

所有正式命令、参数、环境变量、Tests、Diagnostics、Backfill / Repair 的操作入口遵循：
```text
docs/09-operations.md
```

修改或新增操作入口时：
1. 先检查 `package.json` 中实际 scripts。
2. 检查对应 `scripts/*.ts` 的 CLI / env parsing。
3. 检查真实 implementation 与默认值。
4. 只记录实际可执行、仍受支持的能力。
5. 不把 `package.json` 或 `scripts/` 目录逐字复制成文档 inventory。
6. One-off diagnostic / incident recovery 在问题结束后应评估删除，而不是永久积累。
7. 删除 script 前检查 imports、package scripts、tests、CI / deployment 与文档引用。

## 7. Testing

优先验证当前修改真正影响的正确性边界，不为主观自然语言质量建立大量脆弱的传统 Unit Tests；
Prompt 质量主要通过实际 Daily Brief、Human Feedback 和 Evaluation 判断。

修改完成后：
1. 运行与当前修改直接相关的 regression tests。
2. 运行必要的 `typecheck` / `lint`。
3. 影响 build / Next.js 边界时运行 `npm run build`。
4. 不为小范围改动无条件运行全部高成本 external integration diagnostics。

具体测试与诊断入口见 `docs/09-operations.md`。

## 8. Final Report

完成任务后，简要说明：
- 修改了什么；
- 为什么修改；
- 验证了什么；
- 是否修改了 Spec；
- 如果没有修改 Spec，说明此次改动未改变文档拥有的行为或 Contract；
- 如果发现值得后续处理的问题，单独列出。