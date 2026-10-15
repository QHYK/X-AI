# In-depth Discovery 技术规范（设计稿 v0.3）

本文档只定义 X-AI-field Discovery 的**技术实现边界与关键决策**。通用架构见 `04-technical-spec.md`；AI 语义见 `03-ai-workflow-spec.md`；执行分支、人工触发与失败语义见 `06a-discovery-workflow.md`；字段定义见 `05-data-model.md`；Prompt 与输出契约见 `07-prompt-spec.md`；运行命令见 `09-operations.md`。

> 状态：供技术评审。本文档描述拟采用的实现方案，不代表已在仓库中实现；需结合实际代码核对 API 复用入口、Firecrawl 接口与模型兼容性。

## 1. 技术目标与边界

- 保留现有 Daily Production Stage 1–4 与 `06-processing-workflow.md`，不将 Discovery 接入 Daily Job。
- 继续使用当前 Next.js / TypeScript / PostgreSQL / Drizzle 体系；不增加服务、消息队列或 Workflow Engine。
- Code 控制输入、业务分支、并发、验证、入库和人工触发；Agent 只自主决定内容探索行动。
- 以可追溯、可人工 Review 为首要工程目标；同一输入可产生不同探索结果。
- 不开发通用 Agent 平台、独立 Planner、自动 Memory 学习或付费墙绕过能力。

## 2. 模块与依赖

遵循现有仓库 `src/app`、`src/collectors`、`src/db`、`src/lib`、`src/processing`、`src/prompts` 的结构；新增 `src/discovery/`，在 `scripts/` 增加独立运行入口。内部文件按实际实现逐步拆分，不预设复杂层级。

```text
scripts / app (CLI、人工触发入口)
       ↓
src/discovery (workflow orchestration / candidate evaluation)
       ├── 普通 LLM 调用：Topic Selection / 编辑评价
       ├── Agents SDK：Topic / Open Discovery Agent Loop
       ├── Search / Fetch adapters
       ├── Daily Brief read adapter（复用现有选择语义）
       ├── DB persistence（经现有 db 层）
       └── DB execution steps（经现有 db 层）
```

- `src/prompts/` 保存 Discovery Prompt；`src/db/` 保存 Drizzle Schema。
- 现有 Daily Brief 查询逻辑应抽取或复用为可被 API 与 Discovery 调用的服务函数；**不通过复制 SQL / 过滤规则实现第二套 Daily 选择逻辑**。
- 不让 `src/discovery` 调用 Daily Stage 的 orchestration；只读取其已生成的数据。
- 不在 Route Handler、CLI 入口中实现 Agent Loop 或编辑判断。

## 3. 输入快照与读取

Discovery 默认在 Asia/Shanghai 12:00 启动，前提是依赖的两期 Daily 均已完成；若上游失败则等待人工修复后手动启动，不因补跑时间变化而切换计划窗口。一次 Discovery Run 确定一个两期 Daily 的输入窗口。Event 可覆盖窗口内所有 Event；Digest 与 Long-form 沿用对外 API 的内容选择规则（以 `06a` 为准）。

- Code 读取并组装标题、摘要、必要标签、来源及内容 ID；Topic Selection 不读取原文、不要求 URL。后续阶段通过 ID 查询 URL 和正文。
- 记录计划窗口、实际输入内容 ID，以及用于模型调用的**输入快照或可核查的输入记录**，防止数据后续更新导致无法解释历史决策。
- 推荐历史用于候选去重，不默认加入 Topic Selection / Agent Context；少量 Few-shot 与相关显式 Memory 可按 `03` 的语义输入。
- 不在本规范中定义 Daily 日期边界或 API membership 规则，需先核实代码后复用。

## 4. AI 调用与 Agent Runtime

### 4.1 Topic Selection 与编辑评价

使用普通 LLM Structured Output 调用，经应用层 Schema Validation 后使用。Topic Selection 最多返回 **8 条** Direct / Topic 线索合计，按优先级排序；可以为空。该限制不意味着启动 8 个完整 Agent Loop。

### 4.2 Discovery Agent

使用 **OpenAI Agents SDK（TypeScript）** 实现一个可复用的 Discovery Agent：

- Topic 模式：给定 Knowledge Question 与新闻上下文；
- Open 模式：不限定新闻主题；既可自动 Fallback，也可由人工主动触发；
- 两种模式复用工具、编辑标准与结果契约，不建立两个 Agent 类或多 Agent 协作框架。

Agent 每轮依据工具观察结果决定搜索、阅读、追踪或结束。工具调用与结果必须可记录，最终自然语言声明不能替代真实执行证据。

