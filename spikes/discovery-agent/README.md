# Discovery Agent Technical Spike

状态：2026-10-15 已完成一次真实外部调用验证。本目录是隔离实验，不是 `src/discovery/`
生产实现，不写 Daily 业务表，也没有创建 Discovery 数据表。

## 结论

**GO WITH CHANGES**。

核心能力已经在项目现有 Codex Responses endpoint 上真实跑通：Agents SDK 模型调用、Hosted
Web Search、Agent 自主选择 URL、Firecrawl `fetch_content`、结构化最终输出，以及自定义
`TracingProcessor`。进入生产开发前仍需处理两点：

1. `04a-discovery-technical-spec.md` 当前写的是“OpenAI 官方 API”，本次按项目要求实际验证的是
   本机 Codex endpoint。若正式实现必须严格使用官方 endpoint，需要配置独立的
   `DISCOVERY_OPENAI_API_KEY` 后重跑同一套命令；本次没有用项目 `OPENAI_*` 兼容代理冒充官方验证。
2. SDK 没有把 Hosted Web Search 导出为独立 Span。它作为 Responses `response` span 中的
   `web_search_call` output item 出现；生产 Trace adapter 需要从该字段提取搜索动作，而不能假设
   每次搜索都有独立 `function` span。

## 版本与运行环境

- `@openai/agents`: `0.20.0`（精确锁定）
- `zod`: `4.6.7`（精确锁定；SDK 要求 Zod v4）
- `openai`: 项目既有 `7.4.0`，满足 SDK 的 `^7.2.0`
- Node.js: 实测 `v26.8.1`
- TypeScript: 项目既有 `5.9.2`

版本选择依据：官方 SDK 安装说明要求 `@openai/agents` 与 Zod v4；`0.20.0` 是安装时 npm
registry 的稳定版本，且其 OpenAI SDK 约束与项目版本兼容。

参考：

