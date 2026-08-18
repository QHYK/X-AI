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