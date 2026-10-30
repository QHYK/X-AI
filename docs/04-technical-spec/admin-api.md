# 后台与 API 技术边界

## 1. Presentation Layer

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

## 2. 路由与 URL

后台页面通过 `src/app/(admin)/layout.tsx` 共享布局；Route Group 只改变源码组织，不改变 `/dashboard/*`、`/review/*`、`/prompts`、`/memories` URL。`src/app/admin-navigation.ts` 是 Sidebar 配置唯一来源，不负责认证或注册路由。

浏览器 URL 遵循**相对路径优先**：既有 `./`、`../` 构造保持相对形式，迁移 API 时只改必要路径；复用 URL 时须按每个调用页面核对层级。Next.js `Link`、服务端重定向和 Proxy Matcher 按各自路径规则处理。`basePath=/ai` 由 Next.js 路由配置处理，不在浏览器相对 URL 或 Matcher 中重复加入 `/ai`。

## 3. 鉴权与请求安全

`/dashboard/*`、`/review/*`、`/prompts` 与 `/memories` 是后台页面，保留现有 URL；`/api/admin/*` 是后台 API。二者均要求单管理员 Session。未登录页面跳转 `/login`，未登录 API 返回 JSON 401。`/`、`/api/in-depth`、`/api/brief` 和 `/api/content/read-more` 保持匿名访问。登录与退出端点位于 `/api/auth/*`。

管理员密码以服务端环境变量中的 scrypt hash 配置。登录后生成随机、不透明的 Session Cookie；服务端文件存储其 hash 对应的会话记录和过期时间，独立于业务数据库及 `runtime/` Pipeline Artifacts。退出删除记录；密码 hash 变化会使旧会话失效。不使用用户表或 RBAC。Proxy 保护页面和管理 API，每个管理 Route Handler 还独立校验 Session；修改数据或触发任务的请求校验同源 Origin。Cookie 的 Secure 属性由部署配置决定。

Session 依赖服务端文件目录，不因进程内存清空而消失；多实例若不共享该目录，不能假定 Session 可跨实例读取。Cookie 安全属性和 HTTP 部署风险见 [Operations](../09-operations.md)，本文件不引入用户表、RBAC 或新的认证机制。

## 4. 请求校验与异步提交

`src/app/api/admin/discovery/route.ts` 的 `POST /api/admin/discovery` 在鉴权后严格校验输入及 `confirmPaid=true`：

- Regular / Open 提交接收业务日期、mode 和 Request ID；Retry D2 接收 mode=d2、Run ID 和 Request ID。
- 仅提交持久化任务，成功返回 **202** 和 Run ID / 当前状态；可能返回 blocked，并不代表模型已执行。
- 参数错误 **400**，提交冲突 **409**，未分类提交错误 **500**。重试相同请求可返回原任务，不重复创建。
- `GET /api/admin/discovery?id=UUID` 只读轮询并返回 no-store；非法 ID **400**，不存在 **404**，读取失败 **500**。

