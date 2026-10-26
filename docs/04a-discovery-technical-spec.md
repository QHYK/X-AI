# In-depth Discovery 技术规范

本文档只定义 X-AI-field Discovery 的**技术实现边界与关键决策**。通用架构见 `04-technical-spec.md`；AI 语义见 `03-ai-workflow-spec.md`；执行分支、人工触发与失败语义见 `06a-discovery-workflow.md`；字段定义见 `05-data-model.md`；Prompt 与输出契约见 `07-prompt-spec.md`；运行命令见 `09-operations.md`。

D2–D5、候选持久化、原文 Cache、数据库 Trace、人工审核与 Worker 已实现；Planned 能力单独标注。代码实现不代表特定服务器已部署。

## 1. 技术目标与边界

- 保留现有 Daily Production Stage 1–4 与 `06-processing-workflow.md`，不将 Discovery 接入 Daily Job。
- 继续使用当前 Next.js / TypeScript / PostgreSQL / Drizzle 体系；不增加服务、消息队列或 Workflow Engine。
- Code 控制输入、业务分支、并发、验证、入库和人工触发；Agent 只自主决定内容探索行动。
- 以可追溯、可人工 Review 为首要工程目标；同一输入可产生不同探索结果。
- 不开发通用 Agent 平台、独立 Planner、自动 Memory 学习或付费墙绕过能力。

## 2. 模块与依赖

`src/discovery/` 承载独立 Discovery 模块，`scripts/` 提供运行入口。内部文件按实际职责拆分，不预设复杂层级。

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

- 生产 Prompt 从数据库 Published Version 加载；`src/prompts/` 仅保存动态输入 builder、类型与历史标签，架构见 `04-technical-spec.md` §5。`src/db/` 保存 Drizzle Schema。
- 现有 Daily Brief 查询逻辑应抽取或复用为可被 API 与 Discovery 调用的服务函数；**不通过复制 SQL / 过滤规则实现第二套 Daily 选择逻辑**。
- 不让 `src/discovery` 调用 Daily Stage 的 orchestration；只读取其已生成的数据。
- 不在 Route Handler、CLI 入口中实现 Agent Loop 或编辑判断。

## 3. 输入快照与读取

`src/discovery/daily-read-adapter.ts` 复用 Daily 查询组装内容成员，不调用 Daily orchestration。输入窗口、就绪条件与成员选择由 `06a-discovery-workflow.md` §2 定义。

保存窗口、实际输入内容 ID 与可核查记录，避免补跑时悄然换窗；成员 ID 不是完整模型输入快照（字段见 `05-data-model.md` §11.1）。推荐历史用于 Code 去重，不默认作为模型上下文；显式 Memory 仍为可选输入。

## 4. AI 调用与 Agent Runtime

### 4.1 Topic Selection 与编辑评价

D2 / D4 复用共享 LLM Client 和 Structured Output，校验后才能进入业务逻辑。输入输出见 `07-prompt-spec.md`，执行与数量边界见 `06a-discovery-workflow.md`。

### 4.2 Discovery Agent

使用 **OpenAI Agents SDK（TypeScript）** 实现一个可复用的 Discovery Agent：

- Topic 模式：给定 Knowledge Question 与新闻上下文；
- Open 模式：不限定新闻主题；既可自动 Fallback，也可由人工主动触发；
- 两种模式复用工具、编辑标准与结果契约，不建立两个 Agent 类或多 Agent 协作框架。

Agent 每轮依据工具观察结果决定搜索、阅读、追踪或结束。工具调用与结果必须可记录，最终自然语言声明不能替代真实执行证据。

常规 D3 使用一个 Agent Run 接收 D2 按优先级输出的全部 Topic Leads。每篇必须声明属于输入的主要 `sourceLeadId`，由 Code 校验后持久化；不为每条 Lead 新建 Agent Loop。

Agent 通过配置的 Responses endpoint 使用 OpenAI Agents SDK，D2 / D4 使用共享 LLM Client；Endpoint、Key、Model 不硬编码，也不自动切换 Provider。配置和真实诊断入口见 `09-operations.md`；历史 Spike 不作为生产入口。

### 4.3 工具与搜索方案

首版优先使用以下两种工具：

