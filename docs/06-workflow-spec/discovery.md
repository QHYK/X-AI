# Discovery Workflow

本文档定义 X-AI-field **In-depth Discovery Workflow 的业务执行逻辑**：何时运行、从哪里读取内容、哪些决策由 LLM / Agent 完成、如何汇总候选、何时触发开放式发现、怎样进入人工审核，以及失败和重跑如何处理。

本文档描述**“系统怎么跑”**，不重复定义具体 Prompt、数据库字段或 SDK 实现。

相关 Source of Truth：

- 系统工作流总览：`../02-workflow-overview.md`
- AI 阶段职责与判断语义：`../03-ai-workflow-spec.md`
- 共用技术架构：`../04-technical-spec/architecture.md`（以仓库实际文件名为准）
- Discovery 技术实现：`../04-technical-spec/discovery.md`
- 数据表、字段、约束：[Data Model](../05-data-model/discovery.md)
- **现有 Daily Production Workflow（保持独立）**：`daily.md`
- Prompt / Structured Output：`../07-prompt-spec/discovery.md`
- 命令、部署与排障：`../09-operations.md`

`daily.md` 继续定义 Daily Production Pipeline；本文件只定义 Discovery。Discovery 消费 Daily 的已完成结果，不成为 Daily 的新 Stage。

---

## 1. Goal

### 1.1 目标

每两天运行一次，**尽可能发现高质量的候选作品**适合 X-field 主动学习者阅读的优秀内容，供人工审核后决定是否上架。

- 重点是**发现值得亲自阅读的作品**，而不是由 Agent 自己回答知识问题。
- 优先利用最近两天 Daily Brief 的新闻线索和已有优秀长文。
- 推荐作品可以早于本次新闻窗口发表；“最近两天”限制的是**线索输入范围**，不是作品发布日期。
- 作品可以是文章、视频或播客；目标阅读 / 观看 / 收听时长原则上不超过 30 分钟。
- 常规路径 **Direct 最多 3 篇、Topic 最多 3 篇（合计最多 6 篇）**；Open Discovery **最多 3 篇**经过验证的候选，优先提供可供人工比较的多个选择，但不强制凑满。
- 机器输出仅是**待人工审核候选**，不是自动上架结果。

### 1.2 非目标

- 不修改 Daily Brief 的采集、Stage 1–4、排名和发布流程。
- 不构建通用研究 Agent 平台、多 Agent 协作、独立 Planner、Workflow Engine 或消息队列。
- 不自动发布，不自动修改既有 Prompt。
- 不因为普通审核反馈自动生成长期 Memory；Memory 仅在用户明确要求记录时由独立流程写入（写入实现不属于本文件首版范围）。
- 不预先规定每次必须搜索多少次、阅读多少篇或发现固定数量的候选。

---

## 2. Input & Scope

### 2.1 触发与依赖

Discovery 以 2026-10-20 为起始日，按 Asia/Shanghai 自然日期计算与起始日的日差：起始日前跳过，非负偶数日差执行。Cron 每天上海时间 12:00 调用独立 Scheduled CLI。Code 固定本次依赖的两期 Daily 日期和实际输入内容 ID，不因补跑而滑动窗口。

- 两期 Daily 均成功完成后，才启动 Discovery。每一期的就绪判断为：该 `daily_date` 至少存在一条 `pipeline_runs.step IN ('daily', 'stage4') AND status = 'success'` 的记录。
- `stage4/success` 可独立证明该期 Daily 已完成；手动重跑 Stage4 成功后，不要求原 Daily Run 的状态同步更新，也不增加额外发布状态校验。
- 任一期未完成，则阻塞；人工修复 Daily 后，按原定两期日期补跑 Discovery。上游失败不等于正常空结果。

### 2.2 Daily 输入

复用 Daily Brief API 的内容选择语义，但 Event 覆盖两期内全部 Event，不限于页面展示 Top N；Digest 和 Long-form 沿用 API 选择规则。

Topic Selection 只接收 ID、标题、摘要、分类、标签、来源等精简信息，不传全文或原始 URL。Direct Verification 再按 ID 读取已入库正文及 URL。

---

## 3. Topic Selection

### 3.1 输入与职责

Code 将本次 Daily Brief 的有效内容及必要上下文交给一次普通 LLM 调用。

