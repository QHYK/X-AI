# Daily Pipeline 技术边界

本文件维护 Daily 的模块关系、持久化和发布一致性。AI 判断职责见 [AI Workflow](../03-ai-workflow-spec.md)，业务执行顺序、scope、eligibility 与 Retry 见 [Daily Workflow](../06-workflow-spec/daily.md)，字段与约束见 [Data Model](../05-data-model/daily.md)。

## 1. 模块与持久化边界

| 模块 | 技术职责 | 持久化边界 |
|---|---|---|
| Collection | 来源采集、标准化、原始身份去重和 Raw 持久化。 | `raw_articles` 与来源元数据 |
| Content Completion | 正文补全，不进行内容价值判断，不调用 LLM | `raw_articles` 与来源元数据  |
| Stage1 | 共享 LLM Client 完成内容理解，验证输出后映射 Routing | 保留内容写入 `processed_contents`；Ignored 状态留在 Raw，不创建对应处理结果 |
| Stage2 | 将 Event Candidates 合并为中间分组，不生成最终 Event | `event_groups` / `event_group_items`，由 `src/processing/event-group-persistence.ts` 写入 |
| Stage3 | Event / Digest Category / Long-form 独立排名 | Event 写 Review Snapshot；每个 Digest Category 和 Long-form 独立事务写排名 |
| Stage4 | 对选中 Review Items 独立 enrichment；按需使用外部上下文 | `stage4_runs`、Event drafts，完整后事务发布 |