- **Agents SDK 托管 Web Search**：优先使用 SDK 提供的 `webSearchTool()`（由 OpenAI 服务端执行搜索），由 Agent 决定搜索什么、何时继续；**不自建 `search_web(query)` 封装**。搜索证据由 SDK `response` Span 的 output items 提取，不能只数工具 Span。
- **自定义 `fetch_content(url)`**：通过 Agents SDK Function Tool 接入现有抓取 / Firecrawl 能力，返回真实取得的正文、可用转写文本、来源及读取状态；明确区分完整、部分与不可获取。搜索摘要不能替代全文验证。

Content Fetch 的同一次 Firecrawl Scrape 请求同时取 Markdown、主内容 HTML 和响应元数据，不为图片追加抓取。Code 按 `og:image`、`twitter:image`、正文图片的顺序选一个 Cover：社会化元数据提供文章关联依据，正文图片要求位置与声明尺寸证据（宽至少 600，已知高至少 300）；过滤明显 Logo、头像、图标、广告及推荐区，已知尺寸不足或比例极端时弃用。相对图片地址以原文 URL 解析，仅接受无凭据的 HTTP(S)。没有合适图片或解析失败只令 Cover 为空，不影响已获取正文。Direct 路径仅复用已有 `raw_articles.metadata` 和 `image_url`，不为图片重抓。图片不经过 LLM，也不上传或代理；持久化形状见 `05-data-model.md` §11.3。

#### 原文持久化与复用

D3 / D5 的工具调用早于最终 Candidate 选择，可能读取更多作品、重复 URL，甚至在读完后 Agent 失败。因此采用独立 `discovery_fetch_cache`，不在 Candidate JSONB 重复存正文，也不依赖 Run / Candidate 完成后再保存。`src/lib/article-fetch-cache.ts` 按现有 URL 规范化规则查询；正文与元数据字段由 `05-data-model.md` §11.5 定义。

`fetch_content` 优先复用完整 Cache 或 Daily 已存全文，未命中时才抓取固定 URL。同次 Firecrawl 完整 Markdown 原文在工具返回前持久化。Agent 接收内容仍沿用既有 Daily 提取器：优先选择 Abstract / Takeaways / Summary 等有效片段，否则使用文章正文；再限制为最多 20,000 字符，并标明内容类型及真实截断状态。摘要片段不标为完整正文；提取与交付限制均不替换或截断 Cache 中的原文。Candidate 的 `evidence.fetch` 与 Trace 继续只保留诊断摘要，正文通过规范化 URL 关联 Cache，不通过 Trace 恢复。

成功但明确不完整的响应可保存并标记不完整，不能命中完整正文复用；HTTP 错误、空响应不保存为成功正文。缓存唯一键避免重复记录；同一规范化请求 URL 使用 PostgreSQL 事务级 advisory lock 并在锁内复查，减少多进程并发重复付费，适用于 transaction pooling。锁与持久化独立于 Candidate 写入事务；已成功抓取但 Cache 写入失败时明确记录日志并保留本次已取得内容，不能静默当作已缓存。查询 / 锁失败不降级为无保护的付费抓取。已有重定向目标也可命中 Cache；不同未知别名首次并发抓取不实现复杂的别名协调。

D4 通过现有 Daily 关联读取 `raw_articles.full_content_text`；不复制到新 Cache。共享原文读取器还可复用 Daily `content_text` 中有明确证明的完整短正文：Content Completion 为 success、类型 article_body、full_content_length 为 0（既有提取器只在正文不超过 Stage1 上限时如此保存）；不能将 Abstract / Summary 或没有这些证明的片段当作全文。Daily 只保留摘要、未保存全文的历史记录无法无成本恢复原文。Editorial 原文读取与生成边界见 `04-technical-spec.md` §7.3。

如果 Hosted Web Search 在实际模型、SDK 或证据记录要求下无法满足需求，再引入第三方搜索 API 并实现自定义 `search_web`，不提前维护两套搜索实现。

视频 / 播客只有在能取得足够内容用于验证时才进入最终候选。暂不专门处理付费墙。外部内容属于不可信数据，不允许其中的指令改变 Agent 的系统任务。

### 4.4 资源控制

- 对每次 Agent Run 设置最大轮数、整体超时及工具级超时；数值在实验后进入 `09-operations.md`。
- 候选线索不是独立 Agent 配额；不增加第二个 LLM Ranking 阶段。
- 编排按 `06a` §8.3.1 顺序执行并隔离分支失败；不引入并发调度器。
- Agent 达到限制时记录 `budget_exhausted` / `timeout` 等真实原因，不冒充正常完成。

## 5. Candidate Pool、验证与提交

