# Operations

本文档是 X-AI-field 所有**操作入口**的唯一 Source of Truth：命令、CLI 参数、环境变量、测试、诊断、回填与人工恢复程序均以这里为准。

它不定义 Daily scope、阶段资格、排序、持久化/幂等性、AI 判断、Prompt 或数据模型。需要理解这些语义时，分别链接至 [Workflow Overview](02-workflow-overview.md)、[Technical Spec](04-technical-spec.md)、[Prompt Spec](07-prompt-spec.md) 与 [Data Model](05-data-model.md)。

需要环境变量的 TypeScript CLI 会先加载 `.env`，再以 `.env.local` 覆盖；不要提交凭据。

## 1. 快速入口

| 目的 | 命令 |
|---|---|
| 本地开发 | `npm run dev` |
| 生产构建 / 启动 | `npm run build`；`npm run start` |
| 静态检查 | `npm run typecheck`；`npm run lint` |
| 完整 Daily workflow | `npm run daily` |
| 指定 Daily workflow | `npm run daily -- --date=YYYY-MM-DD` 或 `DAILY_DATE=YYYY-MM-DD npm run daily` |
| 数据库 migration | `npm run db:migrate` |
| 同步 Source 配置 | `npm run db:seed` |

`daily` 的 `--date` 优先于 `DAILY_DATE`。其余 processing CLI 不解析 `--date`，要指定目标日期时使用 `DAILY_DATE=YYYY-MM-DD`。

当前仓库没有 CI workflow、Docker/部署 manifest、Procfile 或内置 scheduler。生产调度器若存在于部署环境，应调用固定的 `npm run daily`，而不是未登记的脚本或任意 shell 命令。

## 2. 应用与数据库命令

| 命令 | 入口 | 用途 |
|---|---|---|
| `npm run dev` | Next development server | 本地 Dashboard/API 开发 |
| `npm run build` | Next build | 生产构建 |
| `npm run start` | Next production server | 启动已构建应用 |
| `npm run lint` | ESLint | 静态 lint |
| `npm run typecheck` | TypeScript | 类型检查 |
| `npm run db:generate` | Drizzle Kit | 从 schema 生成 migration |
| `npm run db:check` | Drizzle Kit | 检查 migration 一致性 |
| `npm run db:migrate` | Drizzle Kit | 应用 migration |
| `npm run db:seed` | `scripts/import-sources.ts` | 代码试图读取 `docs/08-source-list.md` 后同步 `sources`；会写库 |

## 3. Production Processing 命令

### 3.1 完整 workflow

```bash
npm run daily
npm run daily -- --date=2026-09-14
DAILY_DATE=2026-09-14 npm run daily
```

`daily` 依次启动固定的 collection、exact duplicate filter、content completion 与 Stage 1–4 CLI。完整 workflow 需要相应数据库、Provider 与 Firecrawl 配置。日期和各步骤行为见 [Workflow Overview](02-workflow-overview.md)。

### 3.2 独立步骤

| 命令 | 入口 | 指定目标 Daily |
|---|---|---|
| `npm run collect:rss` | `scripts/collect-rss.ts` | 不支持 |
| `npm run dedupe:stage1` | `scripts/dedupe-stage1.ts` | `DAILY_DATE=...`，并须提供 Daily published scope 环境变量 |
| `npm run complete:content` | `scripts/complete-content.ts` | `DAILY_DATE=...` |
| `npm run process:stage1` | `scripts/process-stage1.ts` | `DAILY_DATE=...` |
| `npm run process:stage2` | `scripts/process-stage2.ts` | `DAILY_DATE=...` |
| `npm run process:stage3` | `scripts/process-stage3.ts` | `DAILY_DATE=...` |
| `npm run process:stage4` | `scripts/process-stage4.ts` | `DAILY_DATE=...` |

独立 Stage2、Stage3、Stage4 可从数据库读取其业务输入；`STAGE2_STAGE1_RUN_DIR`、`STAGE3_STAGE2_RUN_DIR`、`STAGE4_STAGE3_RUN_DIR` 只供 lineage/observability 使用。Dashboard 的 Per-Step Retry 也通过这些固定 CLI 启动，并设置 `PIPELINE_TRIGGER_SOURCE=dashboard`；不要手工设置该变量伪造来源。

`dedupe:stage1` 的 published scope 通常由 `daily` 或 Dashboard Retry 注入。若手工执行，必须同时提供成对的 `DAILY_PUBLISHED_SCOPE_START_AT`、`DAILY_PUBLISHED_SCOPE_END_AT`（旧 alias 见 §5.2）。不要把 runtime pointer/lineage 变量作为正常人工输入。

