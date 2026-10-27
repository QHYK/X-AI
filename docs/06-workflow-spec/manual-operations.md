# 人工操作 Workflow

## 6.4.1 人工 Put Back

Admin API 仅接受 Raw Article ID 和期望 Daily 日期。已有处理记录优先采用其 `daily_date`，否则复用 `deriveDailyDateFromPublishedAt()`；与请求日期不符或期次未结束时拒绝。没有可用发布时间时不以采集时间替代。已有可展示 Digest 原样返回；其余仅允许当前 ignored 且未关联 Event 的记录。优先复用完整处理字段、已保存准备结果以及 Raw / 正文 Cache；不发起抓取，不重跑 Stage1。必要时一次普通 Structured LLM 补齐展示字段，不做保留判断。

对同一 Raw 使用事务级 advisory lock，处理中重复请求返回冲突。生成后先独立提交 `metadata.put_back_preparation`，随后另一个事务原子写入 Digest、恢复标记和 Raw selected 状态；最终失败不丢失已保存准备结果，重试不重复调用模型。准备缓存自身保存失败明确报错并返回生成文本。写入前再次校验当前状态和归属，避免并发变更被覆盖。

同一期内按既有 URL 规范化函数识别跨 Raw / Feed 的相同作品，并对该 URL 的人工恢复使用相同事务锁；已有可展示 Digest 时返回已有条目，不新增处理记录或重复付费，也不将这条重复 Raw 伪装为已经恢复。不同日期不按 URL 合并。

Put Back 和 Stage3 排名写入共用一个短事务排名锁。Put Back 恢复时取分类最大名次加一；后续 Stage3 重跑时，恢复项与其他 Digest 一起参与排名，不再固定在末尾。首次 AI 排名替换恢复时的追加名次，后续仍沿用既有人工 display_rank 保护规则；过期排名清理同样适用。Stage3 排名 / 过期清理时清空 put_back_at 追加标记，原恢复准备记录仍保留在 Raw metadata。`put_back_at` 已由 `0020_digest_put_back.sql` 引入；上述重排规则复用该字段，不另增 rerank 字段。字段定义见 `../05-data-model.md` §3。


## 8.5 人工 URL 提交

人工候选的创建、独立 Generate 和审核行为见 `../01-product-spec.md` §4.2；技术边界见 `../04-technical-spec/discovery.md` §6.4。该入口不执行 D2–D5，不受自动候选数量或 D4 入选结论控制，不代表新的 Discovery 阶段。Pending 仅表示未审核，不表示介绍是否已生成。


## 14. Workflows Outside the Production Pipeline

以下能力与 Daily Processing 有关联，但**不属于 `npm run daily` 主流程**：

### Human Review

Human Review 位于 Publish 之后：

```text
Production Result
    ↓
Event / Long-form Ranking Review
    ↓
display_rank / feedback
```

它可以修改最终展示排序，并在 Event 被人工移入 Top cutoff 且尚无最终 Event 时按需调用单 Event Stage 4 enrichment。

Long-form Review 的 Daily membership 必须与 Production 一致，按 `processed_contents.daily_date = target dailyDate` 读取和保存，不重新根据 `raw_articles.published_at` 计算 24 小时范围。这样 72 小时 catch-up 后归入当前 Daily 的 Long-form 仍属于同一期 Review。

Human Review 不重跑完整 Daily Pipeline。

### Model Evaluation

Model Evaluation 是人工实验路径：

```text
Frozen Input
    ↓
independent model runs
    ↓
validated outputs
    ↓
Dashboard comparison
```

它：

- 不进入 Cron / Daily Orchestrator；
- 不修改 Production ranking；
- 不写 `processed_contents` / `events` / `event_review_items` / `feedback`；
- Stage 4 当前不参加多模型 Evaluation。

Human Review / Model Evaluation 的详细交互、API 和实验规则应维护在独立文档，而不是继续扩张本文件。
