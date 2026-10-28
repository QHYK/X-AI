# X-AI-field Prompt Spec

本文档定义 Application 与 LLM 的接口合同。Runtime Prompt 应与本文件保持一致；修改 Runtime Prompt 或 Structured Output Contract 时，应同步更新本文件。

## Prompt Registry 与生产加载契约

生产文本唯一来源是数据库中实际绑定的 Published Version。稳定 Request / Fragment key 和模板校验由 `src/lib/prompts/contracts.ts` 定义；Registry / Published / Active 的存储约束见 [Data Model](../05-data-model/prompt-registry.md)，加载与管理 UI 架构见 `../04-technical-spec/architecture.md` §5、`../04-technical-spec/admin-api.md` §7。

- 模板仅支持 `{{input}}`、Digest 的 `{{category}}` 和 System 中的 `{{fragment.<key>}}`；禁止表达式，不递归解析替换值。动态输入仍由代码构造并 JSON 序列化，不能因模板为空而丢失。
- System / User 均可为空，空角色不发占位；System 不引用正文 input。User 未引用 input 时，保留其非空文本，并以两个换行追加业务输入。Chat / Responses / Agents SDK 按实际接口映射，不增加 Developer 角色。
- 普通 Fragment 使用 Fragment Key 与精确 Published Version ID，其 Active 更新不改变已有 Request；仅下述三个 System Fragment 例外。仅允许 Request → Fragment，不嵌套；模板文本决定展开顺序；引用数组不负责排序。新 Key 引用须与所有 System 变体的占位符并集一致，同一变体内不得重复引用同一 Key。历史 Slot 引用保留原校验与渲染。
- Stage4 Enrichment 必须显式选择 `without_search` / `with_search` 变体，各自独立校验。Schema、工具、模型、Agent Loop 和动态输入始终由代码管理。
- 缺失版本、非法引用、变量或变体、数据库错误均明确失败，不允许静态 fallback。

### 三层 System Prompt

Daily 的 9 类 Request（Stage1–4、Put Back、Read More）和 Discovery D2–D5 显式采用 Identity → 业务 Editorial → 原 Request Instructions；`in_depth.*` 暂不接入。新编辑器直接使用 Fragment Key：

```text
{{fragment.xfield.identity}}

{{fragment.daily_brief.editorial}}

<原 System Instructions，逐字保留，包括已有 Fragment 占位符>
```

对应引用为 `{key: "xfield.identity", activeKey: "xfield.identity"}` 与 `{key: "daily_brief.editorial", activeKey: "daily_brief.editorial"}`（Discovery 使用 `discover.editorial`）。仅这三个 Key 允许动态引用，同一 Request 不重复引用它们；没有显式引用就不展开，不自动注入。Stage4 各变体按自己的模板位置展开；仍被其他变体引用的 Fragment 不删除绑定。Memory 仍是 User 业务输入，不参与 System 组合。

新 Daily / 独立 Stage、Discovery Regular / 独立 Open、Stage4 Run 在建立时读取三个 Active UUID 并持久化；同一 Run 的未执行 Request、Retry、Resume 都使用此快照，Fragment Activate 不改变已有 Run。普通精确 Fragment 完全不变。Read More 每次生成固定，Put Back 失败重试复用；Evaluation 随冻结输入固定，进入业务 Builder 前剥离快照包装。存储位置见 [版本绑定载体](../05-data-model/prompt-registry.md#版本绑定载体)。这不是 Memory Snapshot 或完整 Replay。

历史绑定旧 Request 继续使用原版。历史无快照且 Request 未绑定时，只接受升级工具在新 Published 的 `change_note` 中记录的明确前序 UUID（仍须同 Key、Published、无动态引用）；没有可证明前序则报错，不选最新 Active 凑数。不得将不同 System Fragment 快照的排名拼入一次恢复执行。缺 Fragment、无有效 Active 或快照 UUID / Key 不符均在模型调用前失败。

三个 Fragment 以空内容 Published `v1` 初始化，首次编辑 Draft 为 `v2`，Publish / Activate 仍分开。初始化和基于现有 Active 内容的幂等升级由 Operations 的独立命令执行，不修改冻结的历史 Seed 或 Published。新环境也需完成该升级，不能只导入原始 18 项。

管理页通过一个 Fragment Select 选择已注册 Fragment 并插入 Key 占位符。普通 Fragment 必须另外明确选择 Published Version；动态项显示当前 Active，不能把此显示当成历史 Run 实际版本。手动输入合法 Key 同样建立待校验引用，普通项未选版本不能保存。删除占位符时按所有变体的并集清理绑定。旧 Slot 只在本地 Draft 编辑副本中转换，不修改 Published 或历史 Run。

### 执行版本边界

Run 内某 Request Type 首次执行才绑定 Active，绑定提交成功后才调用模型；同次执行的批次、分类、自动重试和 Agent Loop 固定精确版本。持久化 Resume 使用原绑定，未执行类型不预先绑定。历史缺少可验证 UUID 时不能声称恢复旧文本。Daily / Discovery 的特例分别见 `../06-workflow-spec/daily.md` §12.1、`../06-workflow-spec/discovery.md` §8.3；版本载体见 [版本绑定载体](../05-data-model/prompt-registry.md#版本绑定载体)。

Introduction / Manual Generate 每次用户主动 Generate / Regenerate（含失败后再次点击）是新操作，使用当前 Active；同一 HTTP 请求内部重试复用版本，记录仅代表最近一次尝试，不是跨请求 Resume 或完整历史。Put Back 失败重试按文章复用绑定；已保存准备结果不重复生成。Evaluation 对同一评测输入固定版本，冲突明确失败。Manual / Put Back 调用模型前以短事务领取版本及执行标记，不跨 LLM 调用持有事务；进程中断恢复见 Operations。

### 初始化与测试基线

`production-seeds.ts` 读取冻结的 `seed-baseline.json`，仅初始化新环境，不参与 Runtime；保留初始编号、精确引用、条件变体及 Git 来源。导入规则与命令见 `../09-operations.md` §2.3。独立历史请求文本固定在 `scripts/fixtures/legacy-prompt-baseline.json`，不得从当前 Seed / Active 反向生成 Parity 基线。`src/prompts/` 仅保留动态输入、类型和历史标签；`*_PROMPT_VERSION` 不代表实际运行版本。

