```markdown
RSS / Email / Web
      ↓
Raw Article Discovery
      ↓
raw_articles
      ↓
Need Content Completion?
      ↓
  yes      no
   ↓        ↓
Web Extraction
   ↓
update content_text
      ↓
Stage 1
```


```markdown
Raw Article
   ↓
content 是否足够？
   ├─ 足够 → Stage 1
   │
   └─ 不足
        ↓
   是否允许 generic completion？
        ├─ yes → fetch + Readability
        │          ↓
        │      成功 → 更新 content_text
        │      失败 → 保留原内容
        │
        └─ no → 保留原内容
                   ↓
                Stage 1
```

```markdown
A 类 - **普通新闻摘要够用**
RSS 已经提供足够摘要
Bloomberg / WSJ / TechCrunch
→ 直接 Stage 1

B 类 - **已有长内容**
RSS 提供全文
SemiAnalysis 等
→ 直接 Stage 1

C 类 - **RSS 没有正文**
Nature
→ 需要 abstract completion
→ 先 Content Completion

D 类 - **Long-form 只有短摘要**
→ 需要 full article completion
→ 尽量 Content Completion

E 类 - Feed 本身失败，抓不到
Economist / The Information...
→ Collection Method 问题，暂时不阻塞 MVP
```

```
理解文章
  ↓
判断 category + routing
  ↓
routing = Ignore?
  ├─ Yes → enrichment 留空
  └─ No  → tags + entities + summary + translation
```