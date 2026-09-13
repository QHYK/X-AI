export type DashboardMetricDefinition = { metric: string; source: string; rule: string; notes: string };
export type DashboardMetricSection = { title: string; metrics: DashboardMetricDefinition[] };

export const dashboardMetricDefinitions: DashboardMetricSection[] = [
  { title: "1. Daily Overview", metrics: [
    { metric: "Raw / Pending / Selected / Ignored / Failed", source: "PostgreSQL · raw_articles", rule: "按 Daily 的上海 08:30–08:30 published_at intake scope，统计当前 stage1_status。", notes: "这是输入窗口，不是 processed_contents.daily_date。" },
    { metric: "Completion Backlog", source: "PostgreSQL · raw_articles", rule: "同一 intake scope 内 pending、有 URL、正文低于 Completion 阈值的当前数量。", notes: "不同于 Completion run 的 Remaining。" },
    { metric: "Processed Total / Event / Digest / Long-form / Inspiration", source: "PostgreSQL · processed_contents", rule: "按 processed_contents.daily_date = target Daily，按 routing 统计当前 DB 快照。", notes: "late-arrival 仍归入实际参与的 workflow Daily。" },
    { metric: "Published Events / Draft Events", source: "PostgreSQL · stage4_runs + events", rule: "按 stage4_runs.daily_date 归属，分别统计 publication_status=published 和 draft。", notes: "archived 不在 Daily Volume 主表。" },
    { metric: "LLM Calls", source: "PostgreSQL · pipeline_runs", rule: "同 Daily 各 Stage Latest Attempt 的实际 provider request 总和；无 DB run 才回退 runtime。", notes: "含 retry 与 Stage4 context-decision；不含 Web Search tool call。" },
  ] },
  { title: "2. Content Completion", metrics: [
    { metric: "Candidates", source: "PostgreSQL · pipeline_runs", rule: "目标 Daily 最新 Completion attempt 的 candidate_count；无 DB run 才回退 artifact。", notes: "正常 Daily 通常是约 72 小时 catch-up，不等于 24h Raw。" },
    { metric: "Selected / Succeeded / Failed", source: "Content Completion runtime", rule: "limit 后本次实际处理，以及处理成功/失败数。", notes: "Failed 只是这次尝试失败。" },
    { metric: "Remaining", source: "Content Completion runtime", rule: "run 结束后，按同一 eligibility 与 scope 重查的候选数。", notes: "包括未被 limit 选中与仍未补全成功的文章；Remaining != Failed。" },
    { metric: "Limit / Duration", source: "Content Completion runtime", rule: "artifact 的 global limit 与 wall-clock duration。", notes: "per-source limit 已记录但卡片未展示。" },
  ] },
  { title: "3. Exact Duplicate Filter", metrics: [
    { metric: "Duplicates ignored / Dedup rate", source: "Daily runtime → duplicate filter runtime", rule: "本期 pending candidates 中，按 exact trimmed URL 或 title 认定为 loser 并标记 ignored；rate=duplicateCount/inputCount。", notes: "历史前 72h raw_articles 仅作 reference，永不修改或成为 loser。" },
    { metric: "Remaining unique articles", source: "Duplicate filter runtime", rule: "outputCount = inputCount - duplicateCount。", notes: "不是 DB 全部 unique articles，也不是 Completion Remaining。" },
    { metric: "URL only / Title only / URL + Title", source: "Duplicate filter runtime", rule: "按每个 loser 与其他 candidate/reference 的 exact match 分类。", notes: "统计 loser 数，而非 duplicate group 数。" },
  ] },
  { title: "4. Stage 1", metrics: [
    { metric: "Status / Model / Prompt / Duration", source: "PostgreSQL · pipeline_runs", rule: "按 daily_date + step 选择 started_at 最新 Stage1 attempt；无 DB run 才回退 artifact。", notes: "最新 failed attempt 也会展示。" },
    { metric: "LLM Calls / Retries / Tokens", source: "Stage1 runtime", rule: "llm_call_count 是实际模型 requests；retry_count 是额外请求。", notes: "不重复展示 Daily Volume 的输入结果。" },
    { metric: "Batches / Fallback batches / Splits / Singleton batches", source: "Stage1 runtime", rule: "Stage1JobSummary 的 micro-batch 实际执行统计。", notes: "用于解释 batch fallback 行为。" },
  ] },
  { title: "5. Stage 2", metrics: [
    { metric: "Model / Candidates / Groups / LLM / Retries / Tokens / Duration", source: "Stage2 runtime", rule: "该 Daily 的最新 Stage2 attempt artifact。", notes: "Groups 是该次 Merge 输出，不保证等于后续 DB snapshot。" },
  ] },
  { title: "6. Stage 3", metrics: [
    { metric: "Model / Event inputs / Selected events", source: "Stage3 runtime", rule: "该 Daily 最新 attempt；Event inputs 来自 DB Event Groups。", notes: "Selected events 是完整 Ranking snapshot，不是 Top 15。" },
    { metric: "Digest / Long-form / LLM / Tokens", source: "Stage3 runtime", rule: "本次 attempt 内去重、ranking 与调用统计。", notes: "属于运行观测，不是当前 DB 最终内容数。" },
  ] },
  { title: "7. Stage 4", metrics: [
    { metric: "Status / Model / Selected input / LLM / Retries", source: "Stage4 runtime", rule: "目标 snapshot 前 N 的最新 Stage4 attempt；llm_call_count 包含 context decision 与 enrichment attempts。", notes: "quota/auth fail-fast 未启动项不算 Failed。" },
    { metric: "Ready / Drafts / Published", source: "Mixed · stage4_runs + events", rule: "Ready 为最新 run 持久化成功数；Drafts 为该 run draft；Published 为该 Daily 的正式 published Events。", notes: "Published 是 DB business state，不用 runtime eventsCreated 代替。" },
    { metric: "Failed", source: "Stage4 runtime", rule: "实际启动 enrichment 且最终失败的 selected Event 数。", notes: "不从 selected-ready 推导。" },
  ] },
  { title: "8. Content Funnel", metrics: [
    { metric: "Raw Content / Selected Content", source: "PostgreSQL · raw_articles", rule: "按 24h published_at intake scope 累加字符数。", notes: "NULL 计 0。" },
    { metric: "Processed Summary / Daily Brief", source: "Mixed · DB + Brief composition", rule: "当前实现分别累加已处理摘要与 Brief 展示字段。", notes: "该卡仍含 input-scope 与 workflow Daily 的不同时间语义。" },
  ] },
];
