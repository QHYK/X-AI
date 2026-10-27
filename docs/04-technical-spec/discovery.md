# In-depth Discovery 技术规范

本文档只定义 X-AI-field Discovery 的**技术实现边界与关键决策**。通用架构见 `architecture.md`；AI 语义见 `../03-ai-workflow-spec.md`；执行分支、人工触发与失败语义见 `../06-workflow-spec/discovery.md`；字段定义见 [Data Model](../05-data-model/discovery.md)；Prompt 与输出契约见 `../07-prompt-spec/discovery.md`；运行命令见 `../09-operations.md`。

D2–D5、候选持久化、原文 Cache、数据库 Trace、人工审核与 Worker 已实现；Planned 能力单独标注。代码实现不代表特定服务器已部署。

## 1. 技术目标与边界

- 保留现有 Daily Production Stage 1–4 与 `../06-workflow-spec/daily.md`，不将 Discovery 接入 Daily Job。
- 继续使用当前 Next.js / TypeScript / PostgreSQL / Drizzle 体系；不增加外部队列服务或 Workflow Engine；复用 PostgreSQL 保存轻量任务状态。
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

- 生产 Prompt 从数据库 Published Version 加载；`src/prompts/` 仅保存动态输入 builder、类型与历史标签，架构见 `architecture.md` §5。`src/db/` 保存 Drizzle Schema。
- 现有 Daily Brief 查询逻辑应抽取或复用为可被 API 与 Discovery 调用的服务函数；**不通过复制 SQL / 过滤规则实现第二套 Daily 选择逻辑**。
- 不让 `src/discovery` 调用 Daily Stage 的 orchestration；只读取其已生成的数据。
- 不在 Route Handler、CLI 入口中实现 Agent Loop 或编辑判断。

## 3. 输入快照与读取

`src/discovery/daily-read-adapter.ts` 复用 Daily 查询组装内容成员，不调用 Daily orchestration。输入窗口、就绪条件与成员选择由 `../06-workflow-spec/discovery.md` §2 定义。

Run 保存窗口、成员 ID 与 D2 `selection_output`，Resume 复用其关联，不重新选择窗口或 Lead。成员 ID 固定的是集合，读取时仍可能使用当前数据库字段，不是完整历史模型输入快照。**Resume 是继续已有业务状态，不等于完全相同输入的 Replay**；不承诺从 Trace 还原原始输入。

D2–D5 按 Request Key 在首次实际执行前绑定 Published Version，存于 `config_snapshot.promptVersions`；`databasePromptBinder()` 用短事务行锁保证并发首次绑定一致，提交失败不发出模型请求。Resume 复用已有绑定，尚未执行的阶段才选择 Active；Agent Loop 内固定该次 Prompt。实现见 `src/lib/prompts/runtime.ts` 和阶段入口，通用版本契约见 [Prompt Registry](../07-prompt-spec/registry.md)。推荐历史用于 Code 去重，不默认作为模型上下文；显式 Memory 仍为可选输入。字段见 [Discovery Data Model](../05-data-model/discovery.md) / [Prompt Registry Data Model](../05-data-model/prompt-registry.md)。

## 4. AI 调用与 Agent Runtime

### 4.1 Topic Selection 与编辑评价

D2 / D4 复用共享 LLM Client 和 Structured Output，校验后才能进入业务逻辑。输入输出见 `../07-prompt-spec/discovery.md`，执行与数量边界见 `../06-workflow-spec/discovery.md`。

### 4.2 Discovery Agent

使用 **OpenAI Agents SDK（TypeScript）** 实现一个可复用的 Discovery Agent：

- Topic 模式：给定 Knowledge Question 与新闻上下文；
- Open 模式：不限定新闻主题；既可自动 Fallback，也可由人工主动触发；
- 两种模式各有执行适配器，复用工具、编辑标准与结果契约，不建立多 Agent 协作框架。

Agent 每轮依据工具观察结果决定搜索、阅读、追踪或结束。工具调用与结果必须可记录，最终自然语言声明不能替代真实执行证据。

常规 D3 使用一个 Agent Run 接收 D2 按优先级输出的全部 Topic Leads。每篇必须声明属于输入的主要 `sourceLeadId`，由 Code 校验后持久化；不为每条 Lead 新建 Agent Loop。

