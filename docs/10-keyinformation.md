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
1. 自动 Open：只有 Direct 和 Topic 都正常完成，且合计 0 篇合格作品时才触发。
2. 分支失败：保留另一分支的有效结果，记录错误，不自动重跑，也不自动触发 Open。
3. 人工审核：除了最终推荐作品，还展示 D2 Topic Selection 的全部线索及其执行结果。
4. 人工补充执行：审核者可以选择某条 Direct 或 Topic 线索，按对应 ID 单独执行；也可以直接触发 Open Discovery。