# X-AI-field Prompt Spec

本文档定义 Application 与 LLM 的接口合同。Runtime Prompt 应与本文件保持一致；修改 Runtime Prompt 或 Structured Output Contract 时，应同步更新本文件。

## Prompt Registry 与生产加载契约

生产文本唯一来源是数据库中实际绑定的 Published Version。稳定 Request / Fragment key 和模板校验由 `src/lib/prompts/contracts.ts` 定义；Registry / Published / Active 的存储约束见 [Data Model](../05-data-model/prompt-registry.md)，加载与管理 UI 架构见 `../04-technical-spec/architecture.md` §5、`../04-technical-spec/admin-api.md` §7。

- 模板仅支持 `{{input}}`、Digest 的 `{{category}}` 和 System 中的 `{{fragment.slot}}`；禁止表达式，不递归解析替换值。动态输入仍由代码构造并 JSON 序列化，不能因模板为空而丢失。
- System / User 均可为空，空角色不发占位；System 不引用正文 input。User 未引用 input 时，保留其非空文本，并以两个换行追加业务输入。Chat / Responses / Agents SDK 按实际接口映射，不增加 Developer 角色。
- Fragment 使用有序 slot 与精确 Published Version ID，仅允许 Request → Fragment，不嵌套。Fragment Active 更新不改变已有 Request；占位符须与引用顺序一致。
- Stage4 Enrichment 必须显式选择 `without_search` / `with_search` 变体，各自独立校验。Schema、工具、模型、Agent Loop 和动态输入始终由代码管理。
- 缺失版本、非法引用、变量或变体、数据库错误均明确失败，不允许静态 fallback。

### 执行版本边界

Run 内某 Request Type 首次执行才绑定 Active，绑定提交成功后才调用模型；同次执行的批次、分类、自动重试和 Agent Loop 固定精确版本。持久化 Resume 使用原绑定，未执行类型不预先绑定。历史缺少可验证 UUID 时不能声称恢复旧文本。Daily / Discovery 的特例分别见 `../06-workflow-spec/daily.md` §12.1、`../06-workflow-spec/discovery.md` §8.3；版本载体见 [版本绑定载体](../05-data-model/prompt-registry.md#版本绑定载体)。

Introduction / Manual Generate 每次用户主动 Generate / Regenerate（含失败后再次点击）是新操作，使用当前 Active；同一 HTTP 请求内部重试复用版本，记录仅代表最近一次尝试，不是跨请求 Resume 或完整历史。Put Back 失败重试按文章复用绑定；已保存准备结果不重复生成。Evaluation 对同一评测输入固定版本，冲突明确失败。Manual / Put Back 调用模型前以短事务领取版本及执行标记，不跨 LLM 调用持有事务；进程中断恢复见 Operations。

### 初始化与测试基线

`production-seeds.ts` 读取冻结的 `seed-baseline.json`，仅初始化新环境，不参与 Runtime；保留初始编号、精确引用、条件变体及 Git 来源。导入规则与命令见 `../09-operations.md` §2.3。独立历史请求文本固定在 `scripts/fixtures/legacy-prompt-baseline.json`，不得从当前 Seed / Active 反向生成 Parity 基线。`src/prompts/` 仅保留动态输入、类型和历史标签；`*_PROMPT_VERSION` 不代表实际运行版本。

