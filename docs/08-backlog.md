例如连续真实运行 7～14 天之后，记录：

每天 Raw Article 数量 → Stage 1 保留数量 → Event Candidate 数量 → Merge 后 Event 数量 → Top 10；
Event Merge 的人工检查正确率；
Top 10 中你人工认为“不该出现”的比例；
你手动调整 display_rank 的比例；
Stage 1 Ignore 的误杀情况；

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

？？Collection dedup 目前是 source 内 dedup；未来可以考虑 canonical URL 跨同 publisher feeds dedup。

分析来源数据获取情况，是否遗漏，结构是否可用？
部分 Feed 特殊情况：
* BLS 需要浏览器式 User-Agent；
是否还有其他 

+ Email Collector
这是新的输入通道，会碰 parsing、newsletter 拆分、source mapping，复杂度明显更高。
+ Editorial Memory / 人工知识加权
这个最值得最后做，因为它会真正改变 Stage1/Stage3 决策行为，应该建立在我们已经有足够真实 review 数据之后，不然很容易把“临时偏好”写成长期规则。
+ content text > 2000 就展示read more；API对应的用content调llm也可以。

#### 调整 stage 4 prompt 和 「金融研究日报」scheduled prompt 产出格式类似