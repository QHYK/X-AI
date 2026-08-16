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

# Stage 1 Backlog

`Digest` 是媒体/科研来源中值得浏览的内容；`Event` 是今天世界发生的重要事情。
所以：
> 重大疫情、自然灾害、金融危机、重大事故等，即使属于 Science / Health，也应该进入 Event。

我建议 Prompt 补一句非常短的规则：
  Routing is based on the role of the content in the Daily Brief, not its category. Major real-world developments such as outbreaks, disasters, conflicts, policy changes, market shocks, or major company events should route to Event regardless of category.


# Event 分支
```
processed_contents
routing = event
        ↓
Stage 2A — Merge
        ↓
~40–60 Event Groups
        ↓
Ranking
        ↓
Top 8–12
        ↓
Stage 2B — Understanding
        ↓
events
```