Agent 通过配置的 Responses endpoint 使用 OpenAI Agents SDK，D2 / D4 使用共享 LLM Client；Endpoint、Key、Model 不硬编码，也不自动切换 Provider。配置和真实诊断入口见 `../09-operations.md`；历史 Spike 不作为生产入口。

### 4.3 工具与搜索方案

首版优先使用以下两种工具：

- **Agents SDK 托管 Web Search**：优先使用 SDK 提供的 `webSearchTool()`（由 OpenAI 服务端执行搜索），由 Agent 决定搜索什么、何时继续；**不自建 `search_web(query)` 封装**。搜索证据由 SDK `response` Span 的 output items 提取，不能只数工具 Span。
- **自定义 `fetch_content(url)`**：通过 Agents SDK Function Tool 接入现有抓取 / Firecrawl 能力，返回真实取得的正文、可用转写文本、来源及读取状态；明确区分完整、部分与不可获取。搜索摘要不能替代全文验证。

Content Fetch 的同一次 Firecrawl Scrape 请求同时取 Markdown、主内容 HTML 和响应元数据，不为图片追加抓取。Code 按 `og:image`、`twitter:image`、正文图片的顺序选一个 Cover：社会化元数据提供文章关联依据，正文图片要求位置与声明尺寸证据（宽至少 600，已知高至少 300）；过滤明显 Logo、头像、图标、广告及推荐区，已知尺寸不足或比例极端时弃用。相对图片地址以原文 URL 解析，仅接受无凭据的 HTTP(S)。没有合适图片或解析失败只令 Cover 为空，不影响已获取正文。Direct 路径仅复用已有 `raw_articles.metadata` 和 `image_url`，不为图片重抓。图片不经过 LLM，也不上传或代理；持久化形状见 [discovery_candidates](../05-data-model/discovery.md#discovery_candidates)。

#### 原文持久化与复用

D3 / D5 的工具调用早于最终 Candidate 选择，可能读取更多作品、重复 URL，甚至在读完后 Agent 失败。因此采用独立 `discovery_fetch_cache`，不在 Candidate JSONB 重复存正文，也不依赖 Run / Candidate 完成后再保存。`src/lib/article-fetch-cache.ts` 按现有 URL 规范化规则查询；正文与元数据字段由 [discovery_fetch_cache](../05-data-model/discovery.md#discovery_fetch_cache) 定义。

`fetch_content` 优先复用完整 Cache 或 Daily 已存全文，未命中时才抓取固定 URL。同次 Firecrawl Markdown（保留完整响应，不用摘要提取结果替换）正常在工具返回前提交 Cache；保存失败的例外见下文。Agent 接收内容仍沿用既有 Daily 提取器：优先选择 Abstract / Takeaways / Summary 等有效片段，否则使用文章正文；再限制为最多 20,000 字符，并标明内容类型及真实截断状态。摘要片段不标为完整正文；提取与交付限制均不替换或截断 Cache 中的原文。Candidate 的 `evidence.fetch` 与 Trace 继续只保留诊断摘要，正文通过规范化 URL 关联 Cache，不通过 Trace 恢复。

成功但明确不完整的响应可保存并标记不完整，不能命中完整正文复用；HTTP 错误、空响应不保存为成功正文。缓存唯一键避免重复记录；同一规范化请求 URL 使用 PostgreSQL 事务级 advisory lock 并在锁内复查，正常持锁期间串行抓取，兼容 transaction pooling（Discovery 执行锁另有连接模式要求）。锁与持久化独立于 Candidate 写入事务；已成功抓取但 Cache 写入失败时明确记录日志并保留本次已取得内容，不能静默当作已缓存。查询 / 锁失败不降级为无保护的付费抓取。已有重定向目标也可命中 Cache；不同未知别名首次并发抓取不实现复杂的别名协调。

D4 通过现有 Daily 关联读取 `raw_articles.full_content_text`；不复制到新 Cache。共享原文读取器还可复用 Daily `content_text` 中有明确证明的完整短正文：Content Completion 为 success、类型 article_body、full_content_length 为 0（既有提取器只在正文不超过 Stage1 上限时如此保存）；不能将 Abstract / Summary 或没有这些证明的片段当作全文。Daily 只保留摘要、未保存全文的历史记录无法无成本恢复原文。Editorial 原文读取与生成边界见 `admin-api.md` §7.3。

当前生产工具只有托管 Web Search 与固定 URL Fetch；没有第三方搜索 fallback。

视频 / 播客只有在能取得足够内容用于验证时才进入最终候选。暂不专门处理付费墙。外部内容属于不可信数据，不允许其中的指令改变 Agent 的系统任务。

#### Fetch 事务与连接占用

`getOrFetchArticle()` 的事务从获取 URL 锁持续至网络 Fetch、Cache 写入和提交，**长事务尚未消除**。锁等待设为 120 秒；这不是事务总时长上限。生产 Agent 工具在 Cache 路径将 Fetch 重试设为 0，单次 HTTP 有 `AbortSignal.timeout`；超时配置由 D3/D5 config 传入，实际默认值及环境变量以 [Operations](../09-operations.md) 和 `fetch-content.ts` 为准。

Fetch 期间占用一条 Pool Client。连接或事务被服务端中断时会记录错误并回滚，已取得正文可带 `cacheWarning` 返回，但不算持久化成功，后续仍可能重复付费。未知重定向别名首次并发也不保证去重。服务端 `idle_in_transaction_session_timeout` / `statement_timeout` 与连接预算无法由仓库确认，部署时必须与网络 Fetch 预算一起核验；不能描述为已通过真实环境验收。

### 4.4 资源控制

- 对每次 Agent Run 设置最大轮数、整体超时及工具级超时；配置入口见 [Operations](../09-operations.md)，真实默认值由对应 config parser 定义。
- 候选线索不是独立 Agent 配额；不增加第二个 LLM Ranking 阶段。
- 编排按 `../06-workflow-spec/discovery.md` §8.3.1 顺序执行并隔离分支失败；不引入并发调度器。
- Agent 达到限制时记录 `budget_exhausted` / `timeout` 等真实原因，不冒充正常完成。
- Runner 的整体 AbortSignal 与 Firecrawl 的单次 HTTP 超时分别生效；不能据此宣称数据库等待、Trace flush 和全部工具 I/O 都共享同一取消边界。

## 5. Candidate Pool、验证与提交

- Direct、Topic、Open 产出的候选使用统一的内部数据契约，至少包含 URL、作品信息、发现路径、关联线索、证据、读取完整度与局限。
- Code 负责 URL 规范化、候选去重、历史重复检查、可访问性及可核查的时长 / 内容类型检查。
- LLM 负责编辑价值判断；D3/D5 候选与本次实际成功 Fetch 记录关联。当前应用校验不等同于强制全文完整交付，阅读与证据契约见 [Discovery Prompt](../07-prompt-spec/discovery.md)；不能以 Agent 自述作为已阅读全文的证明。
- Tags 复用各路径已有最终阅读评价，不额外请求或建立补标签服务；阶段职责见 `../06-workflow-spec/discovery.md` §4.1。双语输出契约见 `../07-prompt-spec/discovery.md` 的 Discovery Candidate Tags，存储映射见 [discovery_candidates](../05-data-model/discovery.md#discovery_candidates)。
- 候选数量、自动 / 人工 Open 的触发及保留历史规则统一见 `../06-workflow-spec/discovery.md` §1、§6。
- 作品可以在不同路径重复发现，但应在统一 Pool 中去重并保留发现来源；最终审核列表不重复展示同一作品。

### 5.1 Candidate Source 归一化

`src/lib/discovery-source.ts` 是 Direct / Topic / Open 写入及 Review / 公开读取共用的 Source 规则。Source 表示发布机构或网站，不使用作者或完整 URL：

1. 同次 Fetch 的可信 `og:site_name` / JSON-LD `publisher.name` 或等价站点元数据；D3 / D5 复用 Firecrawl 同一响应的 Metadata / HTML，D4 只读取已有 Daily 元数据，不重新抓取。
2. D4 的 Daily `source_id → sources.name`，以及已有 Candidate `publication` 兼容值；D5 原有模型 publication 仅为此级补充，不能覆盖可信 Fetch Metadata，不增加模型来源生成任务。
3. 复用数据库已有 `sources.url / name` 按清理后的 hostname 精确匹配，不新增域名映射或来源注册系统。
4. Original URL 的 http(s) hostname，去除 `www.` / `wwwN.` / `m.` 前缀；以上均不可用时为 `Unknown`。

空值、Unknown、泛化模板名、URL 等无效来源名跳过；已存的 URL hostname 仍允许升级为来源配置中的名称。Source 提取为可选元数据，失败不阻断正文获取。历史 Candidate 只在读取时回退，不回写数据库。持久化字段映射见 [discovery_candidates](../05-data-model/discovery.md#discovery_candidates)。

## 6. 数据持久化与执行追踪

当前使用 PostgreSQL 保存业务对象与执行 Trace，不为 Discovery 新建 `runtime/` 文件日志。**优先复用 Agents SDK 原生 Tracing 与 Processor 扩展接口**，而不是手写一套 Agent Loop 事件采集器。生产适配器 `src/discovery/agent-tracing.ts` 已实现 PostgreSQL 写入、敏感数据过滤及结束刷新；部署环境的写入、异常与退出场景仍需持续验证。

业务对象与 Trace 表的字段见 [Data Model](../05-data-model/discovery.md)。`execution_state` 与配置快照分离，阶段更新使用局部 JSONB，不能覆盖其他分支。状态与恢复规则由 `../06-workflow-spec/discovery.md` §8 定义；普通 LLM / Code 检查保留必要业务诊断，不伪装成 SDK 工具轨迹。

### 6.1 Trace 与 Usage 的失败边界

`src/discovery/agent-tracing.ts` 通过 SDK Processor 接收 Trace / Span，过滤敏感数据后写 `discovery_trace_spans`；生产 D3/D5 使用 `setTraceProcessors([processor])` 替换默认 exporter，并在结束时调用 `finishDiscoveryTrace()`。

- Trace 是诊断调用链，不代替业务 Run、阶段状态、Candidate 或原文 Cache；不复制整篇抓取正文，不保存 Key / 认证头。
- `forceFlush()` 串行写入，仅在某 Span 写入成功后移除对应 pending 项；部分失败保留未写项并记录日志。缓冲最多 1000 项，超限明确记录丢弃。
- 结束时尝试 SDK flush 和 Processor shutdown；shutdown 再 flush，仍未写入的项记录丢弃并清空。此缓冲不是持久化重试队列，进程退出后不能恢复。
- `finishDiscoveryTrace()` 隔离 flush / shutdown 异常，返回 `traceFlushed`，不覆盖 Agent 成功结果或原业务异常；Candidate 仍走自己的业务持久化。
- D2/D4 Usage 来自共享 Client 的模型响应；D3/D5 在 SDK `response` Span 结束时采集真实响应 Usage，在内存汇总后写阶段 `execution_state`，不靠已落库 Trace 重建。因此 **Trace 写库失败不等于 Usage 保存失败**，但 Usage 仍依赖 SDK 响应事件及业务状态写入，并非完全独立于 Tracing 的采集通道。

`src/discovery/execution-diagnostics.ts` 统一 Usage：多次调用累加，已知部分值可保留并标记不完整；缺失缓存统计保持 null，不伪造 0。缓存命中率仅在完整 Usage 且输入 Token > 0、缓存数合法时计算，UI 转为百分比，否则 N/A。模型 Cached Input Tokens 与文章 Fetch Cache 命中、工具调用次数、抓取字符数无关；历史 Run 不从这些数据估算 Token。

### 6.2 可追溯与重跑

业务状态不能由 Agent 自述或 Trace 推断；保留可关联的输入成员、工具证据和结果。已持久化 completed 阶段在 Resume 中复用；模型已付费返回但业务结果尚未保存即崩溃，仍可能需要重新执行，不能承诺 exactly-once。Resume / New Run 的选择及 Prompt 绑定见 `../06-workflow-spec/discovery.md` §8.3，字段见 [Discovery Data Model](../05-data-model/discovery.md) / [Prompt Registry Data Model](../05-data-model/prompt-registry.md)。

### 6.3 人工单条线索执行（Planned）

当前 CLI / Admin API / UI 没有此入口。保留的设计是：接收 `sourceRunId + leadId`，从已保存 D2 输出读取线索，Direct 复用 D4、Topic 复用 D3，不重跑 D2；创建关联父 Run 的新执行并保留原候选。字段与约束见 [discovery_runs](../05-data-model/discovery.md#discovery_runs)。不能因数据库预留字段而宣称功能已实现。

### 6.4 人工 URL 候选（Phase B1）

产品行为由 `../01-product-spec.md` §4.2 定义。`src/lib/manual-in-depth.ts` 复用候选存储、URL 规范化与 §4.3 的正文读取器，不调用 Discovery 编排或创建虚假 Run / Lead；manual 空关联约束见 [Data Model](../05-data-model/discovery.md)。

- 创建时按规范化 URL 锁内复查，也兼容历史无规范化键的候选；Fetch Cache 独立提交，因此候选创建失败后可复用已付费正文。
- Generate 只读已保存完整正文；复用共享 Client 和编辑 Fragment，输出契约见 `../07-prompt-spec/editorial.md`。短事务领取执行标记后释放事务再调用模型，避免跨 LLM 请求持锁；Prompt 版本语义见 `../07-prompt-spec/registry.md` 开头，存储见 [版本绑定载体](../05-data-model/prompt-registry.md#版本绑定载体)。
- 生成结果在短事务中原子保存，并检查 Editorial 内容基线；并发保护与冲突响应统一见 [Editorial](admin-api.md#in-depth-editorial-introduction)。生成成功但保存失败返回文本供人工保存。既有 Discovery 历史去重包含 manual 候选，空 Run ID 不能破坏跨 Run 判断。

## 7. 运行入口、人工触发与失败处理

CLI / Dashboard / Scheduled CLI 均复用 `src/discovery/workflow-orchestrator.ts`，不在入口复制阶段逻辑。执行分支、人工 Open 及 Resume 见 `../06-workflow-spec/discovery.md` §6–§8；命令与部署见 `../09-operations.md`。

### 7.1 Dashboard 持久化异步执行

`src/discovery/background-jobs.ts` 提交任务，`scripts/run-discovery-worker.ts` 独立轮询；HTTP / Scheduled CLI 不执行付费模型。

- 提交在同一 Client 的短事务内获取提交锁，完成 Request ID 幂等检查、同窗口 pending/running 检查、输入读取和 Run 创建，不在持锁时再从同一 Pool 取连接。提交锁等待上限 5 秒，异常回滚；回滚失败销毁连接。
- Request ID 只重用匹配日期、模式和触发来源的原提交；Scheduled 固定请求标识使同日幂等，人工再次运行用新 ID。上游不就绪可保存 `blocked`，不执行模型。
- Worker 在全局执行锁内取有 `dashboardJob` 标记的 pending Run，交给 `runDiscoveryWorkflow({ queuedRunId })`；阶段状态局部更新，不能整体覆盖其他分支。

### 7.2 全局执行锁与连接池

`withDiscoveryExecutionLock()` 持有 PostgreSQL Session Advisory Lock `(736210, 1)`，直到整个执行结束后释放 Client；提交锁 `(736210, 2)` 不替代执行锁。Worker、CLI 和正式真实诊断入口均需经过执行锁，拿不到锁不得执行付费工作；低层可注入 Mock 的阶段函数不因此强制要求真实锁。

持锁 Client 的 error handler 记录失锁并 `process.exit(1)`，目的是终止可能继续付费或写入的执行者。**F11：这一失锁行为尚未经过真实 PostgreSQL / 部署环境验收**，不保证所有网络分区和服务端回收都已验证。连接必须为直连或 Session Pooling，不能使用 Transaction Pooling；进程重启依赖部署配置，不是数据库自动恢复。

Pool 配置集中在 `src/db/pool-options.ts`：Web max 5，Worker / Discovery CLI max 10，Scheduled submission max 1；连接等待 5 秒、空闲回收 10 秒。这些是每进程预算，包含独占锁连接；不是数据库可用额度，也不是查询 / 事务总超时。Web 提交和轮询复用进程 Pool，多进程总量及服务端额度需另行核验。

### 7.3 Retry 与 interrupted recovery

- **Retry D2**：`submitDiscoveryD2Retry()` 在提交事务中锁 Run；仅允许已有输入成员和 D2 Prompt 绑定、D2 failed、没有 selection_output / 下游阶段 / 候选的 failed Regular Run。提交变为 pending，保留 Run、窗口、输入和版本；重试 Request ID 记录在既有队列 JSONB 中，重复请求不再排队。Worker 重新执行 D2，成功后继续原 D3/D4 流程。
- **Retry Discovery / Retry Open**：前者新建 Regular Run，后者创建关联已有 Regular 的 Open 子 Run；不覆盖旧候选。其业务分支和 Resume 条件以 [Discovery Workflow](../06-workflow-spec/discovery.md) 为准。
- **Worker 中断**：下次拿到执行锁后，只将带 `dashboardJob` 的遗留 running 标为 failed，保留成功步骤和候选，不自动重新付费；pending 留待执行。
- **CLI 中断**：不是由 Worker 自动恢复。CLI 显式 `--run-id` 配合 `--recover-interrupted`，拿到全局锁后检查原 Run 类型、窗口、已保存 D2 Leads 及阶段状态；合法时将 running 标为 failed，再沿同一 Run Resume。缺 D2 输出或状态含糊则明确拒绝，不能按运行时间猜测死亡，也不创建替代 Run。具体参数见 [Operations](../09-operations.md)。

### 7.4 Read More Singleflight

Read More 复用 PostgreSQL 会话互斥能力，但属于独立按需 API，不属于 D2–D5，也不占 Discovery 全局执行锁。`src/lib/read-more-singleflight.ts` 以规范化 `content_id` 构造独立锁键：

1. 外层查缓存；未命中才尝试 Session Lock，取得后再次查缓存。
2. 生成者在同一 Client 完成 Prompt 绑定短事务、模型调用与缓存写入；**模型期间持有连接和 Session Lock，不保持长事务**。
3. 等待者使用非阻塞 try-lock，每次失败即归还 Client，按有限等待预算定期重试；Pool 等待与单次锁查询另有有限超时，因此锁等待预算不是整个 HTTP 的截止时间。
4. 成功保存后解锁；异常销毁不确定会话。连接报错时通过 AbortSignal 请求取消模型，保存前再次检查，不能保证 Provider 撤销已开始的计费。

相同 ID 正常并发复用已保存结果，不同 ID 不共享锁；仍受总 Pool 容量限制。生成失败不缓存失败结果，缓存写入失败明确失败。已知 Transaction Pooling 配置被拒绝，未知代理模式仍需部署核验。Route 响应、LLM 超时和代理前提见 [Read More API](admin-api.md#62-read-more)。这不是故障条件下的 exactly-once 计费系统；真实跨进程互斥尚待独立 PostgreSQL 验收。

## 8. 验证边界

Mock 回归保护任务提交、Run / Prompt 复用、工具证据、Trace 故障隔离、Usage 以及缓存互斥。按场景的测试与真实付费诊断入口统一见 [Operations](../09-operations.md)，本文件不维护第二份命令或验收清单。

Mock 不能证明实际 Session Pooling、锁连接失效时序、服务器超时或连接额度；真实数据库和部署验收应独立记录，不以已有诊断脚本或历史 Spike 成功代替。

## 9. 实现状态与部署核验

- **Implemented**：Daily 查询适配、固定 URL Fetch / Cache、业务 Run 关联及数据库 Trace 已有生产实现，边界分别见 §3、§4.3 和 §6，不再列为实现前置事项。
- **Planned**：人工单条 Lead 执行保留 §6.3 的约定，当前没有可执行入口。
- 目标部署环境仍须核验 Endpoint、Hosted Search / Fetch、数据库权限与 Trace 刷新；历史 Spike 成功不能替代部署验证。候选证据不能仅依靠 Span，要求见 §5、§6.1。日期与上游就绪规则见 `../06-workflow-spec/discovery.md`，运行配置与命令见 `../09-operations.md`。