- [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)
- [Hosted tools](https://openai.github.io/openai-agents-js/guides/tools/)
- [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)

## 代码结构

- `index.ts`：基础调用、Hosted Search 与完整 Discovery 三种真实运行模式。
- `firecrawl-tool.ts`：Agents SDK Function Tool `fetch_content(url)`。
- `jsonl-tracing.ts`：本地 JSONL `TracingProcessor` 与敏感/大字段过滤。
- `test.ts`：不调用付费服务的边界测试。
- `runtime/`：真实运行结果和 Trace；被本目录 `.gitignore` 忽略。

## Provider 与普通 LLM Client 的边界

项目普通 LLM 调用通过 `src/processing/llm-client.ts` 兼容 OpenAI、DeepSeek、Kimi 和 Codex。
其中名为 `openai` 的默认 endpoint 实际是 `https://128api.cn/v1`，因此普通 Responses 或 Chat
Completions 成功不能证明 Hosted Web Search 可用。

本 Spike 不复用该普通 LLM Client。Agents SDK 使用自己的 OpenAI client，并按本次要求读取：

- `CODEX_API_KEY`
- `CODEX_BASE_URL`（实测 origin：`http://127.0.0.1:8317`）
- `CODEX_MODEL`（实测：`gpt-5.6-terra`）

SDK 明确使用 Responses API。Hosted Web Search 是否可用由真实 `web_search_call` 验证，而不是由
基础模型调用推断。

官方 endpoint 模式只接受独立的 `DISCOVERY_OPENAI_API_KEY`，刻意不回退到项目 `OPENAI_*`。
模型可通过 `DISCOVERY_AGENT_MODEL` 显式指定。

## 实际测试结果

### 1. Agents SDK 基础调用

命令：

```bash
npm run spike:discovery-agent -- --mode=basic --endpoint=codex
```

结果：成功。`gpt-5.6-terra` 返回通过 Zod 校验的结构化输出：

```json
{ "message": "连通性确认：Agents SDK 模型调用成功。" }
```

### 2. Hosted Web Search

命令：

```bash
npm run spike:discovery-agent -- --mode=hosted-search --endpoint=codex
```

结果：成功。真实 Trace 中存在：

```json
{
  "type": "web_search_call",
  "status": "completed",
  "action": {
    "type": "search",
    "query": "Transformer attention long-range dependencies ..."
  }
}
```

模型返回的 URL 为 `https://arxiv.org/abs/1706.03762`。本次调用的 `tool_usage.web_search.num_requests`
为 `1`。

第一次探测曾在调用工具前收到 400：Codex endpoint 不接受 Zod `url()` 生成的 JSON Schema
`format: "uri"`。Spike 随后改为 schema 中使用普通 string、应用层严格校验 HTTP(S) URL；再次运行
成功。这是 endpoint 的 Structured Output schema 子集差异，不是 Hosted Search 失败。

### 3. 自主搜索与 Firecrawl 阅读

命令：

```bash
npm run spike:discovery-agent -- --mode=discovery --endpoint=codex
```

固定 Knowledge Question：

> 为什么 Transformer 的 Attention 机制能够捕捉长距离依赖？有没有适合主动学习者阅读的高质量原始解释文章？

结果：成功。Agent 自己决定搜索词，从搜索结果选择
`https://jalammar.github.io/illustrated-transformer/`，调用 `fetch_content`，取得真实正文后再生成最终
推荐。没有在 Code 中预先固定搜索词或目标 URL。

实际抓取摘要：

```json
{
  "url": "https://jalammar.github.io/illustrated-transformer/",
  "status": "success",
  "content_length": 32465,
  "returned_content_length": 20000,
  "truncated": true,
  "content_type": "article_body",
  "error": null
}
```

最终结构化输出包含：

- 原始 URL：`https://jalammar.github.io/illustrated-transformer/`
- 标题：`The Illustrated Transformer`
- 中文摘要：说明 Query/Key 点积、softmax 权重、Value 聚合、多头注意力和位置编码如何支持远距离信息交互
- 中文推荐理由：建议以文中的代词关联示例和 Q/K/V 图解进行主动学习
- 阅读证据：5 条来自实际抓取正文的机制性证据
- 限制：正文返回给模型的部分截断到 20,000 字符；文章是高质量二次解释，不是原论文

应用层还会核对最终 URL 是否存在对应的成功 `fetch_content` 记录。即使模型在抓取失败后声称成功，
运行也会被判为失败，不能产出伪造的成功 artifact。

### 4. Firecrawl 工具

工具调用沿用 Production Content Completion 的：

- Firecrawl v2 scrape endpoint 与 `onlyMainContent` 请求方式；
- `FIRECRAWL_API_KEY`；
- timeout / retry 环境配置；
- 已导出的 `extractFirecrawlContent()` 清洗和正文提取逻辑。

实际生产 `scrape()` 是私有函数，并且绑定 Content Completion 的数据库候选、双 Key pool 和 limiter，
无法直接用于任意 URL。因此 Spike 只复用了清洗函数，并实现了隔离的单 URL HTTP adapter；没有修改
Production 代码，也没有写数据库。

工具返回原始 URL、成功/失败状态、可供 Agent 阅读的清洗正文、原始/返回长度、截断标记、内容类型和
错误。最多向 Agent 返回 20,000 字符，完整网页正文不会复制到 Trace。网页内容在 Agent instructions
中被明确标记为不可信数据。

单元测试验证了真实的工具错误返回结构：403 / 抓取失败时 `status=error`、正文为空且保留错误原因；
失败结果不会被包装成正文。

## TracingProcessor 实测

Spike 使用 `setTraceProcessors([processor])` **替换**默认 exporter，避免实验 Trace 同时发送到 OpenAI
平台。每次运行在 `finally` 中调用全局 Trace Provider 的 `forceFlush()`。

完整 Discovery 的本地 Trace 共 16 条 JSONL event，实际父子关系为：

```text
trace_89d81fea90134f77a35efc45ed5d88e7
└─ task span_e10b5494c37b44d3935de4ea
   └─ agent span_91f8a3885d5e4f3285a064ab
      ├─ turn span_1488332f8fd64711803e9d19
      │  ├─ response span_6fc5e05158344157809a0049 (Hosted Search)
      │  └─ function span_d1b6c50300864ee9970063db (fetch_content, 1710 ms)
      └─ turn span_0d9efe155efb4c49b70f61d2
         └─ response span_4fa644a721a84b8e94a1cbed (Final Output)
```

真实可取得字段包括：

- Trace：`traceId`、name、groupId、metadata；
- Span：`traceId`、`spanId`、`parentId`、`spanData.type`、start/end、error；
- response span：model、status、usage、Hosted Search action 与 tool usage；
- function span：工具名、调用 URL、脱敏结果、耗时与错误。

JSONL 不保存 API Key、Authorization、完整网页正文、完整模型 input/output 或 reasoning encrypted content。
异常经正常 `catch/finally` 退出时会 flush；`SIGKILL`、机器宕机等无法执行 `finally` 的异常退出仍可能丢失
内存中尚未 flush 的事件。生产数据库 Processor 需要在可靠性与写入开销之间选择即时写入或小批量 flush，
并注册正常 shutdown hooks。

## 与 `04a` / `05` 设计的差异

| 设计假设                               | 实测结果 / 生产补充                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Discovery 首版使用 OpenAI 官方 API     | 本次依要求使用 Codex endpoint；核心能力可用，但官方 endpoint 未实测                                                        |
| Agent / model / tool 可区分为 Span     | Agent、turn、response、Function Tool 均可区分；Hosted Search 不单独成 Span，而在 response output 中                        |
| `discovery_trace_spans` 字段可映射 SDK | trace/span/parent/type/time/error 可直接映射；业务 `run_id`、展示 status/name 需 Application Code 补充                     |
| 工具参数、结果可追溯                   | `fetch_content` 有独立 function span；Hosted Search 有 query/action 与 request count，但 SDK 没有提供完整搜索结果列表 Span |
| 不重复保存完整正文                     | 可实现；本 Processor 只保留 URL、状态、长度、截断和错误                                                                    |
| 可用现有 Firecrawl 封装                | 只能复用导出的 extraction；生产 scraper 当前不是通用 URL adapter                                                           |
| Structured Output 可直接用常规 Zod URL | Codex endpoint 拒绝 `format: uri`，需 string + Application URL validation                                                  |

生产实现还应把 Discovery business run ID 写入 trace metadata 或 Processor context；SDK 不会自动知道数据库
`discovery_runs.id`。Hosted Search 的最终 provenance 不能只靠 Span，需要同时保存 Responses citation / run item
中的实际 URL，且仍由业务层核对候选与成功 fetch 证据。

## 复现命令

不付费的本地测试：

```bash
npm run test:discovery-agent-spike
npm run typecheck
```

真实 Codex / Firecrawl 测试（会产生外部调用成本）：

```bash
npm run spike:discovery-agent -- --mode=basic --endpoint=codex
npm run spike:discovery-agent -- --mode=hosted-search --endpoint=codex
npm run spike:discovery-agent -- --mode=discovery --endpoint=codex
```

需要：`CODEX_API_KEY`、`CODEX_BASE_URL`、`CODEX_MODEL`；完整 Discovery 还需要
`FIRECRAWL_API_KEY`。CLI 使用项目 `loadPipelineEnvironment()`，优先级保持 Shell > `.env.local` > `.env`

> 代码默认值。

若未来要按 `04a` 验证官方 endpoint：

```bash
DISCOVERY_OPENAI_API_KEY=... \
DISCOVERY_AGENT_MODEL=... \
npm run spike:discovery-agent -- --mode=hosted-search --endpoint=official
```

本次未配置 `DISCOVERY_OPENAI_API_KEY`，因此没有声称官方 endpoint 已经实测成功。
