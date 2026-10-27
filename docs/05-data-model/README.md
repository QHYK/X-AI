# Data Model

PostgreSQL 保存生产内容、审核、评测和 Discovery 状态；Daily 的运行文件不替代业务表。本文档是数据模型导航，字段、索引与约束各自只在所属数据域定义。

## 数据域与表目录

| 数据域 | 表 | 适合读取的任务 |
|---|---|---|
| [Daily / Review / Evaluation](daily.md) | `sources`、`raw_articles`、`processed_contents`、`content_read_more`、`events`、`event_review_items`、`event_groups`、`event_group_items`、`stage4_runs`、`pipeline_runs`、`feedback`、`evaluation_inputs`、`evaluation_runs`、`evaluation_outputs` | Daily 数据归属、来源关系、排序、发布、审核及隔离评测 |
| [Discovery](discovery.md) | `discovery_runs`、`discovery_trace_spans`、`discovery_candidates`、`in_depth_candidates`、`discovery_fetch_cache` | Run / Lead 关联、候选、审核、正文复用和诊断数据 |
| [Prompt Registry](prompt-registry.md) | `prompt_registry`、`prompt_versions`，以及业务对象中的版本载体 | 版本身份、Active 指针、Published 保护及精确引用 |

## 关键跨域关联

- Discovery 的来源内容通过 `source_content_type + source_content_id` 逻辑关联 Daily Event 或 Processed Content，不是单一数据库 FK；Lead 归属来自 Run JSONB。具体边界见 [discovery_candidates](discovery.md#discovery_candidates)。
- In-depth 审核记录只关联 Discovery Candidate，Candidate 可再关联 Run / Parent Run；manual Candidate 没有虚构 Run。正文 Cache 按规范化 URL 逻辑复用，不建立 Candidate FK。
- Prompt Active 有数据库复合 FK；业务 JSONB、text 和 Daily 文件中的版本 UUID 是应用验证的逻辑引用，载体统一见 [版本绑定载体](prompt-registry.md#版本绑定载体)。
- Evaluation 与 Production 表隔离；Feedback 使用多态逻辑目标，不是向各目标表建立外键。具体表定义见 [Daily](daily.md)。

## Source of Truth 与核验边界

- 当前声明的字段、类型和基本约束：[`src/db/schema.ts`](../../src/db/schema.ts)。
- 已提交的建表、变更及 Trigger：[`drizzle/`](../../drizzle/)；Migration Journal 描述仓库迁移顺序，不证明任何远程库已执行成功。
- 实际部署数据库的对象与迁移状态须只读核验。文档按 Schema 与 Migration 分别记录已发现的差异，不把 ORM 声明、应用校验或计划当作已部署的数据库保证。

数据域文档中的约束以数据库 CHECK / FK / UNIQUE / Trigger 明确标注；JSONB 嵌套结构与业务状态组合未必有数据库强制校验。执行与恢复见 [Workflow](../00-index.md#按任务阅读)，Prompt Runtime 行为见 [Registry Contract](../07-prompt-spec/registry.md)，技术一致性见 [Technical Spec](../04-technical-spec/architecture.md)。