LLM **综合阅读并比较整批输入**，无需逐条输出学习机会分析，只返回值得后续处理的结果。新闻的重要性不等于学习价值；应优先发现能够引出具体机制、历史、科学、技术或经济背景的问题。

### 3.2 两类输出

**Direct Candidate**：已有 Daily 内容本身可能是优秀作品，适合直接进入全文验证。

最少应携带：源内容标识、入选理由，以及能够定位原作品的信息。

**Discovery Topic**：Daily 内容触发了一个值得探索的知识问题，但需要另外寻找更好的解释性作品。

最少应携带：

- `question`：**Knowledge Question（知识探索问题）**，即新闻背后值得理解的机制、原理或背景问题；例如，新闻事件：某种关于新型胰腺癌药物获得 FDA 批准。question：这种药物针对什么生物学机制？为什么过去的治疗方法难以奏效？
- `rationale`：为什么值得学习；
- `newsContext`：本期新闻与问题的关系；
- `sourceContentIds`：可追溯的 Daily 内容标识。

两类线索合计**最多 8 条**；可以为空。首版不要求每条 Daily 内容都产生判断记录，不要求固定 Topic 数量，也不做复杂的 Topic 分数体系。

### 3.3 Selection 的边界

Topic Selection 是**潜力筛选**，不是最终质量验证：

- Direct Candidate 仍需阅读足够正文，不能因为 Daily Long-form 排名高就直接推荐。
- Discovery Topic 不要求提前证明网上一定存在优秀作品；是否找到作品由 Discovery Agent 决定。
- 当两类输出都为空时，跳过空分支，直接进入 Open Discovery。

详细判断标准、Structured Output 见 `../03-ai-workflow-spec.md`、`../07-prompt-spec/discovery.md`。

---

## 4. Direct Candidate 验证与 Topic Discovery

### 4.1 分支职责

Selection 完成后，编排顺序执行 D3、D4，分支结果和失败独立保存：

1. **Direct Candidate Verification（D4）**：优先读取 Daily 已入库的 `raw_articles.full_content_text`，为空时使用 `raw_articles.content_text`，标注 `content_source`；Code 检查 URL、历史重复及可核查的时长信息；普通 LLM 按 D2 优先级逐篇串行评价，每篇独立请求，不负责排名或控制最终提交数量。默认不重新抓取；正文不足返回 `unverifiable` 并说明缺失证据。
2. **Topic Discovery（D3）**：一个 Agent Run 接收全部 Topic Leads，通过 Agents SDK 的 Web Search 和自定义 `fetch_content` 自主搜索、读取 Daily 之外的作品；整个 D3 最多输出 3 篇，不要求覆盖全部 Topic。

D4 在原有逐篇评价调用中同步生成合格作品的读者介绍，校验成功后与评价一并持久化；字段缺失走现有 Candidate 失败诊断与 Resume，不增加补全调用。具体输出契约见 `../07-prompt-spec/discovery.md` 的 D4 章节。

候选 Tags 由各路径最终阅读评价阶段一次生成：Direct 使用 D4，Topic 使用 D3，Open 使用 D5；不在 D2 从新闻线索推断最终作品 Tags，也不增加补标签调用。输出契约见 `../07-prompt-spec/discovery.md`。

两条路径分别报告成功、空结果或失败；其中一条失败不抹去另一条的有效候选，不建立额外 Agent 或协调器。

### 4.2 Discovery Agent Loop

```text
Input: All Topic Leads + Content Criteria + Memory
                         │
                         ▼
                   LLM Decision
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
        Tool Call(s)            Final Output
             │                       │
             ▼                       ▼
     Search / Fetch / Read       Candidates / None
             │
             ▼
        Observe Results
             │
             └──────→ LLM Decision（继续 / 调整 / 结束）
```

Agent 可按观察结果自主决定：

- 搜索哪些关键词、来源、作者或背景问题；
- 哪些候选值得阅读全文；
- 是否追踪原始研究、参考文献、作者或更好的解释作品；
- 是否改变搜索方向；
- 是否已找到最多 3 篇达到编辑标准且有实际阅读证据的作品，如果是应提前结束探索。

**不强制生成或维护完整多步 Plan**，也不固定搜索与阅读顺序。Agent 的 Tool Call 必须通过真实工具执行；不能把自己描述的“已阅读 / 已核实”当作事实。

Fetch 的完整原文、工具可见片段与可选 Cover 是不同输出，复用及独立持久化边界见 `../04-technical-spec/discovery.md` §4.3。