任务、互斥、D2 Retry 与恢复限制统一见 [Discovery §7](discovery.md#7-运行入口人工触发与失败处理)。其他端点不套用上述状态码；例如 Read More 保留 §6.2 的匿名响应契约。

## 5. 数据读取与状态隔离

公开查询只读取允许发布的 Production 字段，不返回 Review notes、内部 evidence/evaluation、调试信息或原始正文。In-depth 依靠 Approved 状态过滤；Event 依靠其发布状态和正式来源关系，具体持久化见 [Daily](daily.md)。

Dashboard 的 Prompt 版本展示按各阶段已保存的精确 UUID 批量关联 Registry Published Request 的 `version`，显示 `vN`；不读取当前 Active、不展示 Fragment，缺失或无法匹配时显示 `—`。Stage3 分 Event / Digest / Long-form；D5 使用当前 Card 所属 Run（包括独立 Open Run）的绑定，不能沿用 Regular Run 的版本。

Dashboard 是只读观察入口和显式管理操作入口，不是业务 Source of Truth；状态、Usage 或 Job Report 缺失时保持未知，不能从当前内容反推出历史执行成功。Evaluation 与正式结果隔离；Editorial、审核状态和 Notes 各自保存，不借一个 action 隐式修改其他控制对象。

## 6. API 与展示边界

下列定义跨项目 API 和重要错误 / 一致性边界；完整字段校验由实际 Route 与服务维护，不复制全部 Endpoint Schema。

### 6.1 Daily Brief API
```text
GET /api/brief?date=YYYY-MM-DD
```
Daily Brief API 按指定日期提供 publish-ready 内容。它读取 Production 数据，不额外创建 `daily_briefs` snapshot 层，并作为 X-AI-field 与 X-field 之间的 Presentation Boundary。

Daily membership、Ranking 与 Composition 的执行语义见 `../06-workflow-spec/daily.md`。

### 6.2 Read More
```text
POST /api/content/read-more
{ "contentId": "processed_contents.id" }
```
Read More 是匿名按需生成能力，不返回原始正文。缓存唯一键为 `content_read_more.content_id`；缓存命中先返回，未命中按内容 ID Singleflight，获取生成权后复查并生成、持久化。锁与连接生命周期见 [Discovery §7.4](discovery.md#74-read-more-singleflight)，正文资格与输出校验见 [Editorial Prompt](../07-prompt-spec/editorial.md#read-more--on-demand-detailed-summary)。

实际 Route 为 `src/app/api/content/read-more/route.ts`，响应保留现有语义：

| 情况 | HTTP / JSON |
|---|---|
| JSON 或 contentId 非法 | 400，`error` |
| 已有 / 新保存摘要 | 200，`{status: "success", summary_zh}` |
| 无合格正文且没有缓存 | 200，`{status: "not_available"}` |
| 生成、数据库或保存失败 | 200，`{status: "temporarily_unavailable"}`，服务端记录错误 |
| 生成互斥等待超时 | 同上，并含 `reason: "generation_wait_timeout"` |

等待预算默认 130 秒；LLM 使用 `READ_MORE_LLM_TIMEOUT_MS`（默认 120 秒），禁止自动重试。Route 为 Node.js，未声明 `maxDuration`；自托管 Next.js 的代理 / 上游超时须覆盖等待后可能执行的生成与数据库操作，不能将模型超时当作整个 HTTP 的截止时间。跨进程互斥要求所有 Web 实例连接同一数据库并使用直连或 Session Pooling；当前代码不支持 Transaction Pooling。

### 6.3 管理端点边界

管理端点位于 `/api/admin/*`，复用 §3 的服务端鉴权。Discovery 异步提交契约见 §4；人工编辑、Review 与 Evaluation 见 §7。端点参数以各 Route 的运行时校验为准，不在文档复制完整 Schema。

---

## 7. Internal Dashboard

X-AI-field 包含一个 Internal Dashboard，用于运行观察、Human Review 与 Model Evaluation。

后台外壳与导航边界见 §2；登录和启动页不显示 Sidebar，公开 In-depth 由 X-field 展示，X-AI-field 不提供对应公开页面。

`/prompts` 提供 Registry 搜索 / 类型筛选、版本历史、Draft 编辑、Publish 及独立 Activate / 回滚；历史 Published 只读。服务复用 `src/lib/prompts/registry.ts`，接口为 `/api/admin/prompts` 与 `/api/admin/prompts/[key]`，沿用 §3 的服务端认证和同源校验，不提供在线模型调用。

Fragment 详情 Introduction Card 的 `Used by Requests` 和列表筛选读取当前 Active Published Request 的结构化引用配置：精确 UUID 解析所属 Fragment Registry，三个动态项按 activeKey 关联；不统计历史 Request 或搜索模板文本。Service 批量读取关系，避免逐 Fragment 查询。左侧默认隐藏无当前引用的 Fragment，`Show unreferenced` 可查看全部（包括尚无 Active 的新 Fragment）；过滤仅改变列表，不改变当前详情或未保存编辑。保存、Activate 和手动刷新同步更新引用展示，点击 Request Key 复用现有详情切换。

Publish 不改变生产 Active；Activate / 回滚确认起止版本，不影响已绑定任务。Registry 行锁内校验 Draft Content Hash / 旧 Active ID；并发冲突返回 409，前端保留未保存内容，不自动刷新覆盖。Fragment 与条件变体的校验见 `../07-prompt-spec/registry.md`。

Dashboard 不是 Production Source of Truth。它读取 Production 数据与 Runtime Artifacts，并调用已有 Application Services，不应在 UI 层复制 Processing、Review 或 Evaluation 的业务逻辑。

### 7.1 最近 7 天 Overview

展示最近 7 天 Daily Processing 状态与关键运行指标。

### 7.2 Daily Job Report

查看指定日期的 Daily Job 运行情况与各 Processing Step 的结果，用于判断该次运行是否正常完成以及定位问题。

Discovery Run Card 按 Dashboard 业务日期匹配 `window_end_date`，不按服务器当天或 Run 启动日期过滤。汇总与 D2–D4 取该日期最新启动的 Regular Run，不筛选状态；D5 独立取最新实际执行阶段，可来自 Regular 或 Open Run，明确显示所属 Run ID / 类型，不混加跨 Run 统计。只有 Open 时 Regular 部分显示 N/A；Regular 和 D5 均不存在时隐藏。

阶段状态和指标取持久化业务数据，历史缺失显示未知，不由 Trace 猜测成功。查询与稳定排序实现见 `src/lib/discovery-dashboard.ts`。Retry Discovery / Retry D2 / Retry Open 均经付费确认后提交并轮询；按钮可用性由持久化状态决定，不能据此跳过服务端检查。提交和恢复边界见 [Discovery §7](discovery.md#7-运行入口人工触发与失败处理)。D2–D5 Usage 来自实际模型响应，缺失缓存统计显示 N/A，不与 Fetch Cache 命中混用；采集和累加见 [Trace 与 Usage](discovery.md#61-trace-与-usage-的失败边界)。

#### Runtime Files

Overview 非 `success` 步骤沿用 Retry 右侧 Info 图标打开 Runtime Drawer（移动端全屏）。目录和文件原位展开，内容按需读取，可复制脱敏后的文本；成功任务交互不变。

`GET /api/admin/dashboard/runtime-files?runId=<pipeline_runs.id>` 列目录；`path` 指定子目录，`file=1&path=...` 单独读取文件内容。沿用 Admin 服务端认证，响应禁止缓存。请求固定到具体 Attempt UUID，不随 Retry 或页面轮询切换。`metrics.runtime_dir` 保存项目内相对目录；Stage3/4 在目录创建后通过辅助观测回调记录。记录使用 JSONB 局部更新，结束日志保留已记录的路径；观测失败仅记录错误，不改变 Pipeline 结果。

历史 Completion、Duplicate Filter、Stage1/2 可使用与 DB `started_at` **完全相同**的目录时间戳，且要求该步骤该时间只有一个 Attempt；旧 Stage3/4 或仅有 Dashboard Runtime fallback 而无可靠 Attempt 的数据不可推测目录。不使用最新目录或时间接近匹配。

读取仅允许对应步骤的 Runtime 根目录及 `.json` / `.jsonl` / `.txt` / `.log` / `.md`，拒绝路径穿越、隐藏路径和符号链接。单文件最多 1 MiB，每层最多 500 个目录项，路径深度有界；JSON 格式化，JSONL/文本保留可读内容，常见凭据字段和连接串脱敏。脱敏不是任意敏感业务信息识别器，仍仅供管理员访问。无可靠映射、文件缺失返回 404，非法路径 400，符号链接或成功 Attempt 403，超大文件或目录 413，其他读取失败 500；UI 显示明确反馈。

### 7.3 Human Review

`/review/ignored` 是独立的 Stage1 筛选质量审查页（含 basePath 时为 `/ai/review/ignored`），位于 REVIEW 分组 In-depth 与 Model Evaluation 之间，复用 Review 日期布局、鉴权和导航 Active 逻辑。按 Daily Scope 的 `published_at` 半开区间读取所有来源；仅接受 `stage1_status='ignored'`、`processing_error IS NULL`、`stage1_processed_at IS NOT NULL`，排除规则去重的 `duplicate`、其他错误标记和无处理时间的历史记录，并排除已进入有效 Digest 的文章。查询由 `src/lib/dashboard-analytics.ts` 的 `loadAiIgnoredArticles()` 提供，不改变 Analytics 原查询口径。使用 Source / Title & Content / 操作三列表格；Title 后以小箭头链接原文，正文显示单行预览并可展开完整 `content_text`。当前 Stage1 未保存 Ignore Reason，因此不展示理由占位、不补调模型，缺失正文明确提示。日期仅允许审查已结束 Scope；Put Back 直接复用下述按钮、API 与幂等 / 恢复能力，成功后移除列表项并提示结果，失败保留文章和错误。列表读取不调用模型，Put Back 仍按既有流程必要时补齐 Digest 字段。

Analytics 的 Ignored Articles 提供 Put Back，调用 `POST /api/admin/dashboard/analytics/ignored-articles/put-back`，复用 Admin Session / 同源保护。列表同时保留尚未被 Stage3 重排的恢复记录，以便刷新后确认结果；统计继续按实际 Raw 状态计数。交互与错误状态在原列表内完成，不另建编辑页面。业务规则见 `../06-workflow-spec/manual-operations.md` 的 Put Back，生成契约见 `../07-prompt-spec/editorial.md`。

提供人工 Review 界面：
- Review Event Ranking；
- Review Long-form Ranking；
- 调整 Display Order；
- 保存 Ranking Feedback。

In-depth Review 区分客观元数据、Agent 诊断与可编辑 Editorial；Discovery Path、处理阶段、Candidate ID 与 Run ID 不混用。Tags / Cover 缺失保持历史兼容，不影响审核。字段见 [Data Model](../05-data-model/discovery.md#discovery_candidates)，Source 规则见 [Discovery §5.1](discovery.md#51-candidate-source-归一化)；具体布局以页面实现为准。

#### In-depth Category

Review 通过现有 `PATCH /api/admin/review/in-depth` 独立提交 `{id, action: "category", category}`；`id` 是 Review Item ID，`category` 为合法枚举或 `null`。沿用 Admin Session、同源与请求校验；仅更新关联 Candidate 的分类、人工标记及更新时间，不修改审核状态、Notes、Tags 或 Editorial。公开 API 返回 `category` / `categoryLabel`，未分类为 null，Xfield 不展示其 Badge，Approved 发布边界不变。

人工修改与标记在同一 SQL 中原子写入；D4 / Manual 的 AI UPDATE 在 SQL 层检查当前行标记，`evaluation` 使用合并 / 局部更新，避免模型调用期间的人工修改被覆盖。D3 / D5 仅插入新候选，不 Upsert 替换已有候选。字段及人工优先级的权威定义见 [discovery_candidates](../05-data-model/discovery.md#discovery_candidates)。

#### Digest Put Back

业务执行与失败恢复见 [Manual Operations §2](../06-workflow-spec/manual-operations.md#2-digest-put-back)。`src/lib/digest-put-back.ts` 与 Stage3 排名写入遵守以下技术约束：

- 对同一 Raw 使用事务级 advisory lock；同一期规范化 URL 使用共享的去重锁，兼容跨 Raw / Feed 的相同作品。处理中请求返回冲突；LLM 调用前独立提交版本及执行标记，调用期间不持有数据库事务。标记恢复与版本复用见 [Operations](../09-operations.md) 和 [Prompt Registry](../07-prompt-spec/registry.md)。
- `raw_articles.metadata.put_back_preparation` 独立提交；后续另一个事务原子写入 Digest、恢复标记和 Raw selected 状态，写入前重查状态、日期归属与重复作品。最终事务失败不回滚已提交的准备结果；准备结果自身保存失败时向调用方返回生成字段。
- Put Back 与 `src/processing/stage3-persistence.ts` 共用短事务排名锁；追加名次取同日期、同分类 Digest 的最大有效名次加一。恢复时 `ai_rank = NULL`，追加位置写入 `display_rank`；后续 Stage3 按既有人工排序保护规则更新排名或清理过期排名，并清空 `put_back_at`，不删除 Raw 中的准备结果。
- 复用既有 `put_back_at` 字段，不增加独立 rerank 字段。字段约束见 [Data Model](../05-data-model/daily.md#processed_contents)，既有 `0020_digest_put_back.sql` 部署前提见 [Operations §2.4](../09-operations.md#24-人工候选与-put-back-部署前提)。

#### In-depth Editorial Introduction

人工 URL 候选使用 `POST /api/admin/review/in-depth/manual` 创建或返回既有候选，`GET` 按 Candidate ID 只读预览正文；产品行为见 `../01-product-spec.md` §4.2，复用与并发边界见 `discovery.md` §6.4。manual 不伪造 Run / D4。

`/review/in-depth` 中 Original Title 完整展示，Title / Author 不提供人工编辑。介绍、Notes、审核状态三个控制相互独立：

- `PATCH /api/admin/review/in-depth` 的严格 action 为 `editorial` / `notes` / `review`，只能修改各自字段。
- 同端点 `POST {id}` 生成并自动保存介绍；manual 使用专用生成任务。普通 LLM 接收实际正文，不因收到 URL 就视为已阅读，不增加搜索或 Discovery Run。
- Introduction 优先用完整 Cache / Candidate 正文，再用 Daily 全文，未命中才固定 URL Fetch 并缓存；Manual Generate 只读已保存正文。正文缺失、不完整或超输入上限时明确失败；Cache 设计见 `discovery.md` §4.3。
- `saveInDepthEditorial()` 对三段 Editorial 使用内容基线 CAS：Generate 开始读取基线，完成后条件 UPDATE；人工 Save 也必须带 `baseline`。null 按空字符串比较，不依赖 `updated_at`，因此 Notes / Review 独立更新不会制造 Editorial 冲突，也不检测内容改后又完全还原的 ABA 历史。
- 基线失配返回 **409** 和 `currentEditorial`；Generate 冲突还保留已生成 `introduction` 且 `saved=false`，不覆盖他人保存。Manual Generate 的候选生成字段与 Editorial 在同一短事务保存，CAS 失败整体回滚。模型调用期间不持有此事务或行锁。
- Regenerate 覆盖未保存修改前确认；迟到响应不得覆盖新输入或其他 Candidate。前端保留冲突 / 保存失败的已生成文本供检查后手动保存，不自动采用新基线强制覆盖；无冲突维持自动保存。一般 Introduction 的生成失败为 502，生成成功但保存失败为 503；具体错误以 `IntroductionError` 与 Route 为准。

持久化与 Editorial 回退规则见 [in_depth_candidates](../05-data-model/discovery.md#in_depth_candidates)，模型输入输出见 `../07-prompt-spec/editorial.md`。

#### In-depth 公开 API

匿名 `GET /api/in-depth` 只返回 Approved Candidate；X-AI-field 不提供公开 `/in-depth` 页面。响应 `{items, nextCursor, hasMore}` 默认每页 10 篇，按 Candidate `created_at DESC, id DESC` 排序；opaque cursor 保留稳定分页精度，非法游标返回 400，末页 nextCursor=null、hasMore=false。实现见 `src/lib/in-depth-reads.ts`。

items 显式列出客观元数据（含 publishedAt、双语 tags、cover）、`agent: {summary, whyWorthReading}` 及 `editorial: {summary, whyWorthReading, extra_info}`。独立 editorial 不用 Agent 补空，原顶层展示字段保持既有覆盖语义；不返回 Review notes、内部 evidence/evaluation 或模型调试数据。已 Approved 内容保存 Editorial 后立即可读，不引入 Draft/Published 双版本。Xfield 按此契约分别展示 Agent 与 Editorial，并按 API 顺序追加分页结果。

`contentEvidence: string[]` 仅从 Candidate evidence 的 `agentEvidence` / `details` 提取非空叙述文本，复用 Review 的 Content evidence 读取器；忽略对象、序列化 JSON 和堆栈，不公开完整 evidence、fetch、limitations 或其他技术诊断。Xfield 将它追加于「讲了什么」现有正文之后；不改写 Agent / Editorial 字段或既有回退。无可展示内容时返回空数组。

### 7.4 Model Evaluation

提供 Model Evaluation 界面，用于比较不同模型在已支持 AI Stage 上的输出结果。

Dashboard 的具体 UI Layout 与交互细节以实现为准，不在 Technical Spec 中维护。

---


### 7.5 Memory 管理

`/memories` 位于共享后台 Layout，Sidebar Administration 中提供入口。数据模型和 Type 含义见 [memories](../05-data-model/memory.md#memories)。本节定义手动存储与管理；D2 的读取规则见 [Memory Runtime](discovery.md#memory-runtime)，不提供自动学习。

`/api/admin/memories` 的 GET / POST / PATCH 均独立校验 Admin Session，写请求校验同源 Origin：

- GET 默认返回全部记录，包含 disabled；可用 `?type=general|topic|source|content` 筛选。排序为 `priority DESC, created_at DESC`，完全相同时间以 `id DESC` 稳定排序，不提供分页或搜索。
- POST 创建记录；PATCH 支持 `{id, content, type, priority, enabled}` 原子保存整行，并保留 `{id, enabled}` 接口兼容。非法参数 400、目标不存在 404、数据库失败 503，创建成功 201，其余成功 200；响应 no-store。
- 新增行默认值由共享 Schema 定义；新增 / 编辑可以取消，失败保留输入。非编辑状态的 Enabled Checkbox 禁用；Edit 后与其他字段一起修改，Submit 一起保存，Cancel 放弃全部修改，提交失败保留全部输入。请求期间禁用重复提交；保存成功重新读取当前筛选列表，以数据库排序为准。保存已成功但列表刷新失败时明确提示刷新，不误报为未保存。

无删除、批量操作或版本管理。实现入口为 `src/lib/memory-contracts.ts`、`src/lib/memories.ts` 与 `src/app/(admin)/memories/`；部署前提见 [Operations](../09-operations.md#25-memory-管理部署)。