**模型接入**：Discovery Agent 首版使用 OpenAI 官方 API 与支持托管 Web Search 的模型，通过 Agents SDK 调用；普通 Topic Selection / 编辑评价仍使用现有共享 LLM Client。开发开始时先做最小连通性实验，验证选定模型、SDK 版本、Hosted Tool 与 Structured Output 的组合，不预设多 Provider 自动切换。

### 4.3 工具与搜索方案

首版优先使用以下两种工具：

- **Agents SDK 托管 Web Search**：优先使用 SDK 提供的 `webSearchTool()`（由 OpenAI 服务端执行搜索），由 Agent 决定搜索什么、何时继续；**不自建 `search_web(query)` 封装**。是否可用及搜索结果可追溯粒度以开发阶段实际测试为准。
- **自定义 `fetch_content(url)`**：通过 Agents SDK Function Tool 接入现有抓取 / Firecrawl 能力，返回真实取得的正文、可用转写文本、来源及读取状态；明确区分完整、部分与不可获取。搜索摘要不能替代全文验证。


视频 / 播客只有在能取得足够内容用于验证时才进入最终候选。暂不专门处理付费墙。外部内容属于不可信数据，不允许其中的指令改变 Agent 的系统任务。

### 4.4 资源控制

- 对每次 Agent Run 设置最大轮数、整体超时及工具级超时；数值在实验后进入 `09-operations.md`。
- Topic Selection 的 8 条为候选线索上限；实际探索多少条由 Code 根据排序和资源预算限制，**不增加第二个 LLM Ranking 阶段**。
- Direct 验证与 Topic Discovery 可并发；采用简单的 Promise 并发与失败隔离，避免无界并发。
- Agent 达到限制时记录 `budget_exhausted` / `timeout` 等真实原因，不冒充正常完成。

## 5. Candidate Pool、验证与提交

- Direct、Topic、Open 产出的候选使用统一的内部数据契约，至少包含 URL、作品信息、发现路径、关联线索、证据、读取完整度与局限。
- Code 负责 URL 规范化、候选去重、历史重复检查、可访问性及可核查的时长 / 内容类型检查。
- LLM 负责编辑价值判断；最终候选必须关联实际读取证据，不以 Agent 自述作为已阅读全文的依据。
- 常规路径 **Direct 最多 3 篇、Topic 最多 3 篇**，最多 6 篇进入人工审核；不凑数。
- 仅当常规 Direct / Topic 均正常完成且 Code 核查后合计 0 篇合格作品时自动触发 Open；人工可在审核不满意时额外触发 Open。Open 每次最多提交 3 篇，不覆盖已有审核候选。
- 作品可以在不同路径重复发现，但应在统一 Pool 中去重并保留发现来源；最终审核列表不重复展示同一作品。

## 6. 数据持久化与执行追踪

首版使用 PostgreSQL 保存业务对象与执行 Trace，不为 Discovery 新建 `runtime/` 文件日志。**优先复用 Agents SDK 原生 Tracing 与 Processor 扩展接口**，而不是手写一套 Agent Loop 事件采集器。具体接口名称、事件结构及导出行为以开发时锁定的 SDK 版本和最小实验为准。

| 对象 | 技术职责 |
|---|---|
| `discovery_runs` | 运行 ID、触发方式、计划输入窗口、输入快照、运行状态与结束原因；人工触发 Open 能关联原运行 |
| `discovery_trace_spans`（暂定） | 保存 SDK Trace / Span 的关联 ID、父子关系、类型、时间、状态及原始结构化数据，关联业务 Run |
| `discovery_candidates` | 候选作品、发现路径、证据、验证结论及筛选状态 |
| `in_depth_candidates` | 通过机器筛选、提交人工审核的作品及审核状态 |

字段、关联、索引、状态枚举和写入事务由 `05-data-model.md` 定义。本轮不修改既有 `feedback` 表；显式 Memory 写入由独立后续能力负责。

### 6.1 Trace 的职责与存储

- **Trace** 是一次执行的逻辑调用链，不等于 `runtime/` 文件；**Span** 是其中的模型调用、工具调用或自定义业务操作等记录。
- 使用 SDK 的 Tracing Processor 接收 Trace / Span，经过敏感数据过滤后写入 PostgreSQL；优先保存 SDK 原生结构。
- 数据表只将 `run_id`、`trace_id`、`span_id`、`parent_span_id`、类型、时间等必要查询字段独立索引，其余 SDK 事件载荷放 JSONB。SDK 结构可能随版本变化，Dashboard 不直接依赖不稳定的深层字段。
- **保留业务记录与 Trace 的分工**：运行状态、上游 Daily 就绪检查、人工触发、候选审核状态属于业务表，不应仅依靠 Trace 推导。
- Topic Selection 等普通 LLM Client 调用，以及 Code 执行的关键业务检查，也需要与 Run 关联；若 SDK Trace 不会自动覆盖这些操作，使用其自定义 Span 能力或最小业务记录补充，避免误称所有步骤都由 SDK 自动捕获。
- 不默认复制完整抓取正文到每个 Span；保留必要的真实检索 URL、抓取状态、阅读证据和候选关联，避免数据库无界增长。
- 不存 API Key、认证头及其他 Secrets。需要确认 Processor 的缓冲、批量写入、异常隔离和退出前 flush 行为，防止日志写入阻塞主要业务或运行结束时丢失尾部事件。
- SDK 默认可能导出 Trace 到平台端。首版需明确数据发送策略：若只保存在本地 PostgreSQL，使用所选 SDK 版本支持的**替换默认 Processor**方式，而非无意追加双重导出。