业务编排在 `src/processing/*-job.ts` 与 Daily CLI，HTTP / Review 复用业务服务；不在 UI 维护第二套 Pipeline。Prompt 通过数据库 Published Version 加载，Schema、模型参数与工具由代码管理，通用边界见 [Architecture §5](architecture.md#5-llm-integration)。

## 2. Event Group、Review 与最终 Event

```text
processed_contents (event)
    ↕ event_group_items
 event_groups
    ↓ Stage3 Review Snapshot
 event_review_items (review_run_id)
    ↓ Stage4 Run (review_run_id / daily_date)
 events (stage4_run_id / event_review_item_id)
```

- `event_group_items` 是正式来源 membership，允许同一 Candidate 属于不同 Groups；唯一约束仅防止同一 Group 内重复成员。
- Review Snapshot 固定该次 Event 排名及关联 Group，`ai_rank` 与人工 `display_rank` 分开保存。
- 同一内容可能是多个 Event 的来源。公开来源查询通过 Group membership 读取，不能要求单值 `processed_contents.event_id` 覆盖多对多关系。
- `event_id` 只是兼容 backlink：`syncPublishedProcessedContentBacklinks()` 仅在当前发布 Run 内唯一归属时回填，多重归属保持空值。

关联实现见 `src/processing/stage4-persistence.ts`、`src/lib/ranking-review.ts` 与 `src/lib/daily-brief.ts`。不要将允许共享来源解释为 Event 已在业务语义上去重。

## 3. Stage4 Run 与 Event 复用

### 3.1 精确执行上下文

数据库主路径由 `src/processing/stage4-job.ts` 读取最新 Review Selection，`loadOrCreateStage4Run()` 按 `review_run_id` 复用 Run。Event 的 `(stage4_run_id, event_review_item_id)` 唯一关系防止同 Run 重复记录，不是跨 Run 的业务去重约束。

`loadGeneratedReviewItemIds()` 同时核对 Run、Review Snapshot、Daily 日期与 Event 日期，仅将匹配的 `draft` / `published` / `archived` Event 视为已有成功 enrichment。不能只凭 `publication_status` 复用其他 Snapshot 的内容。

已有成功 Event 跳过模型调用；Partial Run 只补缺失项。同一成功 Run 再执行仍走完整性校验和发布同步，但不为已生成项重复调用 LLM。该复用不等于并发执行时 LLM 的严格 exactly-once 保证。

### 3.2 Draft 与原子发布

每项成功 enrichment 立即写 `draft`，未发布前不切换正式来源关联。`persistStage4Draft()` 遇到同 Run / Review Item 冲突不覆盖旧内容。

`publishStage4Run()` 在短事务内：

1. 重读并锁住当前人工排序对应的入选集合，再锁 Stage4 Run，避免使用 LLM 前捕获的旧排名。
2. 确认当前入选项全部已有匹配的成功 Event；不完整则回滚，不发布部分新结果。
3. 归档同日期旧 Published Events，发布本 Run 的当前入选项，从 Review Items 同步 `display_rank`，刷新兼容 backlink。
4. 将 Run 标记为 `success` 后提交；失败整体回滚。

生成阶段失败可留下可复用 Draft，并将 Run 更新为 `partial` / `failed`；Draft 不自动成为公开结果。此发布事务不跨 LLM 请求。

### 3.3 归档与 Human Review 恢复

`src/lib/ranking-review.ts` 复用 Stage4 的 draft / 发布服务。移出 Top10 的 Event 归档，重新移入时匹配同一 Review Snapshot 的已有 Event（包括 archived），无需重新 enrichment；确实缺失才生成。

Review 保存事务校验 enrichment 对应集合仍与当前排序一致，随后更新入选状态、排名和 Feedback。失配明确失败，不能把另一个 Snapshot 的 Event 当作缺失项的替代品。状态转换为：

```text
新生成 → draft → published → archived → published
```

## 4. 排名与人工操作一致性

- Stage3 的 `ai_rank` 可更新；`src/processing/stage3-persistence.ts` 仅在 `display_rank` 未人工偏离旧 AI 排名时跟随更新，否则保留人工顺序。
- Event Review 在事务内锁排名行，并先用负数临时排名再写连续正排名，避免交换过程中的唯一键冲突；只为实际触碰且顺序改变的项目记录 Feedback。
- Digest Put Back 与 Stage3 共用短事务排名锁。Put Back 初次追加末尾，后续 Stage3 可将其纳入重新排名并清除 `put_back_at`；不承诺永久置底。完整操作与技术约束见 [Manual Operations](../06-workflow-spec/manual-operations.md#2-digest-put-back) 和 [Digest Put Back](admin-api.md#digest-put-back)。
- Human Review 调用生产 enrichment 与持久化能力；Model Evaluation 仅保存隔离输入和输出，不回写正式排名或 Event。接口边界见 [Admin & API](admin-api.md#73-human-review)。

## 5. 当前一致性边界

以下为已接受、暂未修复的限制，不应将事务内校验描述为全局幂等保证：

- **Stage2 重跑**：`event-group-persistence.ts` 按日期删除并重建 Groups；已发布 Event 的历史来源关联可能受影响。
- **跨 Stage4 Run 发布**：单 Run 发布具有事务原子性，但同日期不同 Run 的并发发布尚无日期级全局串行保证，仍可能留下重复 Published 结果。

本文件只说明上述限制对技术行为的影响，不定义新的修复方案或操作入口。运行与恢复仍以 [Daily Workflow](../06-workflow-spec/daily.md) 为准。

### Stage3 Digest 恢复一致性

`src/processing/stage3-digest-recovery.ts` 使用已有 `pipeline_runs.metrics` 保存 Category 成功标记，和该分类的 `processed_contents` 排名在同一短事务提交；CLI 完成日志以 merge 保留标记。Stage3 开始前必须创建 durable Run，不能在日志创建失败时继续付费生成。

分类提交在共享排名锁内重新校验日期 / routing / category 成员，只更新该分类的排名并清除其去重后过期项；不清理其他 Category。复用时同时核对标记、精确 Prompt/Fragment 版本、输入 Hash、完整 ID 集合以及当前 ai_rank 的唯一连续性。状态文件丢失不改变已经提交的数据库成功标记；旧文件只能作为经严格校验的付费输出缓存，不能替代当前数据库业务输入；Run ID 必须与目录身份一致，恢复诊断以 `source_run_id` 记录来源。同一分类整份恢复，不拼接不同 Run 的 ID；按最新完整有效产物优先，旧产物回退也须通过相同校验。恢复分类本次 LLM calls 和 input/output tokens 均为 0。Runtime 记录 Category 的状态、复用来源、调用数、usage、Warning 和错误。
