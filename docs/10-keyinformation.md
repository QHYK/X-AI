<!-- 这里记录一些重要的逻辑和错误处理方式, 以及一些bug修正过程中发现的需要被人类记住的信息 -->
# Key information

#### stage 3 什么时候失败？
Ranking	| Invented ID | 重复 ID | 缺失 ID
Event	|  直接剔除    | 去重	 | 不补齐
Digest	|  直接剔除    | 去重	 | 按输入顺序追加到末尾
Long-form| 直接剔除    | 去重	 | 按输入顺序追加到末尾

#### 环境变量优先级
配置优先级：Shell > .env.local > .env > 默认值

#### In-depth Discovery 的规则：
1. 自动 Open：只有 Direct 和 Topic 都正常完成，且合计 0 篇时才触发。
2. 分支失败：保留另一分支的有效结果，记录错误。
3. 人工补充执行：审核者可以选择某条 Direct 或 Topic 线索，按对应 ID 单独执行；也可以直接触发 Open Discovery
4. Generate 顺序为：
完整 Cache／已有 Candidate 正文 → Daily 已存全文 → 固定 URL 的 Firecrawl → 普通 LLM。
5. 可恢复执行：D2 不重复选择 Topic，D3 整体重试，D4 逐篇恢复。
- **D3** ：一次 Agent Run 接收全部 Topic Leads，自主决定搜索顺序、是否切换方向、是否继续探索
- **D4** 串行调用llm，每完成一篇 立刻更新数据库

Candidate 创建后，LLM 成功或失败分别是什么状态：
阶段	Candidate 状态
创建 Candidate，等待 LLM 评价	discovered
LLM 调用失败	仍为 discovered
LLM 返回 qualified	evaluated
qualified 且进入人工审核队列	selected
LLM 返回 rejected	rejected
LLM 返回 unverifiable	unverifiable

