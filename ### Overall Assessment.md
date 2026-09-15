### Overall Assessment

- Docs ↔ Code Consistency：**Low**
- Spec Coverage：**Medium**
- Internal Docs Consistency：**Medium**
- Coding Agent Readiness：**NOT YET**

核心 Product、Stage 1–3 AI 语义、Evaluation 隔离和多数 Prompt Contract 已有较清楚定义。但当前可达的 Stage 4 实现已切换到 DB snapshot/draft-publish 模式，而 `06-processing-workflow.md`、`07-prompt-spec.md`、README 仍大量描述旧的 runtime-lineage / `event_date` rebuild 模式；这会直接误导后续 Agent 修改 Production 行为。

### 1. Critical Issues

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:534), §7.4, §8.1, §12
- **Code:** [stage3-job.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage3-job.ts:215), `processStage3`; [process-stage2.ts](/Users/sirius/Documents/X-AI-field/scripts/process-stage2.ts:55)
- **Finding:** 文档称 Stage 3 消费明确传入的 Stage 2 runtime，且 Stage 2 仅将 Event Groups 留在 runtime。实际调用链是 Stage 2 成功后把 group replace 写入 `event_groups`，Stage 3 从该 DB snapshot 读取，传入的 Stage 2 runtime 仅被记录，未作为业务输入。
- **Why it matters:** Agent 若依 Spec 修改重跑、lineage 或 Event group 行为，会错误地把 runtime 当作 Production 输入，破坏当前 DB snapshot 语义。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 先决策 DB snapshot 是否为目标架构；随后将 Stage 2→3 输入、重跑和 lineage 统一描述为 DB business input + 可选 runtime observability，或让代码恢复显式 runtime lineage。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:593), §8.2–8.4；[docs/07-prompt-spec.md](/Users/sirius/Documents/X-AI-field/docs/07-prompt-spec.md:114), Stage 3 Execution
- **Code:** [stage3-job.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage3-job.ts:256), `selectTopEvents` call; [stage3-job.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage3-job.ts:897), `selectTopEvents`
- **Finding:** Spec 定义 Event Top 15 是最终 selected events，且 cross-channel dedup 在 selected Events 后发生。代码以 `topN: eventBundle.input.events.length` 调用，因此所有 LLM 返回的 ranked Event（最多 50）都进入 cross-channel exact dedup；真正的 Top 15 只在 Stage 4 从 review snapshot 读取时才截断。
- **Why it matters:** rank 16–50 的 Event article 会错误排除对应 Digest / Long-form 内容，改变 Daily Brief 组成。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 明确产品期望是“Top 15 后再 dedup”还是“Top 50 均抑制其他 channel”；然后调整代码或 Spec，使 cutoff 的唯一责任点一致。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:697), §9.3–9.5；[docs/05-data-model.md](/Users/sirius/Documents/X-AI-field/docs/05-data-model.md:170)
- **Code:** [stage4-event-processing.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-event-processing.ts:123), `prepareStage4Event`; [stage4-persistence.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-persistence.ts:128), `publishStage4Run`
- **Finding:** Spec 规定 `event_date` 由最早有效 `published_at` 推导，重跑仅按涉及的 `event_date` scope cleanup/rebuild。当前可达 Stage 4 调用 `prepareStage4Event(..., dailyDate)`，将每个 Event 的 `event_date` 固定为 workflow `daily_date`；发布时 archive 同一 `stage4_runs.daily_date` 的全部已发布 Event，而非 `event_date` scope。
- **Why it matters:** `event_date` 的业务含义、跨日 late-arrival、重跑范围和历史 Event 保留策略均已变化，且当前 Prompt 仍告诉模型应用层从 source timestamps 推导日期。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 先确认现行“Daily attribution date”是否应取代“事件自身日期”。如果不是，代码偏离 Spec；如果是，更新 Processing/Data/Prompt Spec，并删除或隔离旧的 event-date rebuild path。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:930), Human Review
- **Code:** [ranking-review.ts](/Users/sirius/Documents/X-AI-field/src/lib/ranking-review.ts:204), `saveEventReviewRanking`; [daily-brief.ts](/Users/sirius/Documents/X-AI-field/src/lib/daily-brief.ts:204), `loadEvents`
- **Finding:** Review 将 Event 移入 Top 15 时会调用旧 `persistStage4Events`，新 Event 没有 `stage4_run_id`，但 Daily Brief API 只返回 join 到 `stage4_runs` 的 published Event。因此人工 promotion 生成的 Event 可能不会出现在 Brief。
- **Why it matters:** Human Review 的核心承诺“移入 cutoff 后按需 enrichment 并最终展示”在当前可达查询链路中不成立。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 先决定 Review promotion 应加入当前 Stage 4 run、创建正式独立 run，还是 API 应支持这类明确 review-linked Event；再统一 persistence 与查询语义。