- Direct、Topic、Open 产出的候选使用统一的内部数据契约，至少包含 URL、作品信息、发现路径、关联线索、证据、读取完整度与局限。
- Code 负责 URL 规范化、候选去重、历史重复检查、可访问性及可核查的时长 / 内容类型检查。
- LLM 负责编辑价值判断；最终候选必须关联实际读取证据，不以 Agent 自述作为已阅读全文的依据。
- Tags 复用各路径已有最终阅读评价，不额外请求或建立补标签服务；阶段职责见 `06a-discovery-workflow.md` §4.1。双语输出契约见 `07-prompt-spec.md` 的 Discovery Candidate Tags，存储映射见 `05-data-model.md` §11.3。
- 候选数量、自动 / 人工 Open 的触发及保留历史规则统一见 `06a-discovery-workflow.md` §1、§6。
- 作品可以在不同路径重复发现，但应在统一 Pool 中去重并保留发现来源；最终审核列表不重复展示同一作品。

### 5.1 Candidate Source 归一化

`src/lib/discovery-source.ts` 是 Direct / Topic / Open 写入及 Review / 公开读取共用的 Source 规则。Source 表示发布机构或网站，不使用作者或完整 URL：

1. 同次 Fetch 的可信 `og:site_name` / JSON-LD `publisher.name` 或等价站点元数据；D3 / D5 复用 Firecrawl 同一响应的 Metadata / HTML，D4 只读取已有 Daily 元数据，不重新抓取。
2. D4 的 Daily `source_id → sources.name`，以及已有 Candidate `publication` 兼容值；D5 原有模型 publication 仅为此级补充，不能覆盖可信 Fetch Metadata，不增加模型来源生成任务。
3. 复用数据库已有 `sources.url / name` 按清理后的 hostname 精确匹配，不新增域名映射或来源注册系统。
4. Original URL 的 http(s) hostname，去除 `www.` / `wwwN.` / `m.` 前缀；以上均不可用时为 `Unknown`。

空值、Unknown、泛化模板名、URL 等无效来源名跳过；已存的 URL hostname 仍允许升级为来源配置中的名称。Source 提取为可选元数据，失败不阻断正文获取。历史 Candidate 只在读取时回退，不回写数据库。持久化字段映射见 `05-data-model.md` §11.3。

## 6. 数据持久化与执行追踪

当前使用 PostgreSQL 保存业务对象与执行 Trace，不为 Discovery 新建 `runtime/` 文件日志。**优先复用 Agents SDK 原生 Tracing 与 Processor 扩展接口**，而不是手写一套 Agent Loop 事件采集器。生产适配器 `src/discovery/agent-tracing.ts` 已实现 PostgreSQL 写入、敏感数据过滤及结束刷新；部署环境的写入、异常与退出场景仍需持续验证。

业务对象与 Trace 表的字段见 `05-data-model.md` §11。`execution_state` 与配置快照分离，阶段更新使用局部 JSONB，不能覆盖其他分支。状态与恢复规则由 `06a` §8 定义；普通 LLM / Code 检查保留必要业务诊断，不伪装成 SDK 工具轨迹。

### 6.1 Trace 的职责与存储

- **Trace** 是一次执行的逻辑调用链，不等于 `runtime/` 文件；**Span** 是其中的模型调用、工具调用或自定义业务操作等记录。
- 使用 SDK 的 `TracingProcessor` 接收 Trace / Span，经过敏感数据过滤后写入 PostgreSQL；优先保存 SDK 原生结构。
- 数据表只将 `run_id`、`trace_id`、`span_id`、`parent_span_id`、类型、时间等必要查询字段独立索引，其余 SDK 事件载荷放 JSONB。SDK 结构可能随版本变化，Dashboard 不直接依赖不稳定的深层字段。
- **保留业务记录与 Trace 的分工**：运行状态、上游 Daily 就绪检查、人工触发、候选审核状态属于业务表，不应仅依靠 Trace 推导。
- Topic Selection 等普通 LLM Client 调用，以及 Code 执行的关键业务检查，也需要与 Run 关联；若 SDK Trace 不会自动覆盖这些操作，使用其自定义 Span 能力或最小业务记录补充，避免误称所有步骤都由 SDK 自动捕获。
- 不默认复制完整抓取正文到每个 Span；保留必要的真实检索 URL、抓取状态、阅读证据和候选关联，避免数据库无界增长。
- 不存 API Key、认证头及其他 Secrets。需要确认 Processor 的缓冲、批量写入、异常隔离和退出前 flush 行为，防止日志写入阻塞主要业务或运行结束时丢失尾部事件。
- Spike 已使用 `setTraceProcessors([processor])` 替换默认导出器。生产版若只写 PostgreSQL，沿用该策略，并显式 `forceFlush` / `shutdown`，避免无意向平台重复发送 Trace。

