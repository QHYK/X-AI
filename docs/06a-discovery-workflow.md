# Discovery Workflow

本文档定义 X-AI-field **In-depth Discovery Workflow 的业务执行逻辑**：何时运行、从哪里读取内容、哪些决策由 LLM / Agent 完成、如何汇总候选、何时触发开放式发现、怎样进入人工审核，以及失败和重跑如何处理。

本文档描述**“系统怎么跑”**，不重复定义具体 Prompt、数据库字段或 SDK 实现。

相关 Source of Truth：

- 系统工作流总览：`02-workflow-overview.md`
- AI 阶段职责与判断语义：`03-ai-workflow-spec.md`
- 共用技术架构：`04-technical-spec.md`（以仓库实际文件名为准）
- Discovery 技术实现：`04a-discovery-technical-spec.md`
- 数据表、字段、约束：`05-data-model.md`
- **现有 Daily Production Workflow（保持独立）**：`06-processing-workflow.md`
- Prompt / Structured Output：`07-prompt-spec.md`
- 命令、部署与排障：`09-operations.md`

`06-processing-workflow.md` 继续定义 Daily Production Pipeline；本文件只定义 Discovery。Discovery 消费 Daily 的已完成结果，不成为 Daily 的新 Stage。

---

## 1. 目标与范围

### 1.1 产品目标

每两天运行一次，**尽可能发现高质量的候选作品**适合 X-field 主动学习者阅读的优秀内容，供人工审核后决定是否上架。

- 重点是**发现值得亲自阅读的作品**，而不是由 Agent 自己回答知识问题。
- 优先利用最近两天 Daily Brief 的新闻线索和已有优秀长文。
- 推荐作品可以早于本次新闻窗口发表；“最近两天”限制的是**线索输入范围**，不是作品发布日期。
- 作品可以是文章、视频或播客；目标阅读 / 观看 / 收听时长原则上不超过 30 分钟。
- 常规路径 **Direct 最多 3 篇、Topic 最多 3 篇（合计最多 6 篇）**；Open Discovery **最多 3 篇**经过验证的候选，优先提供可供人工比较的多个选择，但不强制凑满。
- 机器输出仅是**待人工审核候选**，不是自动上架结果。

### 1.2 非目标（首版）

- 不修改 Daily Brief 的采集、Stage 1–4、排名和发布流程。
- 不构建通用研究 Agent 平台、多 Agent 协作、独立 Planner、Workflow Engine 或消息队列。
- 不自动发布，不自动修改既有 Prompt。
- 不因为普通审核反馈自动生成长期 Memory；Memory 仅在用户明确要求记录时由独立流程写入（写入实现不属于本文件首版范围）。
- 不预先规定每次必须搜索多少次、阅读多少篇或发现固定数量的候选。

---

## 2. 运行范围与输入

### 2.1 触发与依赖

Discovery 每两天 12:00（Asia/Shanghai）由独立入口触发。Code 固定本次依赖的两期 Daily 日期和实际输入内容 ID，不因补跑而滑动窗口。

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

详细判断标准、Structured Output 见 `03-ai-workflow-spec.md`、`07-prompt-spec.md`。

---

## 4. Direct Candidate 验证与 Topic Discovery

### 4.1 并发边界

Selection 完成后，两条路径可以并发：

1. **Direct Candidate Verification（D4）**：优先读取 Daily 已入库的 `raw_articles.full_content_text`，为空时使用 `raw_articles.content_text`，标注 `content_source`；Code 检查 URL、历史重复及可核查的时长信息；普通 LLM 按 D2 优先级逐篇串行评价，每篇独立请求，不负责排名或控制最终提交数量。默认不重新抓取；正文不足返回 `unverifiable` 并说明缺失证据。
2. **Topic Discovery（D3）**：一个 Agent Run 接收全部 Topic Leads，通过 Agents SDK 的 Web Search 和自定义 `fetch_content` 自主搜索、读取 Daily 之外的作品；整个 D3 最多输出 3 篇，不要求覆盖全部 Topic。

并发只是执行组织方式，不意味着必须使用多个 Agent 或复杂协调器。两条路径独立报告成功、空结果或失败；其中一条失败不应自动抹去另一条已经得到的有效候选。

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

提交的每篇作品必须有可追溯的来源、内容证据和入选理由。判断标准与输出格式见 `03`、`07`。

---

## 6. Open Discovery（条件触发）

Open Discovery 复用同一 Discovery Agent 和内容标准，不需要新 Agent 类型。

触发条件：

1. Topic Selection 正常完成但没有任何 Direct / Topic 线索（两条分支无需执行）；或
2. Direct 与 Topic 两条分支**均正常完成**，Code 核查后合计 **0 篇合格候选**。

若任一已启动分支失败或中止，即使当前合格候选为 0，也**不自动触发 Open**；保留另一分支的有效结果及失败记录，交由人工决定后续动作。

与 Topic Discovery 的区别仅在任务输入：**不限定本期新闻的 Knowledge Question**，允许寻找其他符合 X-field 标准的优秀作品。

