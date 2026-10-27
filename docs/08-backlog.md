例如连续真实运行 7～14 天之后，记录：
- Event Merge 的人工检查正确率；
- Top 10 中你人工认为“不该出现”的比例；
- 你手动调整 display_rank 的比例；
- Stage 1 Ignore 的误杀情况；


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

---

## Prompt Registry 事故恢复说明

保留工具：`scripts/restore-prompt-registry.ts`。它是一次特定误删事故的恢复工具，**不是通用 Migration、重置或数据库恢复入口**；本附录不新增可直接执行的恢复命令。

### 适用场景与前置核对

- 仅针对原事故中 `prompt_registry`、`prompt_versions` 两表及附属表约束 / Trigger 缺失，而两个 Guard Function 仍存在且与原 `0021_prompt_registry.sql` 一致的状态。
- 执行前重新核对获授权的目标数据库 / Schema、备份、两表确实不存在、无异常同名对象，以及 `stage4_runs.prompt_versions` 和 Drizzle Migration 历史保持原状。
- 脚本固定检查目标环境、0021 SQL Hash、Guard Function 正文及事故时 Migration 历史 Hash。环境或历史变化就应停止；不能通过修改常量绕过检查，也不能因为曾经授权过事故恢复而直接重跑。

### 行为、风险与验证

默认 dry-run 只连接数据库检查状态；显式执行模式才在单事务中重放原 0021 中缺失的表、复合外键和 Trigger，保留 Guard Function。失败回滚；不执行 0022、不重置迁移历史、不修改其他业务表。具体参数以脚本自身解析为准；使用前需重新审查并确认操作范围，本次不执行。

结构恢复后验证两表、主键 / 唯一约束、同 Registry Active 外键和 Trigger，以及 Published 不可变、Draft 不可 Active、非法 Fragment 引用被拒绝；同时核对 Stage4 字段、Guard Function、迁移历史和其他业务结构未变。脚本的保护验证使用 Savepoint 回滚测试记录。

结构恢复不等于恢复 Prompt 数据：初始 Seed 导入与验收使用 [Operations](09-operations.md)「Prompt 基线导入与生产接入」的现有流程，确认 15 个 Request、3 个 Fragment 及有效 Active Published Version；不能覆盖已有版本。历史人工编辑版本及 Run 引用的旧 UUID 只能从可靠备份恢复，Seed 无法重建；缺少旧版本可能使 Retry / Resume 明确失败，不得静默换用新 Prompt。