### 2. Important Issues

- **Type:** DOC_STALE
- **Doc:** [README.md](/Users/sirius/Documents/X-AI-field/README.md:50), [README.md](/Users/sirius/Documents/X-AI-field/README.md:114), [README.md](/Users/sirius/Documents/X-AI-field/README.md:193), [README.md](/Users/sirius/Documents/X-AI-field/README.md:230)
- **Code:** [package.json](/Users/sirius/Documents/X-AI-field/package.json:6); [daily-brief.ts](/Users/sirius/Documents/X-AI-field/src/lib/daily-brief.ts:182)
- **Finding:** README 仍引用已删除的文档名（`02-ai-workflow-spec`、`03-prompt-spec`、`05-source-list`、`06-workflow-overview`），列出不存在的 `recover:stage4-events:dry-run` 和 `sql/evaluation/`，并称 Events Top 10；当前 cutoff 是 15。
- **Why it matters:** README 是新 Agent 和操作者的首要入口，当前会把人带向不存在文件、无效命令和错误数量语义。
- **Suggested owner:** README 应只作入口，链接到 `01–09` 的唯一 Source of Truth。
- **Recommendation:** 更新为当前 docs 编号和实际 package scripts；避免重复维护 Workflow 规则与 API membership 细节。

- **Type:** AMBIGUOUS_NEEDS_DECISION
- **Doc:** [docs/09-operations.md](/Users/sirius/Documents/X-AI-field/docs/09-operations.md:37); [docs/08-source-list.md](/Users/sirius/Documents/X-AI-field/docs/08-source-list.md:1)
- **Code:** [import-sources.ts](/Users/sirius/Documents/X-AI-field/scripts/import-sources.ts:49)
- **Finding:** Source Spec 已迁移到 `docs/08-source-list.md`，但 seed script 固定读取不存在的 `docs/05-source-list.md`。Operations 已准确披露“代码试图读取”旧路径，但 `npm run db:seed` 实际不能完成 Source sync。
- **Why it matters:** Source configuration 是 Production collection 的入口；当前无法按正式文档同步数据库。
- **Suggested owner:** `docs/08-source-list.md` 为配置 Source of Truth；`docs/09-operations.md` 记录可执行命令。
- **Recommendation:** 先确认文档迁移是否已经是目标状态；随后修复 script path 或恢复兼容入口，并将 Operations 改为“可执行”的描述。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:664); [docs/09-operations.md](/Users/sirius/Documents/X-AI-field/docs/09-operations.md:160)
- **Code:** [stage4-job.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-job.ts:103), `processStage4`; [stage4-job.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-job.ts:398), `processStage4FromDb`
- **Finding:** `processStage4` 直接 return 到 DB path；该 path 忽略 `stage3RunDir` 和 `concurrency`，逐项串行 enrichment。`STAGE4_CONCURRENCY` 目前不影响可达 Production path。
- **Why it matters:** Operations 所述的性能/执行控制并不存在，且 orchestration 传入的 Stage 3 lineage 失效。
- **Suggested owner:** `docs/06-processing-workflow.md` 负责执行语义，`docs/09-operations.md` 负责实际变量。
- **Recommendation:** 决定恢复并发和显式 lineage，或删除无效 env/参数与旧代码路径，并更新 Operations。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:105), §2.2；[docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:632), §8.6
- **Code:** [review.ts](/Users/sirius/Documents/X-AI-field/src/lib/review.ts:286), `getLongFormReviewData`; [ranking-review.ts](/Users/sirius/Documents/X-AI-field/src/lib/ranking-review.ts:410), `saveLongFormReviewRanking`
- **Finding:** Production 中 Long-form 归属使用 `processed_contents.daily_date`，但 Long-form Review 的读写使用 raw article 的 24-hour `published_at` scope。72-hour catch-up 的 late-arrival Long-form 会出现在 Production Brief，却可能不在同一期 Review 中。
- **Why it matters:** Review 与 Production 的 Daily membership 不一致，人工排序可能无法覆盖实际展示内容。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** Review 改为使用 `processed_contents.daily_date`，或明确改变 Production attribution；两者必须统一。

