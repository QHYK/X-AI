# 文档索引

本文件是完整文档导航的唯一入口。先按任务选择主题，再读取相关章节；不要默认加载全部 Spec。同一事实由职责所属文档定义，其他文档仅引用。

## 文档职责

| 文档 | 职责 / 适用任务 |
|---|---|
| [01 Product Spec](01-product-spec.md) | 产品目标、用户行为、内容标准及 Planned 产品能力 |
| [02 Workflow Overview](02-workflow-overview.md) | Production、Review、Evaluation 与 Discovery 的整体流程 |
| [03 AI Workflow Spec](03-ai-workflow-spec.md) | AI 阶段职责、判断目标和内容语义 |
| [04 Technical Architecture](04-technical-spec/architecture.md) | 系统架构、技术选型、通用组件、工程与数据边界 |
| [04 Daily Brief](04-technical-spec/daily.md) | Daily Processing 技术边界及 Stage 间关系 |
| [04 Discovery](04-technical-spec/discovery.md) | Discovery Agent、Fetch Cache、Trace、原文复用及并发边界 |
| [04 Admin & API](04-technical-spec/admin-api.md) | Dashboard、后台 UI、认证、人工操作与公开 API 契约 |
| [05 Data Model](05-data-model/README.md) | Schema、字段、表关系、索引和数据库约束 |
| [05 Daily / Review / Evaluation](05-data-model/daily.md) | Daily 内容、来源关联、发布、Review 与评测 |
| [05 Discovery](05-data-model/discovery.md) | Discovery Run、候选、审核、Trace 与 Fetch Cache 表 |
| [05 Memory](05-data-model/memory.md) | 跨 Daily / Discovery 的共享编辑偏好表、Type 与约束 |
| [05 Prompt Registry](05-data-model/prompt-registry.md) | Registry / Versions、数据库保护与版本关联载体 |
| [06 Daily Workflow](06-workflow-spec/daily.md) | Daily scope、eligibility、Stage 执行、持久化、lineage 与恢复 |
| [06 Discovery Workflow](06-workflow-spec/discovery.md) | Discovery 窗口、分支、状态、人工触发及 Retry / Resume |
| [06 Manual Operations](06-workflow-spec/manual-operations.md) | Put Back、人工 URL 候选、Human Review 与 Evaluation 操作流程 |
| [07 Prompt Registry](07-prompt-spec/registry.md) | Prompt Registry、版本、Fragment、Runtime Binding 与模板契约 |
| [07 Daily Prompt](07-prompt-spec/daily.md) | Stage1–4 的 Prompt 输入输出、Schema 与校验 |
| [07 Discovery Prompt](07-prompt-spec/discovery.md) | D2–D5 的 Prompt 输入输出、工具、证据与校验 |
| [07 Editorial Prompt](07-prompt-spec/editorial.md) | Read More、Introduction、Manual Generate 与 Put Back 的生成契约 |
| [08 Source List](08-source-list.md) | Source 配置及来源约定 |
| [09 Operations](09-operations.md) | 命令、环境变量、部署、测试、诊断与修复操作 |

按任务选择对应文件和章节，不要求按编号顺序加载全部文档。

## 按任务阅读

- **Daily Pipeline**：03 对应 Stage → 06 Daily；涉及技术边界读 04 Daily，涉及模型输入输出读 07 Daily。
- **Discovery**：03 §7 → 06 Discovery；涉及 Agent、正文与并发读 04 Discovery，涉及模型契约读 07 Discovery。
- **Dashboard / 后台 / 公开 API / Xfield 对接**：04 Admin & API；涉及产品行为读 01，涉及存储读 05。
- **人工候选 / Put Back / Review / Evaluation**：06 Manual Operations；涉及 AI 生成读 07 Editorial，涉及 API/UI 读 04 Admin & API。
- **Prompt Management / 版本绑定**：07 Registry；按请求类型补读相应 Prompt Contract，执行与 Resume 读对应 06。
- **数据库 / 部署 / 排障**：05 定义数据约束，09 提供操作入口；不要从操作说明反推业务规则。

### Prompt Contracts

通用版本与模板规则见 [Registry](07-prompt-spec/registry.md)；具体请求按 [Daily](07-prompt-spec/daily.md)、[Discovery](07-prompt-spec/discovery.md)、[Editorial](07-prompt-spec/editorial.md) 选择。

## 其他记录

[08 Backlog](08-backlog.md) 与 [10 Key Information](10-keyinformation.md) 保留各自现有用途，不替代上述权威 Spec。`docs/backup/` 为历史材料，不作为当前实现依据。Coding Agent 协作规则见 [AGENTS.md](../AGENTS.md)。