Topic Agent 自行完成编辑评价，找到最多 3 篇值得推荐且有实际阅读证据的作品即可停止；不要求排序或凑满。Code 随后核查，淘汰不合格作品后无需为补足数量重新启动 Agent。

### 4.3 资源与停止边界

- Agent 可主动结束，返回已验证的候选或空结果。
- 运行时设置简单的最大轮数和整体超时，防止无限循环；具体初始数值在开发实验中确定，记录到运行配置。
- 超过限制、工具失败或模型异常时，明确记录结束原因；不得把预算耗尽伪装为“已完成充分研究”。
- 外部网页内容视为不可信输入，不得把网页中的指令当成系统或用户指令。

---

## 5. Candidate Pool 与最终验证

### 5.1 统一候选

Direct、Topic、Open 三条路径产生的作品进入同一 **Candidate Pool**，保留发现路径、原始 URL、对应 Topic / 新闻上下文、来源标识及可核查的阅读与验证信息。

**历史去重时机**：Topic Selection 结束后，Direct 根据 `sourceContentId` 解析 URL，先查历史重复，未重复者进入 D4；Topic 与 Open 在 Agent 发现具体作品 URL 后再查历史重复。Candidate Pool 汇总时再对当次运行的作品按规范化 URL 去重。历史记录不作为 Topic Selection 的输入，知识问题本身不按 URL 去重。

Code 负责 URL 规范化、跨路径去重和确定性检查。不要仅凭模型生成的标题或说明判定作品真实存在。

### 5.2 两层质量判断

**硬性筛选（Code 优先）**：作品 URL 与可访问性、重复推荐、正文可获取程度（只考虑可实际读取的内容，不做付费墙专项处理）、内容类型、阅读 / 观看 / 收听时长等可确定或可核查条件。

**编辑价值评价（LLM）**：解释深度、结构清晰度、作者及证据可信度、长期学习价值。评价应基于实际阅读证据，不只依赖标题、搜索摘要或来源声誉。

不要求首版把所有编辑维度拆成独立数值评分；优先输出明确的编辑结论、关键证据和局限。

### 5.3 最终选择

Code 汇总 Direct 与 Topic 已完成编辑评价的候选，核查证据、去重并控制各路径提交数量。

- 有：Direct 按 D2 的线索优先级，从 D4 `qualified` 且通过 Code 检查的作品中取前 3 篇；Topic 采用 Agent 自行筛选并通过 Code 检查的最多 3 篇。常规路径合计最多 6 篇进入 `in_depth_candidates`，供人工审核。
- 无：**仅在 Direct 和 Topic 均正常完成**、且合计 0 篇合格作品时，自动进入 Open Discovery；仍无合格作品则返回空结果。
- 只有达到编辑标准并通过 Code 核查的作品才计入合格候选；只要常规路径有至少一篇合格作品，就不自动触发 Open。

提交的每篇作品必须有可追溯的来源、内容证据和入选理由。判断标准与输出格式见 `../03-ai-workflow-spec.md`、`../07-prompt-spec/discovery.md`。

---

## 6. Open Discovery

Open Discovery 复用同一 Discovery Agent 和内容标准，不需要新 Agent 类型。

触发条件：

1. Topic Selection 正常完成但没有任何 Direct / Topic 线索（两条分支无需执行）；或
2. Direct 与 Topic 两条分支**均正常完成**，Code 核查后合计 **0 篇合格候选**。

若任一已启动分支失败或中止，即使当前合格候选为 0，也**不自动触发 Open**；保留另一分支的有效结果及失败记录，交由人工决定后续动作。

与 Topic Discovery 的区别仅在任务输入：**不限定本期新闻的 Knowledge Question**，允许寻找其他符合 X-field 标准的优秀作品。

Agent 可发现多个可比较候选；**Open Discovery 最多提交 3 篇 / 个经过初筛与验证的候选进入 `in_depth_candidates`，由人工决定是否以及上架哪一篇**。不强制凑够三个；不足标准可以提交更少或零篇。Open Discovery 同样经过统一验证与去重，不享有免检通道。

**Implemented：人工 Open** 可通过 Dashboard Retry Open 或 CLI 主动创建关联原 Regular Run 的独立 Open Run，不要求满足自动 Fallback 条件，不重跑 D2–D4、不覆盖原候选。入口与恢复边界见 §8.3–§8.4。

