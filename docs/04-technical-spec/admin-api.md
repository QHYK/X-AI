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

后台页面通过 `src/app/(admin)/layout.tsx` 共享布局；Route Group 只改变源码组织，不改变 `/dashboard/*`、`/review/*`、`/prompts` URL。`src/app/admin-navigation.ts` 是 Sidebar 配置唯一来源，不负责认证或注册路由。

浏览器 URL 遵循**相对路径优先**：既有 `./`、`../` 构造保持相对形式，迁移 API 时只改必要路径；复用 URL 时须按每个调用页面核对层级。Next.js `Link`、服务端重定向和 Proxy Matcher 按各自路径规则处理。`basePath=/ai` 由 Next.js 路由配置处理，不在浏览器相对 URL 或 Matcher 中重复加入 `/ai`。

## 3. 鉴权与请求安全

`/dashboard/*`、`/review/*` 与 `/prompts` 是后台页面，保留现有 URL；`/api/admin/*` 是后台 API。二者均要求单管理员 Session。未登录页面跳转 `/login`，未登录 API 返回 JSON 401。`/`、`/api/in-depth`、`/api/brief` 和 `/api/content/read-more` 保持匿名访问。登录与退出端点位于 `/api/auth/*`。

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

Publish 不改变生产 Active；Activate / 回滚确认起止版本，不影响已绑定任务。Registry 行锁内校验 Draft Content Hash / 旧 Active ID；并发冲突返回 409，前端保留未保存内容，不自动刷新覆盖。Fragment 与条件变体的校验见 `../07-prompt-spec/registry.md`。

Dashboard 不是 Production Source of Truth。它读取 Production 数据与 Runtime Artifacts，并调用已有 Application Services，不应在 UI 层复制 Processing、Review 或 Evaluation 的业务逻辑。

### 7.1 最近 7 天 Overview

展示最近 7 天 Daily Processing 状态与关键运行指标。

### 7.2 Daily Job Report

查看指定日期的 Daily Job 运行情况与各 Processing Step 的结果，用于判断该次运行是否正常完成以及定位问题。

Discovery Run Card 按 Dashboard 业务日期匹配 `window_end_date`，不按服务器当天或 Run 启动日期过滤。汇总与 D2–D4 取该日期最新启动的 Regular Run，不筛选状态；D5 独立取最新实际执行阶段，可来自 Regular 或 Open Run，明确显示所属 Run ID / 类型，不混加跨 Run 统计。只有 Open 时 Regular 部分显示 N/A；Regular 和 D5 均不存在时隐藏。