## 4. Model Evaluation

Model Evaluation 是人工、隔离的操作，不属于 `daily` 或 scheduler。

```bash
npm run eval:stage1 -- --date=2026-09-14
npm run eval:stage2 -- --date=2026-09-14 --provider=deepseek
npm run eval:stage3:event -- --date=2026-09-14 --provider=kimi --model=kimi-k3
npm run eval:stage3:digest -- --input-id=UUID
npm run eval:stage3:long-form -- --run-id=UUID
```

各 `eval:*` script 已固定 `--stage`。共享 CLI `scripts/run-model-evaluation.ts` 支持：

| 参数 | 要求 |
|---|---|
| `--stage=stage1\|stage2\|stage3_event\|stage3_digest\|stage3_long_form` | 必填；npm wrapper 已提供 |
| `--date=YYYY-MM-DD` | 与 `--input-id`、`--run-id` 三选一 |
| `--input-id=UUID` | 恢复该 Evaluation input |
| `--run-id=UUID` | 恢复该 Evaluation run |
| `--provider=openai\|deepseek\|kimi\|codex` | 可选；不传时取 `EVALUATION_PROVIDERS` 或代码默认值 |
| `--model=MODEL` | 可选；仅可与单一 `--provider` 一起使用 |

需要 `DATABASE_URL`。详情与隔离原则见 [Technical Spec](04-technical-spec.md)。

## 5. 环境变量

### 5.1 基础、Provider 与应用

