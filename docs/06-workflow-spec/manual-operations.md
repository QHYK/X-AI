# Manual Operations Workflow Spec

## 1. Scope and Boundaries

本文定义 **Digest Put Back**、**Discovery 人工 URL 候选**、**Human Review** 和 **Model Evaluation** 的触发、执行结果及失败恢复；它们由管理员主动发起。

Daily 执行规则见 [Daily Workflow](daily.md)，自动 Discovery 与人工 Open / Resume 见 [Discovery Workflow](discovery.md)。API、事务与并发边界由 [Admin & API Technical Spec](../04-technical-spec/admin-api.md) 定义；字段约束见 [Data Model](../05-data-model/README.md)，命令、部署及故障处理见 [Operations](../09-operations.md)。

## 2. Digest Put Back

### 输入与校验

从 Analytics 的 Ignored Articles 发起，输入 Raw Article ID 和期望 Daily 日期：

- 已有处理记录优先采用其 `daily_date`，否则按原文发布时间推导所属 Daily；不以采集时间替代缺失的发布时间。归属与请求日期不符或期次未结束时拒绝。
- 已有可展示 Digest 原样返回；其余仅允许当前 ignored 且未关联 Event 的记录。
- 同一期按规范化 URL 识别跨 Raw / Feed 的相同作品。已有可展示 Digest 时返回已有条目，不新增记录或重复付费，也不将重复 Raw 标记为已恢复；不同日期不按 URL 合并。

### 执行与结果

1. 优先复用完整处理字段、已保存准备结果以及 Raw / 正文 Cache；不重新抓取、不重跑 Stage1，也不再判断是否保留。必要时仅调用一次 Structured LLM 补齐 Digest 展示字段；已存正文不足则失败，不恢复文章。
2. 先保存准备结果，再写入或恢复现有 `processed_contents`，路由设为 `digest`，同步恢复标记和 Raw selected 状态。写入前重新校验当前状态及归属，不能覆盖并发变更。
3. 恢复时追加到该日期、该分类 Digest 的最大名次之后，不改变其他文章已有的人工排序。

后续 Stage3 重跑时，恢复项与其他 Digest 一起参与排名，不再固定在末尾。首次 AI 排名替换恢复时的追加名次，后续继续遵守既有人工 `display_rank` 保护规则；过期排名清理同样适用。Stage3 排名或过期清理后结束追加标记，原恢复准备记录仍保留。

### 失败与重试

- 处理中重复提交返回冲突，不重复执行正在进行的操作。
- 准备结果已保存但最终写入失败时，重试复用准备结果，不再次调用模型。
- 生成成功但准备结果自身保存失败时，明确报错并返回生成文本；应保留文本，重试仍可能再次调用模型，不能保证免于重复付费。

准备结果、并发互斥及排名写入的技术约束见 [Digest Put Back](../04-technical-spec/admin-api.md#digest-put-back)。

## 3. Discovery Manual URL Submission

这是独立的人工候选创建路径，复用 In-depth 候选审核与介绍生成能力，不执行 D2–D5，不受自动候选数量或 D4 入选结论控制，不创建虚假的 Discovery Run / Lead。

1. 管理员提交原始 URL 和最多三组可选双语 Tags。规范化 URL 后查重；命中已有候选时返回完整记录，不创建重复候选或自动重新生成。
2. 未命中时优先复用已有元数据和完整正文，必要时只抓取提交的 URL；无法获得可用完整正文时明确失败。成功后保存 manual / pending 候选及可复用正文。
3. 管理员另行触发 Generate，读取已保存正文并保存介绍到同一候选，不执行 D4 入选判断。已有完整结果默认复用，Regenerate 需显式请求；失败不创建第二条候选。
4. 继续使用既有 Review / Approve / Reject 流程。Pending 仅表示未审核，不表示介绍是否已生成；Generate、介绍编辑与 Notes 不改变审核状态，仅 Approved 内容公开。

产品行为及人工 Tags 优先级见 [Product Spec §4.2](../01-product-spec.md#42-in-depth-discovery--找到值得投入时间的作品)。正文缓存、创建失败后的复用与 Generate 并发约束已由 [Discovery Technical Spec §6.4](../04-technical-spec/discovery.md#64-人工-url-候选phase-b1) 定义；生成成功但保存失败的文本保留和独立编辑边界见 [In-depth Editorial Introduction](../04-technical-spec/admin-api.md#in-depth-editorial-introduction)。

## 4. Daily Brief Human Review

### 普通排序调整

Human Review 位于 Publish 之后，读取 Production Result，通过 Event / Long-form Ranking Review 保存 `display_rank` 和 Ranking Feedback；不重跑完整 Daily Pipeline。

Long-form Review 与 Production 使用相同 Daily membership，按 `processed_contents.daily_date = target dailyDate` 读取和保存，不重新按 `raw_articles.published_at` 计算 24 小时范围。因此，72 小时 catch-up 后归入当前 Daily 的 Long-form 仍属于同一期 Review。

### 按需补全 Event

Event 被人工移入 Top cutoff 且尚无最终 Event 时，才按需执行对应单 Event Stage4 enrichment；普通排序调整不意味着重跑 Stage4 全阶段。补全失败时不保存本次 Review 排名；成功后再保存排名及必要的最终 Event。

接口与展示边界见 [Human Review](../04-technical-spec/admin-api.md#73-human-review)，Stage4 执行与恢复仍遵循 [Daily Workflow](daily.md)。

## 5. Model Evaluation

Model Evaluation 是人工实验路径：冻结输入 → 独立模型运行 → 校验输出 → Dashboard 比较。实验结果保留在 Evaluation 数据中，与 Production 隔离：

- 不进入 Cron / Daily Orchestrator。
- 不修改正式排名或业务结果，不写 `processed_contents` / `events` / `event_review_items` / `feedback`。
- Stage4 当前不参加多模型 Evaluation。

管理界面见 [Model Evaluation](../04-technical-spec/admin-api.md#74-model-evaluation)；CLI、参数和运行操作见 [Operations §4](../09-operations.md#4-model-evaluation)。