**Planned：Single Lead** 按 `leadId` 单独执行 Direct / Topic，当前没有 CLI / API / UI 入口；设计边界见 `../04-technical-spec/discovery.md` §6.3。

---

## 7. 持久化与人工审核

首版使用三个业务对象及一张 SDK Trace 表；精确字段、关联和写入事务由 [Data Model](../05-data-model/discovery.md) 定义。

| 对象 | 业务职责 |
|---|---|
| `discovery_runs` | 记录每次运行、固定两期日期、输入内容 ID、配置与上下文、Topic Selection 结果、状态及结束原因；人工 Open 使用新 Run 和 `parent_run_id` |
| `discovery_candidates` | 记录各路径发现的候选及其来源、验证和筛选信息，包括最终未入选的候选 |
| `in_depth_candidates` | 保存经过机器筛选、正式等待人工审核与上架决定的作品 |
| `discovery_trace_spans` | 保存 Agents SDK Trace / Span，关联运行，用于还原模型与工具执行过程 |

`discovery_candidates` 与 `in_depth_candidates` **不是同一层对象**：只有通过机器初筛并提交人工审核的作品才进入后者；Open Discovery 可一次提交最多 3 个。搜索结果也不必全部转成业务候选；实际持久化粒度与运行 Trace 的边界留给技术 Spec 确定。

人工审核负责接受、拒绝、比较候选及上架决定。人工 Open 已实现；D2 线索级操作面板与 Single Lead 执行仍为 Planned（§8.4）。D4 `unverifiable` 候选的固定 URL 重抓并单篇重评也是后续能力，当前不提供此入口。普通审核意见不自动写入长期 Memory；显式 Memory 写入属于独立后续能力。

---

## 8. 失败、重跑与可观测性

### 8.1 运行结果

至少区分：

- **有候选**：机器验证通过，已生成待人工审核候选；
- **正常空结果**：已完成合理探索，但没有值得推荐的作品；
- **部分失败**：某一分支失败，其他分支仍可产生有效结果；
- **执行失败 / 中止**：关键依赖不可用、运行超时或达到限制，无法认定完成。

不将工具失败、正文不可访问或执行超时默认为“内容质量不合格”。

### 8.2 真实执行证据

至少应能追溯：

- 本次输入窗口、内容标识和 Selection 输出；
- 实际搜索词、工具调用、返回 URL 与阅读记录；
- 候选来源路径、去重与验证结论；
- 最终推荐或空结果的原因；
- 错误、耗时及基本资源使用信息。

运行 Trace 与正式业务数据应区分。Agents SDK 的 Trace / Span 通过自定义 TracingProcessor 持久化到 PostgreSQL；普通 LLM Client 和 Code 检查首版保留必要业务记录，不强制包装为 SDK Span。Agent 自述的搜索 / 阅读过程不能代替真实工具调用记录。

### 8.3 Run 恢复与重新生成

Discovery 分支失败后不自动重跑。是否复用原 Run，以 D2 的持久化结果为边界：

- `discovery_runs.selection_output` 尚未成功持久化时，D2 不视为完成，普通 Resume 不接受该 Run。满足现有提交条件的失败 Regular Run 可使用同 Run 的 Retry D2，由 Worker 重新处理；保留窗口、输入成员及已绑定 Prompt / Fragment。历史记录不满足 Retry 条件时创建新的 Regular Run。
- `selection_output` 已成功持久化时，D2 即视为完成，不能仅凭整体 Run status 判断。后续 D3 或 D4 失败时，Resume 复用原 Run ID、固定输入成员和 D2 结果，只执行尚未完成的任务。
- Resume 不覆盖或重复执行已经完成并持久化的评价结果；各分支根据已有持久化结果跳过完成项，只继续 missing / failed 项。
- D2 的完成以持久化 `selection_output` 为准；D3 / D4 的完成判断读取 `discovery_runs.execution_state` 中各自阶段状态。已执行阶段还在其中保存实际 Provider、模型、耗时与 Usage 诊断；字段完整性语义由 [Data Model](../05-data-model/discovery.md) 定义。D3 正常返回 0 篇仍写入 `completed + no_candidates`；缺失状态或进程异常遗留的 `running` 不视为完成。阶段状态独立更新，任何一条分支失败都不得覆盖另一条分支的完成记录或候选。
- Resume 用于继续未完成的同一次执行。若操作目的为主动重新生成内容，而不是完成失败任务，则创建 New Run，不覆盖原 Run 的 Selection、Candidate、评价或 Trace。