### 6.2 可追溯与重跑

每次 Run 固定并保存计划窗口、实际输入内容 ID 与必要输入快照；相同输入允许不同探索结果，每次执行分别关联独立 Trace。Agent 的自然语言自述不能代替实际工具调用或抓取证据。状态 `timeout`、`budget_exhausted`、上游未就绪与正常空结果必须区分。

具体字段、关联、索引与约束由 `05-data-model.md` 定义。本轮不修改 `feedback`；显式 Memory 写入由后续独立能力负责。

### 6.3 人工单条线索执行（首版）

- D2 结构化输出在 Code 校验后，为每条线索分配稳定 `leadId`（例如 Run 内序号映射的 UUID）；`leadId` 不由 LLM 自由生成。审核页面展示全部线索、优先级、执行状态及关联候选。
- 人工调用参数为 `sourceRunId + leadId`，Code 从已保存的 `selection_output` 读取并校验该线索，不能信任客户端重新提交的 question / sourceContentId。
- `direct` 只执行选定作品的 D4 评价；`topic` 只执行选定问题的 D3 Agent；复用既有 Prompt、Schema、URL 去重和证据检查，不重新执行 D2。人工 Open 沿用既有入口。
- 每次人工执行创建新 `discovery_runs` 记录，`parent_run_id` 指向原常规 Run，`source_lead_id` 记录目标线索；不覆盖原候选或原执行结果。保留审核候选的历史 URL 去重规则。
- 某个分支失败时记录 `partial` / `failed` 和原因，不自动重跑，也不自动触发 Open；人工决定执行单条线索或 Open。

## 7. 运行入口、人工触发与失败处理

- 定时 / CLI 入口：创建独立 Run，固定输入窗口，运行常规 Discovery；自动 Fallback 条件以 `06a` 为准。
- 人工 Open 入口：接收原 Run 或审核批次标识及可选人工意见，创建**可关联的补充运行**；不重新执行整个 Topic Selection，也不覆盖现有候选。
- 局部分支失败时保留其他路径的有效结果；关键依赖失败、超时、正常空结果必须区分。
- 同一输入允许多次独立运行并产生不同候选；不要求跨运行结果相同，也不以幂等性为首版目标。但单次写入仍应遵守数据库完整性约束。
- 初版以人工诊断与按 Lead 单独执行为主，不建立复杂自动恢复系统。

## 8. 验证与测试

至少覆盖：

1. Topic Selection 的结构化输出验证与 8 条上限。
2. Direct / Topic 分别最多 3 篇；正常情况下最多 6 篇；Open 每次最多 3 篇。
3. Open 自动触发仅在两条常规分支均正常完成且合计 0 篇合格候选时发生；人工可单独触发，且不覆盖原候选。
4. URL 去重、历史去重及真实抓取证据校验。
5. 托管 Web Search / 抓取失败、Agent 超时、部分成功、正常空结果的状态区别。
6. SDK Trace Processor 写入数据库的关联关系、敏感信息过滤、结束时 flush，以及业务阶段 Trace 覆盖范围。
7. 输入窗口与输入内容可追溯；相同输入不同输出可独立记录。

建议用少量真实 Topic 对比固定搜索 Baseline 与自适应 Agent 的作品质量、实际工具轨迹及成本，验证 Agent Loop 是否带来足够收益；不预设复杂自动评价指标。

## 9. 实现前待核实

- Daily Brief API / 查询层的真实复用入口，以及全部 Event 的查询方式。
- 现有 Firecrawl 抓取封装能否用于 Discovery 的独立 URL。
- Agents SDK 版本、OpenAI 模型、托管 Web Search / Structured Output 的最小连通性验证。
- `webSearchTool()` 的实际结果证据格式、引用与可追溯粒度；不满足要求时再评估自定义搜索工具。
- SDK Trace Processor 接口、默认导出行为、数据库 Span 保存粒度、正文证据与保留期限。
- 两期 Daily 的日期映射、完成状态判定与补跑参数（默认 12:00）。

这些事项核实后更新对应技术或运行文档；不要将未验证的假设写成既有实现事实。