- **Type:** DOC_STALE
- **Doc:** [docs/05-data-model.md](/Users/sirius/Documents/X-AI-field/docs/05-data-model.md:97), `processed_contents`; [docs/05-data-model.md](/Users/sirius/Documents/X-AI-field/docs/05-data-model.md:293), indexes
- **Code:** [schema.ts](/Users/sirius/Documents/X-AI-field/src/db/schema.ts:176); [schema.ts](/Users/sirius/Documents/X-AI-field/src/db/schema.ts:184)
- **Finding:** Data Model 的字段清单遗漏了已是 Daily 归属核心的 `processed_contents.daily_date`，并称 `events(event_review_item_id)` 单列唯一；实际 schema 是 `(stage4_run_id, event_review_item_id)` 联合唯一。
- **Why it matters:** Agent 无法仅通过 Data Model 理解 Production membership，且会误判同一 Review item 的历史/重跑约束。
- **Suggested owner:** `docs/05-data-model.md`
- **Recommendation:** 补齐真实字段、约束和 daily attribution role；以 migration/schema 为核对基准。

- **Type:** CODE_DEVIATES_FROM_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:219), Pre-Stage1 winner rule
- **Code:** [pre-stage1-exact-duplicates.ts](/Users/sirius/Documents/X-AI-field/src/processing/pre-stage1-exact-duplicates.ts:108), `compareDuplicateWinner`
- **Finding:** Spec 定义 winner tie-break 为正文完整度、source 名称稳定排序、较早创建时间、ID；代码使用正文长度、`sourceName.length`、ID，未查询 `created_at`。
- **Why it matters:** exact dedup 可决定文章是否进入 LLM 与最终 Brief，当前实际选择不满足文档所定义的稳定规则。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 确认 tie-break 设计后，选择修改实现或修订 Spec；不要让文档保留不存在的排序保证。

- **Type:** MISSING_SPEC
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:791), Stage 4 failure handling
- **Code:** [stage4-persistence.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-persistence.ts:106), `persistStage4Draft`; [stage4-persistence.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage4-persistence.ts:128), `publishStage4Run`; [daily-brief.ts](/Users/sirius/Documents/X-AI-field/src/lib/daily-brief.ts:218)
- **Finding:** 当前重要语义是“逐 Event durable draft；仅 draft count 满足 expected count 才 atomic publish；若当前 run partial，API 返回该 run 的 draft-only partial set，绝不混合旧 published 与新 drafts”。Data Model 有片段描述，但 Processing Spec 未清楚定义 API 可见性和 replace/archive 行为。
- **Why it matters:** 这是 Production failure/read behavior contract，错误修改会产生混合版本的 Brief 或丢失已完成 Event。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 以 Stage 4 persistence 与 Daily Brief API 的联合行为补充稳定语义，不需复制 SQL 或 runtime 格式。

### 3. Minor Issues

- **Type:** DOC_CONFLICT
- **Doc:** [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:8)
- **Code:** 实际文件为 [docs/04-technical-spec.md](/Users/sirius/Documents/X-AI-field/docs/04-technical-spec.md:1)
- **Finding:** Processing Spec 链接 `04-technical-architecture.md`，该文件不存在。
- **Why it matters:** 低成本但会阻断按文档导航。
- **Suggested owner:** `docs/06-processing-workflow.md`
- **Recommendation:** 改为当前 Technical Spec 路径。