Agent 可发现多个可比较候选；**Open Discovery 最多提交 3 篇 / 个经过初筛与验证的候选进入 `in_depth_candidates`，由人工决定是否以及上架哪一篇**。不强制凑够三个；不足标准可以提交更少或零篇。Open Discovery 同样经过统一验证与去重，不享有免检通道。

**人工补充执行**：审核页面展示 D2 全部线索（含稳定 `leadId`、优先级、类型、内容/问题、执行状态及结果）。审核者可选择某个 `leadId` 单独执行：Direct 复用 D4，Topic 复用 D3；也可直接触发 Open。每次人工执行创建关联原常规 Run 的独立 Run，保留原结果，不重新运行 D2、不覆盖原有候选；Open 每次最多额外提交 3 篇。

---

## 7. 持久化与人工审核

首版使用三个业务对象及一张 SDK Trace 表；精确字段、关联和写入事务由 `05-data-model.md` 定义。

| 对象 | 业务职责 |
|---|---|
| `discovery_runs` | 记录每次运行、固定两期日期、输入内容 ID、配置与上下文、Topic Selection 结果、状态及结束原因；人工 Open 使用新 Run 和 `parent_run_id` |
| `discovery_candidates` | 记录各路径发现的候选及其来源、验证和筛选信息，包括最终未入选的候选 |
| `in_depth_candidates` | 保存经过机器筛选、正式等待人工审核与上架决定的作品 |
| `discovery_trace_spans` | 保存 Agents SDK Trace / Span，关联运行，用于还原模型与工具执行过程 |

`discovery_candidates` 与 `in_depth_candidates` **不是同一层对象**：只有通过机器初筛并提交人工审核的作品才进入后者；Open Discovery 可一次提交最多 3 个。搜索结果也不必全部转成业务候选；实际持久化粒度与运行 Trace 的边界留给技术 Spec 确定。

人工审核负责接受、拒绝、修改、候选之间的比较及最终上架决策。审核页面还需展示 D2 的全部线索及执行状态，支持按 `leadId` 触发单条 Direct / Topic，或人工 Open；单条执行复用原 D4 / D3 Prompt，不新设独立 Prompt。对 D4 `unverifiable` 候选的**固定 URL 重新获取并单篇重评**可作为后续人工审核功能，**不纳入首版**。**本轮不修改现有 `feedback` 结构**。用户明确要求长期记住的意见，由未来独立 Memory 写入流程处理；普通审核意见不自动写入 Memory。

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

- `discovery_runs.selection_output` 尚未成功持久化时，D2 不视为完成。不得恢复该 Run；应创建新的 Regular Run ID，并从 D2 重新执行。
- `selection_output` 已成功持久化时，D2 即视为完成，不能仅凭整体 Run status 判断。后续 D3 或 D4 失败时，Resume 复用原 Run ID、固定输入成员和 D2 结果，只执行尚未完成的任务。
- Resume 不覆盖或重复执行已经完成并持久化的评价结果；各分支根据已有持久化结果跳过完成项，只继续 missing / failed 项。
- D2 的完成以持久化 `selection_output` 为准；D3 / D4 的完成判断读取 `discovery_runs.execution_state` 中各自阶段状态。已执行阶段还在其中保存实际 Provider、模型、耗时与 Usage 诊断；字段完整性语义由 `05-data-model.md` 定义。D3 正常返回 0 篇仍写入 `completed + no_candidates`；缺失状态或进程异常遗留的 `running` 不视为完成。阶段状态独立更新，任何一条分支失败都不得覆盖另一条分支的完成记录或候选。
- Resume 用于继续未完成的同一次执行。若操作目的为主动重新生成内容，而不是完成失败任务，则创建 New Run，不覆盖原 Run 的 Selection、Candidate、评价或 Trace。

当前 D3 Resume 以完整 Agent Run 为恢复边界：已完成则跳过；未完成、失败或遗留 `running` 时重新执行整个 D3，不实现 Agent 内部 Checkpoint。D4 继续复用 Candidate 级 Resume。

### 8.4 人工补充执行

人工可在审核页面选择原 D2 的 `leadId` 单独执行，或启动 Open；这属于新的人工补充执行，不是原 Run Resume。每次创建新 Run、关联原 Run 与所选 Lead，独立保存执行结果和 Trace。Discovery 不要求相同输入产生相同输出。

---

## 9. 待确认事项

1. **Daily 查询复用**：核实当前 API 的业务日期、Event 全量与 Digest / Long-form 展示选择规则，提取可复用查询函数。
2. **SDK 工具实验**：验证选定 GPT 模型的 `webSearchTool()`、`fetch_content` 配合及真实阅读证据。
3. **Tracing 实验**：验证 SDK TracingProcessor 写入 PostgreSQL、父子 Span 关联、结束时刷新与失败记录。
4. **内容验证**：核实视频 / 播客的字幕、时长获取；无法核查时保留限制，不伪装为已阅读。
5. **运行预算**：通过首轮真实运行确定并发、超时、轮数与 Token 预算。

这些实验的技术细节属于 `04a` 和 `09`，本文件不重复实现设计。