| 变量 | 用于 | 默认 / 说明 |
|---|---|---|
| `DATABASE_URL` | 所有数据库 CLI、API 与 Evaluation | 数据库命令及 processing 必填 |
| `DATABASE_SSL` | PostgreSQL 连接 | 仅值为 `true` 时启用 SSL（不校验证书） |
| `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `KIMI_API_KEY` / `MOONSHOT_API_KEY` / `CODEX_API_KEY` | 对应 LLM Provider | 所选 Provider 必需；Kimi 接受任一 Kimi/Moonshot key |
| `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL` / `KIMI_BASE_URL` / `CODEX_BASE_URL` | 对应 Provider endpoint | 未设置使用 `llm-client.ts` 的 provider 默认值 |
| `OPENAI_MODEL` / `DEEPSEEK_MODEL` / `KIMI_MODEL` / `CODEX_MODEL` | 对应 Provider model | 未设置使用 `llm-client.ts` 的 provider 默认值 |
| `LLM_PROVIDER` | generic LLM client / provider diagnostics | 默认 `openai` |
| `LLM_MODEL` | generic LLM model override | 覆盖 Provider model 解析 |
| `STAGE1_LLM_PROVIDER` / `STAGE2_LLM_PROVIDER` / `STAGE3_LLM_PROVIDER` / `STAGE4_LLM_PROVIDER` | 对应正式 Stage 的 Provider | 默认依次为 `openai`、`deepseek`、`openai`、`openai` |
| `LLM_DEBUG_HTTP` | LLM 请求诊断日志 | 仅 `true` 启用；输出经过脱敏的 HTTP 诊断 |
| `BRIEF_API_ALLOWED_ORIGIN` | Brief / read-more API 的 CORS allowlist | 逗号分隔 origin；空值不配置额外 allowlist |
| `READ_MORE_LLM_TIMEOUT_MS` | read-more API LLM timeout | 默认 `120000` ms |

### 5.2 Daily 与内部编排变量

| 变量 | 用于 | 操作说明 |
|---|---|---|
| `DAILY_DATE` | `daily` 与独立 processing CLI | `YYYY-MM-DD`；`daily` 也支持 `--date=...` |
| `DAILY_PUBLISHED_SCOPE_START_AT` / `DAILY_PUBLISHED_SCOPE_END_AT` | Daily 下游步骤与手工 duplicate filter | 必须成对；由编排器传递的 published scope |
| `DAILY_SCOPE_START_AT` / `DAILY_SCOPE_END_AT` | 旧部署兼容 alias | 必须成对；不要与新变量混用 |
| `DAILY_CATCHUP_SCOPE_START_AT` / `DAILY_CATCHUP_SCOPE_END_AT` | Content Completion / Stage1 编排输入 | 必须成对；由编排器或 Retry 注入 |
| `DAILY_STAGE_RUN_POINTER` | Daily runtime artifact 关联 | 编排内部使用，不作为手工操作参数 |
| `STAGE2_STAGE1_RUN_DIR` / `STAGE3_STAGE2_RUN_DIR` / `STAGE4_STAGE3_RUN_DIR` | runtime lineage | 可选 observability 信息，不是 Stage2–4 的业务输入 |
| `PIPELINE_TRIGGER_SOURCE` | `pipeline_runs` trigger attribution | internal；正常来源由 Daily/Dashboard 写入，不手工设置 |

Scope 的时间含义和 current/historical 行为在 [Workflow Overview](02-workflow-overview.md) 定义，不在本文件复述。

### 5.3 Collection 与 Content Completion

| 变量 | 默认值 | 用于 |
|---|---:|---|
| `RSS_COLLECTOR_CONCURRENCY` | `4` | RSS collection 并发 |
| `RSS_FETCH_TIMEOUT_MS` | `20000` ms | RSS fetch timeout |
| `FIRECRAWL_API_KEY` | — | Content Completion 及 Firecrawl diagnostic 必填 |
| `CONTENT_COMPLETION_SOURCE_NAMES` | 全部 source | 逗号分隔 source name filter |
| `CONTENT_COMPLETION_LIMIT` | `50` | Content Completion 最大处理数 |
| `CONTENT_COMPLETION_PER_SOURCE_LIMIT` | `10` | 每个 source 最大处理数 |
| `CONTENT_COMPLETION_CONCURRENCY` | `2` | Content Completion 并发 |
| `CONTENT_COMPLETION_SHORT_CHARS` | `80` | Completion 候选正文长度阈值；Dashboard 也读取此值显示阈值 |
| `CONTENT_COMPLETION_FIRECRAWL_TIMEOUT_MS` | `30000` ms | 单次 Firecrawl timeout |
| `CONTENT_COMPLETION_FIRECRAWL_MAX_RETRIES` | `2` | 单次 Firecrawl 最大重试数 |

### 5.4 Stage 执行与 LLM 调用

| 变量 | 默认值 | 用于 |
|---|---:|---|
| `STAGE1_LIMIT` | 不设置时不额外限制 | Stage1 最大候选数 |
| `STAGE1_CONCURRENCY` | `3` | Stage1 并发 |
| `STAGE1_PUBLISHED_WITHIN_HOURS` | `24` | Stage1 lookback；`STAGE1_COLLECTED_WITHIN_HOURS` 是兼容 alias |
| `STAGE1_BATCH_SIZE` | `15` | Stage1 micro-batch 最大文章数 |
| `STAGE1_BATCH_MAX_CONTENT_CHARS` | `20000` | Stage1 单篇内容字符上限 |
| `STAGE1_BATCH_MAX_TOTAL_CHARS` | `60000` | Stage1 单 batch 总字符上限 |
| `STAGE1_LLM_TIMEOUT_MS` | `45000` ms | Stage1 单 request timeout |
| `STAGE1_LLM_MAX_RETRIES` | `2` | Stage1 最大重试数 |
| `STAGE1_LLM_RETRY_DELAY_MS` | `1000` ms | Stage1 通用 retry delay |
| `STAGE2_LLM_TIMEOUT_MS` | `240000` ms | Stage2 单 request timeout |
| `STAGE2_LLM_MAX_RETRIES` | `0` | Stage2 最大重试数 |
| `STAGE2_LLM_RETRY_DELAY_MS` | `1000` ms | Stage2 retry delay |
| `STAGE2_LLM_MAX_OUTPUT_TOKENS` | `64000` | Stage2 最大输出 token |
| `STAGE3_LLM_TIMEOUT_MS` | `240000` ms | Stage3 Event/Digest/Long-form 单 request timeout |
| `STAGE3_LLM_MAX_RETRIES` | `2` | Stage3 Event/Digest/Long-form 最大重试数 |
| `STAGE3_LLM_RETRY_DELAY_MS` | `1000` ms | Stage3 Event/Digest/Long-form retry delay |
| `STAGE4_LLM_TIMEOUT_MS` | `240000` ms | Stage4 单 request timeout |
| `STAGE4_LLM_MAX_RETRIES` | `2` | Stage4 transient-error 最大重试数 |
| `STAGE4_LLM_RETRY_DELAY_MS` | `1000` ms | Stage4 retry delay |

### 5.5 Evaluation 与诊断

| 变量 | 默认值 | 用于 |
|---|---:|---|
| `EVALUATION_PROVIDERS` | `deepseek,kimi` | 未提供 `--provider` 时的 Evaluation provider 列表 |
| `TEST_LLM_TIMEOUT_MS` | `30000` ms | `test-openai-call.ts` 全 Provider timeout |
| `TEST_<PROVIDER>_TIMEOUT_MS` | — | 覆盖某 Provider 的 smoke-test timeout，例如 `TEST_OPENAI_TIMEOUT_MS` |

## 6. Regression Tests

Regression tests validate stable correctness contracts; they are not Production pipeline commands. The complete executable inventory is `package.json`'s `scripts`, which is the source of truth.

Representative long-lived checks:

```bash
npm run test:daily-scope
npm run test:pre-stage1-duplicates
npm run test:stage3-persistence
npm run test:stage4-event-date
npm run test:stage4-persistence
npm run test:ranking-review
npm run test:model-evaluation
npm run test:content-completion-runtime
```

## 7. Reusable Diagnostics and Smoke Tests

这些命令可能调用真实外部服务、读取真实数据库或写入本地 `runtime/`；不要把它们当作无副作用 regression tests。

| 命令 | 参数 / 前提 | 实际用途 |
|---|---|---|
| `npm run test:openai` | optional positional API mode | OpenAI structured response smoke test |
| `npm run test:openai:chat` | 无额外参数 | OpenAI Chat Completions smoke test |
| `npm run test:openai:chat:structured` | 无额外参数 | OpenAI structured Chat Completions smoke test |
| `npm run test:deepseek` | 无额外参数 | DeepSeek structured response smoke test |
| `npm run test:kimi` | 无额外参数 | Kimi structured response smoke test |
| `npm run test:firecrawl-content -- --date=YYYY-MM-DD [--limit=N] [--per-source=N] [--concurrency=N]` | `DATABASE_URL`、`FIRECRAWL_API_KEY` | 独立 Firecrawl diagnostic；会写 local runtime artifact，不写业务数据库 |

`scripts/test-openai-call.ts` 的 positional API mode 支持 `responses`（默认）、`chat-completions`、`chat-completions-structured`。`test:openai*` wrapper 已固定 provider；调用其它 provider 时使用 `npx tsx scripts/test-openai-call.ts PROVIDER [MODE]`。

## 8. `scripts/` 文件分类

| 文件 | 分类 | package script / 操作入口 |
|---|---|---|
| `run-daily-workflow.ts` | Production / operational command | `daily` |
| `run-model-evaluation.ts` | Production / operational command (manual Evaluation) | `eval:*` |
| `test-codex-call.ts` | One-off / obsolete diagnostic | 无 |
| `test-content-completion-runtime.ts` | Regression test | `test:content-completion-runtime` |
| `test-daily-scope.ts` | Regression test | `test:daily-scope` |
| `test-daily-workflow-retry.ts` | Regression test | `test:daily-workflow-retry` |
| `test-dashboard-daily-scope.ts` | Regression test | `test:dashboard-daily-scope` |
| `test-dashboard-step-retry.ts` | Regression test | `test:dashboard-step-retry` |
| `test-event-review-finalization.ts` | Regression test | `test:event-review-finalization` |
| `test-firecrawl-content-extraction.ts` | Regression test | `test:firecrawl-content-extraction` |
| `test-firecrawl-content.ts` | Reusable diagnostic | `test:firecrawl-content` |
| `test-model-evaluation-background.ts` | Regression test | `test:model-evaluation-background` |
| `test-model-evaluation-cancel.ts` | Regression test | `test:model-evaluation-cancel` |
| `test-model-evaluation-review.ts` | Regression test | `test:model-evaluation-review` |
| `test-model-evaluation.ts` | Regression test | `test:model-evaluation` |
| `test-openai-call.ts` | Reusable diagnostic | `test:openai*`、`test:deepseek`、`test:kimi` |
| `test-pipeline-run-log.ts` | Regression test | `test:pipeline-run-log` |
| `test-pre-stage1-duplicates.ts` | Regression test | `test:pre-stage1-duplicates` |
| `test-ranking-review.ts` | Regression test | `test:ranking-review` |
| `test-stage1-chat-structured.ts` | Reusable diagnostic | `test:stage1:chat`；真实 DB/LLM 调用 |
| `test-stage1-persistence.ts` | Regression test | `test:stage1-persistence` |
| `test-stage2-standalone.ts` | Regression test | `test:stage2-standalone` |
| `test-stage3-persistence-rules.ts` | Regression test | `test:stage3-persistence` |
| `test-stage4-event-date.ts` | Regression test | `test:stage4-event-date` |
| `test-stage4-fail-fast.ts` | Regression test | `test:stage4-fail-fast` |
| `test-stage4-persistence.ts` | Regression test | `test:stage4-persistence`（DB） |

## 9. Runtime Artifact 操作注意事项

`runtime/` 是本地 execution diagnostic artifact，不是跨机器业务真相。仅在本文件登记的 diagnostic/recovery command 会直接读取历史 runtime