- **Type:** DOC_CONFLICT
- **Doc:** [docs/07-prompt-spec.md](/Users/sirius/Documents/X-AI-field/docs/07-prompt-spec.md:67), Stage 1 guideline；[docs/07-prompt-spec.md](/Users/sirius/Documents/X-AI-field/docs/07-prompt-spec.md:27), output schema
- **Code:** [stage1-contract.ts](/Users/sirius/Documents/X-AI-field/src/processing/stage1-contract.ts:132)
- **Finding:** Prompt guideline 说仅 `routing != Ignore` 时生成内容；runtime schema 对所有结果均要求 `generated_content.summary/title_zh/summary_zh` 为 string。
- **Why it matters:** Prompt 或 contract 修改者可能把 Ignore 输出字段省略，导致整 batch validation fail。
- **Suggested owner:** `docs/07-prompt-spec.md`
- **Recommendation:** 明确 Ignore 是否必须带空字符串字段，或修改 schema 使其真正可选。

- **Type:** DUPLICATED_SOURCE_OF_TRUTH
- **Doc:** [README.md](/Users/sirius/Documents/X-AI-field/README.md:28), [README.md](/Users/sirius/Documents/X-AI-field/README.md:193), [docs/06-processing-workflow.md](/Users/sirius/Documents/X-AI-field/docs/06-processing-workflow.md:60)
- **Code:** [daily-scope.ts](/Users/sirius/Documents/X-AI-field/src/lib/daily-scope.ts:11)
- **Finding:** README 仍维护具体 Daily membership、event cutoff、recovery 和 command 行为，且已经与正式 Specs 漂移。
- **Why it matters:** README 与 `01–09` 形成第二套可变 Spec。
- **Suggested owner:** README 仅保留简短入口；具体规则留在对应 `01–09`。
- **Recommendation:** README 链接正式 Spec，不重复时间归属、重跑、cutoff 和 persistence 规则。

### 4. Coverage Gaps

真正建议补入现有 Spec 的重要逻辑：

- Stage 4 的 draft → complete-set publish → archive previous published run → API published/partial/empty 可见性规则。应归 `06-processing-workflow.md`。
- Human Review promotion 的最终 Event persistence 和 Daily Brief 可见性 contract。应归 `06-processing-workflow.md`；目前代码路径本身还需要先修正或确认。
- Long-form Review 使用何种 Daily membership（`processed_contents.daily_date` 或 `published_at`）。应归 `06-processing-workflow.md`。
- `processed_contents.daily_date` 的字段与约束角色。应归 `05-data-model.md`。
- Stage 2 DB Event Group snapshot 是否是正式业务中间态、如何替换、Stage 3 如何消费。应归 `06-processing-workflow.md`。
- Pre-Stage1 duplicate filter 跨前 72 小时 reference article 的实际行为。若这是长期业务规则，应归 `06-processing-workflow.md`；否则应从代码移除或标记为 incident-specific behavior。

### 5. Final Verdict

**NOT YET**

达到 **YES** 所需的最小修改集合：

1. 对 Stage 4 架构做一次明确决策，并统一代码与 `06-processing-workflow.md`：输入 lineage、Top 15、draft/publish、archive、`event_date` 与 Daily attribution。
2. 修复或明确 Human Review promotion 进入 Daily Brief 的持久化/query contract。
3. 统一 Stage 3 cross-channel dedup 的实际 cutoff。
4. 修复 Source seed 文件路径，或恢复与 `08-source-list.md` 一致的可执行入口。
5. 补齐 `05-data-model.md` 的 `daily_date`、Event/Review unique constraint。
6. 将 README 降为入口文档，删除旧文件名、无效命令、旧 Top 10 与旧 runtime rebuild 说明。
7. 统一 Long-form Review 与 Production 的 Daily membership。

本次仅做只读审计，未修改、创建或删除任何文件。工作区原本已有未提交的文档迁移、代码和删除记录；我未触碰这些现有变更。