阶段状态和指标取持久化业务数据，历史缺失显示未知，不由 Trace 猜测成功。查询与稳定排序实现见 `src/lib/discovery-dashboard.ts`。Retry Discovery / Retry D2 / Retry Open 均经付费确认后提交并轮询；按钮可用性由持久化状态决定，不能据此跳过服务端检查。提交和恢复边界见 [Discovery §7](discovery.md#7-运行入口人工触发与失败处理)。D2–D5 Usage 来自实际模型响应，缺失缓存统计显示 N/A，不与 Fetch Cache 命中混用；采集和累加见 [Trace 与 Usage](discovery.md#61-trace-与-usage-的失败边界)。

### 7.3 Human Review

Analytics 的 Ignored Articles 提供 Put Back，调用 `POST /api/admin/dashboard/analytics/ignored-articles/put-back`，复用 Admin Session / 同源保护。列表同时保留尚未被 Stage3 重排的恢复记录，以便刷新后确认结果；统计继续按实际 Raw 状态计数。交互与错误状态在原列表内完成，不另建编辑页面。业务规则见 `../06-workflow-spec/manual-operations.md` 的 Put Back，生成契约见 `../07-prompt-spec/editorial.md`。

提供人工 Review 界面：
- Review Event Ranking；
- Review Long-form Ranking；
- 调整 Display Order；
- 保存 Ranking Feedback。

In-depth Review 区分客观元数据、Agent 诊断与可编辑 Editorial；Discovery Path、处理阶段、Candidate ID 与 Run ID 不混用。Tags / Cover 缺失保持历史兼容，不影响审核。字段见 [Data Model](../05-data-model.md) §11.3，Source 规则见 [Discovery §5.1](discovery.md#51-candidate-source-归一化)；具体布局以页面实现为准。

#### Digest Put Back

业务执行与失败恢复见 [Manual Operations §2](../06-workflow-spec/manual-operations.md#2-digest-put-back)。`src/lib/digest-put-back.ts` 与 Stage3 排名写入遵守以下技术约束：

- 对同一 Raw 使用事务级 advisory lock；同一期规范化 URL 使用共享的去重锁，兼容跨 Raw / Feed 的相同作品。处理中请求返回冲突；LLM 调用前独立提交版本及执行标记，调用期间不持有数据库事务。标记恢复与版本复用见 [Operations](../09-operations.md) 和 [Prompt Registry](../07-prompt-spec/registry.md)。
- `raw_articles.metadata.put_back_preparation` 独立提交；后续另一个事务原子写入 Digest、恢复标记和 Raw selected 状态，写入前重查状态、日期归属与重复作品。最终事务失败不回滚已提交的准备结果；准备结果自身保存失败时向调用方返回生成字段。
- Put Back 与 `src/processing/stage3-persistence.ts` 共用短事务排名锁；追加名次取同日期、同分类 Digest 的最大有效名次加一。恢复时 `ai_rank = NULL`，追加位置写入 `display_rank`；后续 Stage3 按既有人工排序保护规则更新排名或清理过期排名，并清空 `put_back_at`，不删除 Raw 中的准备结果。
- 复用既有 `put_back_at` 字段，不增加独立 rerank 字段。字段约束见 [Data Model §3](../05-data-model.md)，既有 `0020_digest_put_back.sql` 部署前提见 [Operations §2.4](../09-operations.md#24-人工候选与-put-back-部署前提)。

#### In-depth Editorial Introduction

人工 URL 候选使用 `POST /api/admin/review/in-depth/manual` 创建或返回既有候选，`GET` 按 Candidate ID 只读预览正文；产品行为见 `../01-product-spec.md` §4.2，复用与并发边界见 `discovery.md` §6.4。manual 不伪造 Run / D4。

`/review/in-depth` 中 Original Title 完整展示，Title / Author 不提供人工编辑。介绍、Notes、审核状态三个控制相互独立：

- `PATCH /api/admin/review/in-depth` 的严格 action 为 `editorial` / `notes` / `review`，只能修改各自字段。
- 同端点 `POST {id}` 生成并自动保存介绍；manual 使用专用生成任务。普通 LLM 接收实际正文，不因收到 URL 就视为已阅读，不增加搜索或 Discovery Run。
- Introduction 优先用完整 Cache / Candidate 正文，再用 Daily 全文，未命中才固定 URL Fetch 并缓存；Manual Generate 只读已保存正文。正文缺失、不完整或超输入上限时明确失败；Cache 设计见 `discovery.md` §4.3。
- `saveInDepthEditorial()` 对三段 Editorial 使用内容基线 CAS：Generate 开始读取基线，完成后条件 UPDATE；人工 Save 也必须带 `baseline`。null 按空字符串比较，不依赖 `updated_at`，因此 Notes / Review 独立更新不会制造 Editorial 冲突，也不检测内容改后又完全还原的 ABA 历史。
- 基线失配返回 **409** 和 `currentEditorial`；Generate 冲突还保留已生成 `introduction` 且 `saved=false`，不覆盖他人保存。Manual Generate 的候选生成字段与 Editorial 在同一短事务保存，CAS 失败整体回滚。模型调用期间不持有此事务或行锁。
- Regenerate 覆盖未保存修改前确认；迟到响应不得覆盖新输入或其他 Candidate。前端保留冲突 / 保存失败的已生成文本供检查后手动保存，不自动采用新基线强制覆盖；无冲突维持自动保存。一般 Introduction 的生成失败为 502，生成成功但保存失败为 503；具体错误以 `IntroductionError` 与 Route 为准。

持久化与 Editorial 回退规则见 `../05-data-model.md` §11.4，模型输入输出见 `../07-prompt-spec/editorial.md`。

#### In-depth 公开 API

匿名 `GET /api/in-depth` 只返回 Approved Candidate；X-AI-field 不提供公开 `/in-depth` 页面。响应 `{items, nextCursor, hasMore}` 默认每页 10 篇，按 Candidate `created_at DESC, id DESC` 排序；opaque cursor 保留稳定分页精度，非法游标返回 400，末页 nextCursor=null、hasMore=false。实现见 `src/lib/in-depth-reads.ts`。

items 显式列出客观元数据（含 publishedAt、双语 tags、cover）、`agent: {summary, whyWorthReading}` 及 `editorial: {summary, whyWorthReading, extra_info}`。独立 editorial 不用 Agent 补空，原顶层展示字段保持既有覆盖语义；不返回 Review notes、内部 evidence/evaluation 或模型调试数据。已 Approved 内容保存 Editorial 后立即可读，不引入 Draft/Published 双版本。Xfield 按此契约分别展示 Agent 与 Editorial，并按 API 顺序追加分页结果。

### 7.4 Model Evaluation

提供 Model Evaluation 界面，用于比较不同模型在已支持 AI Stage 上的输出结果。

Dashboard 的具体 UI Layout 与交互细节以实现为准，不在 Technical Spec 中维护。

---