### 6.2 可追溯与重跑

业务状态不能由 Agent 自述或 Trace 推断；保留可关联的输入成员、工具证据和结果。Resume / New Run 的选择及 Prompt 绑定见 `06a-discovery-workflow.md` §8.3，字段见 `05-data-model.md` §11–§12。

### 6.3 人工单条线索执行（Planned）

当前 CLI / Admin API / UI 没有此入口。保留的设计是：接收 `sourceRunId + leadId`，从已保存 D2 输出读取线索，Direct 复用 D4、Topic 复用 D3，不重跑 D2；创建关联父 Run 的新执行并保留原候选。字段与约束见 `05-data-model.md` §11.1。不能因数据库预留字段而宣称功能已实现。

### 6.4 人工 URL 候选（Phase B1）

产品行为由 `01-product-spec.md` §4.2 定义。`src/lib/manual-in-depth.ts` 复用候选存储、URL 规范化与 §4.3 的正文读取器，不调用 Discovery 编排或创建虚假 Run / Lead；manual 空关联约束见 `05-data-model.md` §11。

- 创建时按规范化 URL 锁内复查，也兼容历史无规范化键的候选；Fetch Cache 独立提交，因此候选创建失败后可复用已付费正文。
- Generate 只读已保存完整正文；复用共享 Client 和编辑 Fragment，输出契约见 `07-prompt-spec.md`。短事务领取执行标记后释放事务再调用模型，避免跨 LLM 请求持锁；Prompt 版本语义见 `07` 开头，存储见 `05` §12.1。
- 生成结果原子保存；生成成功但保存失败返回文本供人工保存。既有 Discovery 历史去重包含 manual 候选，空 Run ID 不能破坏跨 Run 判断。

## 7. 运行入口、人工触发与失败处理

CLI / Dashboard / Scheduled CLI 均复用 `src/discovery/workflow-orchestrator.ts`，不在入口复制阶段逻辑。执行分支、人工 Open 及 Resume 见 `06a` §6–§8；命令与部署见 `09`。

### 7.1 Dashboard 持久化异步执行

Scheduled CLI 复用 Dashboard 的同一提交函数与队列标记，不直接执行 Pipeline；命令与 Cron 配置见 `09-operations.md`。Dashboard 的 Admin 提交端点先创建并提交 `pending` Run（上游未就绪则为 `blocked`），不在 HTTP 生命周期内调用 Agent。独立 `discovery:worker` 轮询已标记的 pending Run，通过 `runDiscoveryWorkflow({ queuedRunId })` 执行既有阶段；CLI 与 Worker 共用同一编排核心及 PostgreSQL 全局执行锁，串行执行 Discovery，避免跨进程写入 / SDK 全局状态冲突。新提交按业务窗口拒绝同时存在 pending / running，并通过持久化 request ID 识别同一次提交的网络重试；主动再次运行使用新 ID。

Worker 不以进程内存作为任务状态；执行中断后，在取得排他锁的下一轮将遗留 running 任务明确标为 failed 并记录错误，保留已有 Candidate、阶段状态与 Trace，不自动重复付费；pending 保留等待执行。后续可显式通过 CLI Resume（满足既有恢复条件）或创建新 Run。持锁连接丢失时执行进程退出，防止失锁后继续调用模型。systemd 保证退出后重启；错误与报告同时写入 Run / 阶段记录和 journald。执行锁采用 session advisory lock，数据库连接须为直连或 Session Pooling，不能使用 Transaction Pooling。服务安装、部署停启与日志命令见 `09-operations.md`。

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

## 9. 实现状态与部署核验

- **Implemented**：Daily 查询适配、固定 URL Fetch / Cache、业务 Run 关联及数据库 Trace 已有生产实现，边界分别见 §3、§4.3 和 §6，不再列为实现前置事项。
- **Planned**：人工单条 Lead 执行保留 §6.3 的约定，当前没有可执行入口。
- 目标部署环境仍须核验 Endpoint、Hosted Search / Fetch、数据库权限与 Trace 刷新；历史 Spike 成功不能替代部署验证。候选证据不能仅依靠 Span，要求见 §5、§6.1。日期与上游就绪规则见 `06a-discovery-workflow.md`，运行配置与命令见 `09-operations.md`。