D2 Retry 优先重新校验已保存且匹配的模型响应，不重复调用模型；匹配条件及 Usage 原子记账见 [Technical Spec](../04-technical-spec/discovery.md#d2-响应恢复)。没有响应或输入 / 版本不匹配时才发出新请求。损坏的恢复记录明确失败，不静默付费重生成；匹配响应仍有结构 / 业务错误时保持失败，主动重新生成需新建 Run。

D2 只过滤已知非 Event 输入中 `directEligible=false` 的 Direct Lead，并记录原 Lead ID、内容 ID 及原因；保留其他有效 Lead 的顺序和 ID。未知 ID、Event Direct、重复引用、非法字段或 JSON 仍导致整批失败。过滤后无有效 Lead（包括模型返回空数组）时不标记 D2 成功，不继续下游分支；不为补足数量放宽资格或将 Direct 自动改为 Topic。

**Prompt 绑定**：通用规则见 `../07-prompt-spec/registry.md` 的执行版本边界，载体见 [版本绑定载体](../05-data-model/prompt-registry.md#版本绑定载体)。D2–D5 在同一 Run 按步骤首次绑定；D4 多篇、D3/D5 Agent Loop 固定该步骤版本。Resume 复用旧绑定，已完成步骤不补写或重跑；新 Regular / Open Run 不继承父 Run 的绑定。

当前 D3 Resume 以完整 Agent Run 为恢复边界：已完成则跳过；未完成、失败或遗留 `running` 时重新执行整个 D3，不实现 Agent 内部 Checkpoint。D4 继续复用 Candidate 级 Resume。

### 8.3.1 D2–D5 编排入口

常规 Discovery 通过统一编排入口按 D2、D3、D4 顺序运行。D2 成功持久化 `selection_output` 后，D3 与 D4 的完成状态仍独立保存；D3 失败不阻断 D4。两个分支均正常完成时，才检查 Open 条件；任一分支失败时按实际完成情况标记 `partial` 或 `failed`。没有对应 Lead 的分支以正常空结果完成，不作为失败。

自动 Open 的资格是读取端派生结论：仅当 D3、D4 都为 `completed` 且整个 Run 没有 `qualified` Candidate 时为真。满足后 D5 作为同一 Regular Run 的内部阶段运行并写入 `execution_state.d5`；D5 正常空结果是有效完成，失败则保留该 Run 供 Resume。人工 Open 则创建关联原 Regular Run 的独立 `open` 子 Run，不重跑 D2–D4，也不覆盖 Parent Run。Dashboard 的 Retry Discovery 以所选业务日期为窗口终点、前一日为起点创建全新 Regular Run；Retry Open 关联该日期最新启动的 Regular Run，并继承其业务窗口，只执行 D5。人工 Open 不受自动 Fallback 条件限制，父 Run 已有候选也可补充执行；D5 实际输入仍为既有 Memory / 可选人工方向，不复制或伪造 D2–D4 状态。两种 Retry 都保留历史数据与既有跨 Run URL 去重规则，均须确认付费；它们与原 Run Resume 独立。

### 8.4 人工补充执行

- **Implemented**：通过 Dashboard Retry Open 或 CLI 人工 Open 创建关联原 Regular Run 的新 Open Run；这不是原 Run Resume，独立保存结果和 Trace，不覆盖原候选。操作入口见 `../09-operations.md`。
- **Planned**：从原 D2 中选择一个 `leadId` 单独执行，创建关联原 Run 与所选 Lead 的新 Run。当前 CLI、Admin API 和审核页面尚未提供此入口；保留的技术约定见 `../04-technical-spec/discovery.md` §6.3。

Discovery 不要求相同输入产生相同输出。

---


## 9. 后续验证边界

Daily 查询复用、SDK 工具与数据库 Trace 已实现，状态及部署核验见 `../04-technical-spec/discovery.md` §9；不再将其列为首次实现前的实验。

- 视频 / 播客的字幕、时长仍需按实际取得的证据核查；无法核查时保留限制，不伪装为已阅读。
- 已有运行预算不代表质量与成本验证已结束；实际配置见 `../09-operations.md`，后续根据真实运行评估，不在本文件重复定义数值。
