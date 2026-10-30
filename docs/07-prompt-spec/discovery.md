# Discovery Prompt Contracts

生产 Prompt 文本以数据库实际绑定的 Published Version 为准。本节定义模型输入输出、判断与验证契约；D2 的完整中文 Prompt 仅作参考，不替代数据库版本。Shared Fragment 使用精确版本引用，通用模板与版本规则见 [Registry](registry.md)。

AI 职责见 [AI Workflow Spec](../03-ai-workflow-spec.md) §7；工具实现见 [Discovery Technical Spec](../04-technical-spec/discovery.md) §4；执行编排、提交数量和 Run / Resume 见 [Discovery Workflow](../06-workflow-spec/discovery.md)，持久化字段见 [Discovery Data Model](../05-data-model/discovery.md) / [Prompt Registry Data Model](../05-data-model/prompt-registry.md)。

## Shared Fragments

| Key | 语义 |
|---|---|
| `shared.discovery.editorial_criteria` | Discovery / Manual 共用的编辑标准，判断语义见 `../03-ai-workflow-spec.md` §7 |
| `shared.discovery.tags` | 下述双语 Tags 契约 |
| `shared.introduction.writing` | Introduction / Manual 的介绍写作目标 |

## Discovery Candidate Tags（D3-5）

`tags: [{zh, en}]` 最多三对，允许空数组；Tag 对象仅允许 required 的 `zh` / `en` 字符串，均不可为 null。应用层去除首尾空白后，`zh` 长度 1–80 且含中文，`en` 长度 1–120、含 Latin 字母且不含中文。每对双语非空且对应同一具体主题，不以作品类型、泛化或重复标签凑数。Code 校验语言和数量，按任一语言名称归一化去重。D3 / D4 / D5 在各自最终阅读评价中生成，Manual 适用同一契约；人工已有 Tags 的优先级见产品规范。Stage1 的既有 `string[]` 不在本任务中统一。

Transport Schema 与应用层语义校验分离：不把 Provider 不支持的 Unicode 正则发送给模型。图片 URL 不属于模型输出，由 Code 从真实响应提取。实现见 `src/lib/discovery-content-metadata.ts`。

以下 Input Schema 示例均为动态 Builder 实际返回的 JSON 结构（示例值仅作说明）。数据库 User Template 可包装这些业务输入；编辑标准由数据库 Prompt / Shared Fragment 提供，不是示例中的额外 JSON 字段。

## In-depth Category 输出契约

