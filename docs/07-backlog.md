例如连续真实运行 7～14 天之后，记录：

每天 Raw Article 数量 → Stage 1 保留数量 → Event Candidate 数量 → Merge 后 Event 数量 → Top 10；
Event Merge 的人工检查正确率；
Top 10 中你人工认为“不该出现”的比例；
你手动调整 display_rank 的比例；
Stage 1 Ignore 的误杀情况；
Stage 4 Web Search 实际触发比例；
每日 LLM token / API cost；
一次 Daily Pipeline 总耗时；
各 Stage 的失败 / Retry 情况。

现在你可以说：

> “我设计了一套四阶段 AI information-processing pipeline。”

有数据以后你就能说：

> “系统每日处理约 X 篇内容，经 Stage 1 筛选压缩至 Y%，Event Merge 将 Z 条候选合并为 N 个现实事件；人工抽检 Merge 准确率 XX%，Top 10 人工调整率 XX%，单日 AI 成本约 $X。”

# Collection Backlog

- Nature Chemistry / Biotechnology
  → 后续研究 DOI / publication metadata / abstract API

- Economist
  → RSS / Web blocked，后续考虑 Email

- Bloomberg Opinion / FT Lex
  → Web extraction blocked，使用 RSS 内容

- The Information
  → RSS blocked，后续考虑 Email

- CME
  → Web extraction timeout，后续调查

- BLS
  → snapshot-style dedup 潜在问题，目前忽略

Collection dedup 目前是 source 内 dedup；未来可以考虑 canonical URL 跨同 publisher feeds dedup。

### srv/procession
event-date 逻辑，是否有复杂时间转换？

分析来源数据获取情况，是否遗漏，结构是否可用？
部分 Feed 特殊情况：
* BLS 需要浏览器式 User-Agent；
是否还有其他 

---

## `04-technical-spec`
### 4.1 Daily Workflow
还需改

RSS Collector
Source → RSS fetch → normalize → deduplicate → raw_articles
现在是collector的时候就有deduplicate吗？
### 4.4 Deduplication

---

## Restore strict Stage 2 validation

Stage 2 当前只记录 schema / assignment 问题而不阻断 runtime output。后续单独评估并恢复
blocking validation，重新要求每个 `temp_id` exactly once。