D3 / D5 在 `candidates[].category`、D4 在 `evaluations[].category` 返回单一主分类；Manual Generate 的根对象 `category` 也遵循本节。取值为单个枚举字符串或 JSON `null`，不接受数组、中文值、空字符串或其他分类。枚举和中文标签见 [Discovery Data Model](../05-data-model/discovery.md#discovery_candidates)，代码共用 `src/lib/in-depth-category.ts`。

- **Provider Strict Schema**：`category` 为 required + nullable，必须返回该键，无分类时返回 `null`。D3 / D5 由 SDK 将 Zod 的 nullable optional 转为严格传输 Schema；D4 显式定义 JSON Schema；Manual 使用 required nullable 的传输 Schema。
- **应用兼容解析**：允许旧输出缺少 `category`，或显式返回 `null`；非法非空分类仍使输出校验失败。兼容旧输出不表示新请求的 Provider Schema 可以省略该键。
- 分类与现有阅读评价在同一次请求中生成，不增加模型调用，不修改 Tags 或入选判断。保存与人工覆盖规则见上述 Data Model；已完成阶段沿用既有 Resume 规则，不为补分类重新运行。

## D2. Topic Selection

Key：`discovery.d2.topic_selection`；Shared Fragment：`shared.discovery.editorial_criteria`。入口及校验：`src/discovery/topic-selection.ts`；动态输入：`src/prompts/discovery-topic-selection.ts`。

**Goal:** 从两期 Daily Brief 中识别值得全文验证的单篇作品和可探索的知识问题；Selection 只判断研究潜力，不代替最终阅读评价。

### Input Schema

```json
{
  "contents": [
    {
      "contentId": "<input-content-id>",
      "contentType": "processed_content",
      "title": "Original title",
      "summary_zh": "内容概要",
      "tags": ["科学"],
      "source_name": "Source A, Source B",
      "directEligible": true
    }
  ]
}
```

`summary_zh` 优先取 `summaryZh`，缺失时回退 `summary`；`tags` 优先取非空 `tagsZh`，否则取 `tags`；`source_name` 将来源名称以 `, ` 连接。

固定两期 Daily 的 Event（全部）、Digest、Long-form 精简记录。上例是无 Memory 时的实际 JSON。有匹配记录时，Builder 另加 `memory: string`，内容为带有偏好边界说明的纯文本及序列化记录；读取与恢复规则见 [Memory Runtime](../04-technical-spec/discovery.md#memory-runtime)。每条记录包含 `contentId`（Event 对应 `events.id`，Digest / Long-form 对应 `processed_contents.id`）、`contentType`（`event | processed_content`）、原始 `title`、`summary_zh`、`tags`、`source_name` 和 `directEligible`，不传原文或原始 URL。

`directEligible` 由 Code 基于关联 Raw Article 的正文计算：`full_content_text` 非空，或 `content_text` 达到 3000 个 Unicode 字符；合并 Event 不能直接作为单篇作品。Code 保留内容 ID 到来源 / Raw Article 的映射；实际成员选择见 `../06-workflow-spec/discovery.md` §2。

### Output Schema

以下为严格传输的 JSON 实例，不是完整 JSON Schema 定义。根对象仅有 `leads`；每条 Lead 均包含六个 required 字段，不使用 `oneOf`，禁止额外字段。`sourceContentId`、`question`、`newsContext`、`sourceContentIds` 在传输 Schema 中 nullable，具体分支组合由应用层检查。

```json
{
  "leads": [
    {
      "kind": "direct",
      "sourceContentId": "<input-content-id>",
      "question": null,
      "rationale": "为什么值得全文验证",
      "newsContext": null,
      "sourceContentIds": null
    },
    {
      "kind": "topic",
      "sourceContentId": null,
      "question": "值得探索的具体知识问题",
      "rationale": "为什么值得学习",
      "newsContext": "与这两期 Daily 的关系",
      "sourceContentIds": ["<input-content-id>"]
    }
  ]
}
```

### Guidelines

- 综合比较整批内容，优先长期学习价值，而非新闻热度；不机械地为每条新闻生成问题。
- Direct 提名不等于已验证优秀；Topic 应具体、可探索，并关联输入中的实际内容。
- 最多 8 条 Direct / Topic 合计，按探索价值排序；允许不足或为空，不凑数，不宣称已阅读全文或发现外部作品。

### Validation

传输 Schema 限定 `kind = direct | topic`、`rationale` 为字符串、`leads` 最多 8 项，允许空数组。应用层进一步校验：

- Direct 的 `question` / `newsContext` / `sourceContentIds` 必须为 null；`sourceContentId` 与 `rationale` 非空，引用非 Event 且 `directEligible=true` 的输入；Direct 不得重复引用同一内容。 完成结构校验后，已知但不满足资格的 Direct 单条过滤；其他错误仍严格失败，无有效 Lead 的执行结果不视为成功，见 [Workflow 恢复规则](../06-workflow-spec/discovery.md#83-run-恢复与重新生成)。
- Topic 的 `sourceContentId` 必须为 null；`question` / `rationale` / `newsContext` 非空，`sourceContentIds` 至少一个，全部来自输入且内部不重复。

模型不输出 `leadId` 或 URL。应用层按输出顺序生成 `lead-01` 等 ID，为 Direct 从 Daily 关联补充 URL，再保存逻辑 Lead；无关分支的 null 占位不保留为逻辑字段。非法或缺失引用不能猜测补齐。执行与保存边界见 `../06-workflow-spec/discovery.md` §3、§8。

### 中文 Runtime Prompt 参考文本

以下文本有意保留，供理解任务基线；实际请求仍使用数据库 Published Version。

```text
基于提供的两期 Daily Brief，挑选最值得进一步研究的线索，供后续 Discovery Workflow 使用。

只输出两类线索：
1. direct：Daily 中已有且标记 `directEligible=true` 的单篇内容本身可能是值得亲自阅读的优秀作品，需后续阅读全文验证。引用准确的 sourceContentId。
2. topic：从重要事件或报道中提炼一个具体、可探索的知识问题（机制、原理、历史、科学、技术或经济背景），后续 Agent 将另行寻找优质解释作品。给出 question、rationale、newsContext、sourceContentIds。

优先判断长期学习价值，而不是新闻重要性。不要为每条新闻机械地产生问题；不要把普通新闻报道当作优秀长文；不要宣称已经读过全文或找到了外部作品。

两类合计最多 8 条，按研究优先级排序。允许少于 8 条，甚至为空。所有引用 ID 必须来自输入。为满足严格 Structured Output Schema，每条 lead 必须包含全部字段：`direct` 将 `question`、`newsContext`、`sourceContentIds` 设为 `null`；`topic` 将 `sourceContentId` 设为 `null`。只输出符合结构化 Schema 的 JSON。
```

## D3. Topic Discovery Agent - Agents SDK

Key：`discovery.d3.topic_discovery`；Shared Fragments：`shared.discovery.editorial_criteria`、`shared.discovery.tags`。入口、Transport Schema 及校验：`src/discovery/topic-discovery.ts`；动态输入：`src/prompts/discovery-topic-agent.ts`。

**Goal:** 围绕知识问题寻找值得完整阅读、观看或收听的原创作品，不直接回答问题；Agent 自行完成阅读和编辑评价。

### Input Schema

```json
{
  "topics": [
    {
      "leadId": "<topic-lead-id>",
      "question": "值得探索的知识问题",
      "newsContext": "与 Daily 内容的关系",
      "sourceContentIds": ["<input-content-id>"]
    }
  ],
  "memory": null
}
```

`memory` 使用当次 Run 配置中的显式 Memory，缺省为 `null`；`topics` 不包含 D2 的 `rationale` 或 Direct Lead。

常规调用一次接收 D2 的全部 Topic Leads，包含稳定 `leadId`、`question`、`newsContext`、来源 IDs，以及编辑标准和可选显式 Memory。Single Lead 仍为 Planned，当前不提供按 `leadId` 单独执行的入口；设计见 `../04-technical-spec/discovery.md` §6.3。

### Output Schema

```json
{
  "candidates": [
    {
      "sourceLeadId": "<topic-lead-id>",
      "url": "https://example.com/original-work",
      "title": "Original title",
      "title_zh": "忠实中文标题",
      "author": "",
      "contentType": "article",
      "publishedAt": null,
      "estimatedDurationMinutes": null,
      "summary": "中文内容概要",
      "whyWorthReading": "中文推荐理由",
      "evidence": "实际读到的关键论证/细节及对应来源",
      "tags": [{ "zh": "科学方法", "en": "Scientific Method" }],
      "category": "technology",
      "limitations": "无法核查的内容或访问限制",
      "extra_info": "{}"
    }
  ]
}
```

这是 `DiscoveryD3OutputSchema` 接收的传输 JSON 实例。根对象仅有 `candidates`，最多 3 项（允许空数组）；示例中 Candidate 的全部字段 required，禁止额外字段，D3 不输出 `publication`。

`sourceLeadId`、`url`、`title`、`title_zh`、`summary`、`whyWorthReading`、`evidence` 为长度至少 1 的字符串；`author` / `limitations` / `extra_info` 为字符串，可为空。`contentType` 是 article / video / podcast 枚举；`publishedAt` 是字符串或 null，`estimatedDurationMinutes` 是正整数或 null；`tags` 遵循共享契约。 

### Guidelines

- 自主比较所有问题，决定搜索、切换方向、追踪作者 / 原始出处及结束时机；不要求覆盖每个 Topic，不平均分配搜索次数，也不要求固定 Plan。
- 优先原创、可靠证据、清晰结构和长期学习价值。区分事实与判断，不编造作者、日期、工具调用或作品内容；具体编辑语义见 `../03-ai-workflow-spec.md` §7。
- 明显超过 30 分钟的完整作品应在搜索阶段跳过，不调用 Fetch；不因 PDF 格式直接拒绝，篇幅不明时可读取后判断。不能把长报告的部分章节当成符合时长要求的完整作品。
- 整个 D3 合计最多 3 篇，允许少于或为空；找到足够优质且有证据的作品可以停止，不为补足数量降低标准或强制继续探索。
- 原始 title 保持客观；title_zh 为忠实译名，中文原文可相同。summary / whyWorthReading 使用中文，不用补充评价替代必需字段。

### Validation

- 每项的 `sourceLeadId` 必须来自当前输入 Topic Leads，不默认绑定第一条或猜测 Lead。非法字段、日期、Tags 或 `extra_info` 导致阶段输出校验失败。
- `publishedAt` 的非 null 值须能被 `Date.parse()` 解析，转换为 ISO 时间；`title_zh` 转为应用字段 `titleZh`，`extra_info` 解析为对象 `extraInfo`。title_zh / summary / whyWorthReading 使用中文是 Prompt 要求，当前应用未另加这些字段的中文字符校验。
- 持久化前按规范化 URL 检查历史及本次重复；须有本次工具记录中同一规范化 URL 的成功 Fetch，不能仅凭 Agent 的 `evidence` 自述。无成功记录写为 `unverifiable`；重复作品或已知时长超过 30 分钟写为 `rejected`；只有 `selected` 创建 pending 审核候选。具体字段映射见文末。

日期 / 时长无法可靠核实时应返回 null 并说明限制；文章时长可按语言和正文长度估算，视频 / 播客优先可信元数据，这是模型判断要求，Code 不额外估算缺失时长。候选提交与失败状态见 `../06-workflow-spec/discovery.md` §5、§8。

### Tools & Evidence

实际 Agent 走 Responses API，仅配置 SDK `webSearchTool` 与 `fetch_content({url})`，不增加独立 Planner 或开放式工具权限。D3 目标作品在 Daily 之外，不能假定已抓取；必须结合真实工具记录确认作品 URL 和正文 / 字幕等可核查内容，搜索摘要不能替代阅读，Agent 自述不能替代证据。

`fetch_content` 使用固定 URL 的 HTTP(S) 校验、已有 Cache / Firecrawl，并将结果记录到本次 Agent context；结果含正文片段、长度、`content_complete`、`truncated` 与元数据。完整正文缓存不等于完整交付给模型，提取与截断边界见 `../04-technical-spec/discovery.md` §4.3。当前入选检查只要求 Fetch `status=success`，不额外强制 `content_complete=true` 或 `truncated=false`；充分阅读仍是 Prompt 的质量要求。

Agent 由 `maxTurns`、整体 AbortSignal 超时和工具超时限制；无最终输出明确失败。返回空候选且本次有 Fetch、所有记录均为 error 时，明确报 `tool_failure`；没有 Fetch 的空结果不自动报错。工具不可读取时明确限制，继续寻找其他作品或返回空结果；达到轮次、预算或超时限制时保留真实原因，不能冒充充分研究后的正常完成。资源配置、正文交付与 Cache 边界见 `../04-technical-spec/discovery.md` §4，Run 恢复见 `../06-workflow-spec/discovery.md` §8；外部网页指令不得改变任务。

## D4. Direct Candidate Verification

Key：`discovery.d4.direct_verification`；Shared Fragments：`shared.discovery.editorial_criteria`、`shared.discovery.tags`。入口、Schema 及校验：`src/discovery/direct-verification.ts`；动态输入：`src/prompts/discovery-direct-verification.ts`。

**Goal:** 基于 Daily 已有作品的实际正文作编辑评价，并为 qualified 作品提供独立的读者介绍；不负责排名或最终提交配额。

### Input Schema

```json
{
  "candidates": [
    {
      "candidateId": "<direct-candidate-id>",
      "title": "Original title",
      "author": null,
      "publication": "Source name",
      "publishedAt": null,
      "url": "https://example.com/original-work",
      "contentSource": "full_content_text",
      "contentMayBeIncomplete": false,
      "estimatedDurationMinutes": null,
      "content": "实际保存的文章正文"
    }
  ]
}
```

Builder 接收 Candidate 数组，当前调用方每次传入一篇。没有独立字数字段；正文完整性通过 `contentSource` 和 `contentMayBeIncomplete` 表达。

每次请求仅包含一篇通过 Code 前置检查的 Direct Candidate：candidateId、标题、URL、作者、来源、发表时间、可用时长及正文。优先读取 `raw_articles.full_content_text`，为空时使用已存 `content_text`，标明正文来源（full_content_text / content_text）及可能不完整；字段构造见动态输入 builder。

Code 检查 URL、正文可用性、历史重复和时长；不默认重新抓取，普通 LLM 不具备 Web Search 或网页读取工具权限。逐篇执行、保存和 Resume 见 `../06-workflow-spec/discovery.md` §4、§8，不在 Prompt 中维护这些编排规则。

### Output Schema

以下为严格传输 JSON 实例：根对象仅有 `evaluations`，示例中的全部 Evaluation 字段 required，禁止额外字段。传输 Schema 本身不限定数组恰为一项；当前调用一次传一篇，应用层检查一一对应。除 `category` 外的文本字段非 nullable，`evidence` / `limitations` 是字符串数组，`tags` 是双语数组。

```json
{
  "evaluations": [
    {
      "candidateId": "<direct-candidate-id>",
      "decision": "qualified",
      "reason": "中文评价理由",
      "title_zh": "忠实中文标题",
      "summary": "面向读者的中文内容概要",
      "whyWorthReading": "面向读者的中文推荐理由",
      "tags": [{ "zh": "科学方法", "en": "Scientific Method" }],
      "category": "technology",
      "evidence": ["正文中支持判断的具体论证或细节"],
      "limitations": ["无法核实的事项"],
      "extra_info": "{}"
    }
  ]
}
```

### Guidelines

- 基于实际阅读证据评价原创性、解释深度、结构、作者与证据可信度、长期价值和阅读回报；不能因来源知名或标题吸引人而直接通过。
- decision 为 qualified / rejected / unverifiable。缺正文或证据不足使用 unverifiable，不能伪装成内容质量低；reason / limitations 要说明证据缺口。
- qualified 的 title_zh、summary、whyWorthReading 是忠实中文读者介绍，不复制 reason 或拼接 evidence；长度由内容决定，无固定字数。rejected / unverifiable 可将这三项置空。
- 原始标题、作者和 URL 由输入提供，不重新编造；筛选理由、证据和限制与面向读者的介绍分开。

### Validation

输出必须恰好对应本次唯一 candidateId，不得遗漏、重复或增加其他 ID。三段介绍在传输中均为 required 字符串；qualified 时非空且含中文，其他结论允许空字符串。evidence / limitations 为数组，Tags 遵守共享契约；extra_info 为 JSON 对象序列化字符串。`candidateId` / `reason` 需非空；三段读者介绍去除首尾空白。缺失或无效输出记录单篇失败，不静默补齐必需介绍或追加模型调用。

严格传输要求 `extra_info` 为字符串；应用解析器兼容缺失值（转 `{}`）和已有对象，并非接受任意传输类型。最终必须为非数组对象，重新序列化后不超过 16 KiB（UTF-8 字节）。评价经转换后分别写入 Candidate 的 `evaluation`、`evidence`、`extra_info` 与读者介绍列；空读者介绍持久化为 null，不覆盖为虚构内容。

D4 不限制所有评价中 qualified 的总数；按 Lead 优先级提交前 3 篇的 Workflow 规则见 `../06-workflow-spec/discovery.md` §5。对 unverifiable 固定 URL 重抓并重评仍为 Planned，当前无此人工入口，不改变普通 D4 的工具权限。

## D5. Open Discovery - 复用 Agents SDK

Key：`discovery.d5.open_discovery`；Shared Fragments：`shared.discovery.editorial_criteria`、`shared.discovery.tags`。入口及 Transport Schema：`src/discovery/open-discovery.ts`；动态输入：`src/prompts/discovery-open-agent.ts`。

**Goal:** 不受本期新闻知识问题限制，开放寻找并评价符合 X-field 标准的高质量人类作品；自动兜底与人工补充复用同一能力。

### Input Schema

```json
{
  "memory": null,
  "manualContext": "可选的人工补充方向"
}
```

`memory` 使用当次 Run 配置中的显式 Memory，缺省为 `null`；`manualContext` 去除首尾空白后传入，未提供或为空时为 `null`。不传 Topic Lead、窗口或父 Run ID，这些关联由执行层管理。

编辑标准、适用的显式 Memory，以及仅人工 Open 适用的可选补充方向；不要求 Knowledge Question。自动 / 人工触发、父子 Run 关联和候选保留规则见 `../06-workflow-spec/discovery.md` §6、§8，本节不重新定义触发条件。

### Output Schema

以下为 `DiscoveryD5OutputSchema` 的传输 JSON 实例。根对象与 Candidate 均严格禁止额外字段，全部示例字段 required；数量、类型和 nullable 规则与 D3 相同，但不含 `sourceLeadId`，新增 required 字符串 `publication`（允许空字符串）。

```json
{
  "candidates": [
    {
      "url": "https://example.com/original-work",
      "title": "原文标题",
      "title_zh": "中文标题",
      "author": "作者或发布者",
      "publication": "发布来源",
      "contentType": "article",
      "publishedAt": null,
      "estimatedDurationMinutes": null,
      "summary": "中文内容概要",
      "whyWorthReading": "中文推荐理由",
      "evidence": "实际阅读的具体论证、细节及其出处",
      "tags": [{ "zh": "科学方法", "en": "Scientific Method" }],
      "category": "technology",
      "limitations": "访问限制或无法核实的事项",
      "extra_info": "{}"
    }
  ]
}
```

### Guidelines

- 优先原创、用心创作、结构严谨、有思想深度和长期学习价值的作品，不只追逐热点；以实际内容评估，不仅凭标题、摘要或来源名气。
- 对原创性、深度、作者可信度、证据可验证性和人类创作特征提供具体判断；无法确认时保留限制，不作确定性断言。
- 最多 3 篇，允许少于或为空，不凑数；不强制搜索次数或多轮 Plan。时长过滤、PDF 与完整作品边界、停止条件沿用 D3 Guidelines。
- 提供客观原始标题、忠实中文译名、中文 summary / whyWorthReading；仅在可靠时提供作者、日期、出版来源及估计时长，不编造。

### Validation

复用 D3 的字段、日期转换、Tags / extra_info 解析及持久化前检查；不可核实的日期和时长应为 null。`publication` 空字符串先转 null，最终来源仍按真实 Fetch 元数据、来源配置和 URL 回退归一化。缺少对应成功 Fetch、重复 URL 或时长超过 30 分钟的处理与 D3 相同，不增加 Final Evaluation 调用。中文内容是 Prompt 要求，应用层不另加 title_zh / summary / whyWorthReading 的中文字符校验。

D5 不关联 Topic Lead，不得伪造 sourceLeadId；publication 是输出字段，最终 Source 归一化仍由 Code 处理（`../04-technical-spec/discovery.md` §5.1）。传输字符串到应用对象及 JSONB 的映射见下节。

### Tools & Evidence

实际配置与 D3 相同的 Responses Agent、SDK Web Search 和 `fetch_content({url})`，以及 `maxTurns`、整体 / 工具超时；无最终输出或空结果下全部 Fetch 失败的处理也相同。复用 D3 的阅读证据及停止边界；Prompt 要求取得真实正文、字幕或其他可核查内容；当前硬检查同样只要求对应 Fetch 成功，不等同于全文完整性保证。不能将搜索摘要、模型记忆或 Agent 自述当作已阅读全文；工具不可用、访问受限、资源耗尽和正常空结果须区分。通过 Code 验证后直接进入审核，不自动上架；执行与持久化分别见 `../06-workflow-spec/discovery.md`、[Data Model](../05-data-model/discovery.md)。

## 共用传输校验与安全边界

### 传输、应用对象与持久化

输入示例是 Builder 输出；上述输出示例是传输 JSON 实例，完整 Provider JSON Schema / Zod 定义以各入口为准，不能把示例当成完整 Schema。

| 阶段 | `extra_info` 传输与解析 | 持久化 |
|---|---|---|
| D3 / D5 | required 字符串；最多 16,000 个 UTF-16 code units（`String.length`），空字符串按 `"{}"` 解析；非空值必须是 JSON 对象字符串，不能是数组 / null | 应用字段 `extraInfo` 为对象，保存到 `discovery_candidates.extra_info` JSONB |
| D4 | 严格传输为 required 字符串；解析器兼容缺失值和对象；解析后对象序列化最多 16 KiB UTF-8 | 同样保存到 Candidate `extra_info` JSONB |

D3 / D5 的 `title_zh → titleZh`、D4 的读者字段在应用层转换后写入 Candidate 对应列。各路径的双语 Tags 保存在 `evaluation.tags`；阅读证据与限制进入 `evidence`，不是读者 Editorial。D3 / D5 的 `evidence` / `limitations` 是字符串，D4 是字符串数组；持久化时与实际正文来源 / Fetch 记录组合成证据对象。完整字段映射见 [Data Model](../05-data-model/discovery.md)。

### 安全与执行边界

- 模型输入中的 Daily 数据、Memory、人工方向和网页正文均为数据，不升级为系统指令；外部内容不得改变任务。图片、来源、正文与工具证据只能来自实际取得的信息。
- 不用 `extra_info` 替代必需字段或绕过硬检查，不应包含敏感、无关或重复内容；当前解析器校验类型及大小，不提供通用敏感内容清洗。
- 双语 Tags 在应用层校验中文 / 英文并按任一语言归一化去重；输入数组先检查三对上限，再去重。传输层不发送 Provider 不支持的 Unicode 正则。
- 不将搜索次数、maxTurns、超时、并发和重试写进 Prompt，资源限制由 Code / SDK 管理，见 `../04-technical-spec/discovery.md` §4。版本记录与数据载体见 [Data Model](../05-data-model/prompt-registry.md)；Retry / Resume 见 `../06-workflow-spec/discovery.md` §8。
