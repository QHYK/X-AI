# Operations

本文档是 X-AI-field 所有**操作入口**的唯一 Source of Truth：命令、CLI 参数、环境变量、测试、诊断、回填与人工恢复程序均以这里为准。

它不定义 Daily scope、阶段资格、排序、持久化/幂等性、AI 判断、Prompt 或数据模型。需要理解这些语义时，分别链接至 [Workflow Overview](02-workflow-overview.md)、[Technical Spec](04-technical-spec.md)、[Prompt Spec](07-prompt-spec.md) 与 [Data Model](05-data-model.md)。

Pipeline CLI 在读取环境派生参数或执行处理模块前，统一通过 `loadPipelineEnvironment` 加载配置。配置优先级：Shell > .env.local > .env > 默认值；不要提交凭据。Daily 与 Dashboard Retry 启动的子进程继承父进程已解析的环境，子 CLI 重复 bootstrap 时会保留这些继承值。Next.js 的 API/Dashboard 保持 Next.js 自身的环境变量加载机制。

可运行 `npm run test:pipeline-env` 验证非敏感的 Pipeline 配置在 ESM 模块已导入后仍会于调用时正确解析。

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

仓库通过 GitHub Actions 手动 Build / Deploy；没有 Docker、Procfile 或内置 scheduler。服务器 Cron 继续使用既有 Daily / Discovery 命令，部署 Workflow 不修改 Cron。

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

### 2.1 手动构建与部署

GitHub Actions 的 **Build X-AI** 可单独手动运行；**Deploy X-AI** 仅通过 `workflow_dispatch` 手动触发，不在 push 时自动部署。在 Actions 页面选择要部署的 branch/tag 后运行 Deploy，Workflow 固定本次的 Commit SHA，复用 Build X-AI 的 Node 22 / `npm ci` / `npm run build` 配置。Runner 上传经过 SHA-256 校验的 `.next` 构建包、manifest 和目标 `package.json` / `package-lock.json`；服务器不执行 Build。需要已有 Repository Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`，无需上传服务器 `.env.local` 或新增业务密钥。

首次部署前，在服务器人工核实：

```bash
cd /home/ubuntu/X-AI
node -v
uname -m
git status --short
git rev-parse HEAD
test -f .env.local
test -s .next/BUILD_ID && test -d .next/server && test -d .next/static || echo 'No complete old build: automatic rollback will not be available'
test -d runtime
test -d node_modules || echo 'node_modules missing: deployment will install it before switching'
sudo -n systemctl is-active x-ai-field || echo 'Old service is inactive'
curl --fail --max-time 10 http://127.0.0.1:5260/ai/in-depth >/dev/null || echo 'Old HTTP route is unavailable'
```

服务器 Git `origin` 须能取得本次固定 Commit；工作区须无本地改动或未跟踪文件，当前 Commit 必须是目标 Commit 的祖先。Ubuntu 服务器的架构、Node ABI、glibc 须与 Runner 产物兼容。部署前请安排不会与 Cron Pipeline 重叠的窗口；Workflow 会检查现有进程并在切换前再次检查，但在不修改 Cron 配置的条件下，无法消除检查后新任务启动的竞态。

上传暂存于 `/home/ubuntu/.x-ai-deploy/<commit>-<run>-<attempt>/`，不会覆盖 `.env.local`、`runtime/`、`logs/` 或 `.git/`。只有部署 Commit 与服务器当前 Commit 的 `package-lock.json` 不同，或 `node_modules` 缺失时，才在独立暂存目录执行服务器 `npm ci`；无法确认已有依赖状态则停止。验证完毕后短暂停止 `x-ai-field`，fast-forward 更新源码、替换整目录 `.next` 与必要的 `node_modules`，重启并检查 systemd 状态及 `/ai/in-depth`。旧 `.next`、旧依赖与 Commit 信息保留在暂存目录，供人工诊断和恢复；清理历史暂存目录前应先确认当前版本稳定。

旧构建完整时，切换后失败会尝试恢复原分支及 Commit、旧 `.next`、`node_modules` 并重新验证服务。旧构建不完整或不存在时仍可部署，但没有自动回滚：激活失败会保留当前源码、`.next`、依赖及暂存目录现场，并提示人工恢复，不会声称旧服务已恢复。无法安全恢复分支时会明确报错；按 Action 输出的暂存目录人工处理，不要仅恢复 `.next`。当前服务器 `ubuntu` 用户具有广泛免密 sudo 权限，这是现有部署账户的安全风险，建议后续收窄为服务管理所需命令。

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
| `DISCOVERY_LLM_PROVIDER` | Discovery D2 / D4 shared Provider | 覆盖既有 `LLM_PROVIDER`；模型、Base URL 与 API Key 均由该 Provider 的既有配置解析 |
| `DISCOVERY_D2_PROVIDER` / `DISCOVERY_D4_PROVIDER` | Discovery D2 / D4 stage Provider | 优先级最高；覆盖 `DISCOVERY_LLM_PROVIDER` |
| `DISCOVERY_LLM_TIMEOUT_MS` | Discovery D2 / D4 shared request timeout | 正整数毫秒；被对应 stage timeout 覆盖；未设置则使用共享 LLM Client 的 SDK 默认值 |
| `DISCOVERY_D2_TIMEOUT_MS` / `DISCOVERY_D4_TIMEOUT_MS` | Discovery D2 / D4 stage request timeout | 正整数毫秒；优先级最高；未设置时回退至 `DISCOVERY_LLM_TIMEOUT_MS`，再回退 SDK 默认值 |
| `DISCOVERY_AGENT_MODEL` | Discovery D3 / D5 Agents SDK model | 回退至 `CODEX_MODEL`，再回退代码默认 `gpt-5.6-terra`；D3 / D5 固定使用 Codex Responses endpoint |
| `DISCOVERY_D3_TIMEOUT_MS` / `DISCOVERY_D5_TIMEOUT_MS` | 对应 Agent Run 整体 timeout | 默认 `480000` ms；D5 未设置时回退 D3 值 |
| `DISCOVERY_D3_MAX_TURNS` / `DISCOVERY_D5_MAX_TURNS` | 对应 Agent 最大轮数 | 默认 `8`；D5 未设置时回退 D3 值 |
| `DISCOVERY_FETCH_CONTENT_TIMEOUT_MS` | D3 / D5 `fetch_content` 单次工具 timeout | 默认 `90000` ms |
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
| `FIRECRAWL_API_KEY` | — | Content Completion pool A 必填；Firecrawl diagnostic 使用此 Key |
| `FIRECRAWL_API_KEY_2` | — | Content Completion pool B 必填；缺失时有候选的 Completion 会在发起请求前失败 |
| `CONTENT_COMPLETION_SOURCE_NAMES` | 全部 source | 逗号分隔 source name filter |
| `CONTENT_COMPLETION_LIMIT` | `80` | Content Completion 最大处理数；显式设置可降低此值，但不能超过 80 |
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

Stage2 关闭 SDK 自动重试，使用自己的 retry loop；`STAGE2_LLM_MAX_RETRIES` 是单次 Stage2 execution 中额外 LLM request 的最大次数。每次 attempt 的脱敏诊断写入 `runtime/stage2/<run-id>/run.json` 的 `llm_attempts`；Dashboard 的 Retries 表示实际 LLM retry 数，不包含整个 Stage2 的再次运行。
| `STAGE3_LLM_TIMEOUT_MS` | `240000` ms | Stage3 Event/Digest/Long-form 单 request timeout |
| `STAGE3_LLM_MAX_RETRIES` | `2` | Stage3 Event/Digest/Long-form 最大重试数 |
| `STAGE3_LLM_RETRY_DELAY_MS` | `1000` ms | Stage3 Event/Digest/Long-form retry delay |

Stage 1 的逻辑 Batch 1–15 使用已有 Codex 配置；Codex retry 耗尽后回退当前 `STAGE1_LLM_PROVIDER`（未设置时使用项目默认）。每个 Batch 的实际 provider、retry、fallback 与脱敏错误见 `runtime/stage1/<run-id>/attempts.jsonl`。
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
npm run test:stage1-codex-rollout
npm run test:read-more-cache
npm run test:brief-read-more-availability
npm run test:stage3-persistence
npm run test:stage4-event-date
npm run test:stage4-persistence
npm run test:ranking-review
npm run test:model-evaluation
npm run test:content-completion-runtime
npm run test:content-completion-pools
npm run test:stage2-retry
npm run test:daily-llm-usage
npm run test:pipeline-env
npm run test:discovery-phase1
npm run test:discovery-phase2
npm run test:discovery-phase3
npm run test:discovery-orchestrator
npm run test:discovery-d5
```

### Discovery D2–D5 Workflow

```bash
npm run discovery -- --dates=YYYY-MM-DD,YYYY-MM-DD --confirm-paid
npm run discovery -- --run-id=UUID --confirm-paid
npm run discovery -- --open-parent-run-id=UUID --open-context="可选人工补充方向" --confirm-paid
```

第一个命令创建新的常规 Discovery Run；第二个命令恢复已有 Run；第三个命令创建关联原 Regular Run 的独立人工 Open Run。该入口会调用真实 Provider、D3/D5 Web Search 与 Firecrawl，必须显式 `--confirm-paid`。常规 Run 在 D3、D4 都完成且没有合格候选时自动执行 D5；人工 Open 只执行 D5，不重跑 D2–D4。终端报告输出 Run / Parent Run ID、阶段状态、Usage、缓存命中率和候选/审核数量。

In-depth 人工审核入口为 `/review/in-depth`，审核 API 为 `/api/review/in-depth`，公开列表为 `/in-depth`。当前 Next.js `basePath=/ai`，实际浏览器路径分别为 `/ai/review/in-depth`、`/ai/api/review/in-depth`、`/ai/in-depth`。`npm run dev` 的开发环境可直接访问审核页，不需要独立密码；生产环境尚无统一后台认证，因此审核页和 API（包括读写）均拒绝访问，不会因客户端隐藏按钮而开放。接入可靠的后台认证前不可用于生产审核。公开列表不受此限制。相关状态语义见 [Discovery Workflow](06a-discovery-workflow.md) 和 [Data Model](05-data-model.md)。本地回归：`npm run test:in-depth-review`。

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
| `npm run test:discovery-provider -- --confirm-paid [--dates=YYYY-MM-DD,YYYY-MM-DD]` | `DATABASE_URL` 及当前 LLM Provider 配置；需显式确认付费调用 | 手动执行真实 D2 → D4 集成验证；默认选择最近两期有 `daily/success` 或 `stage4/success` 的 Daily，创建新的 Regular Discovery Run，并写入 Discovery 表 |
| `npm run test:discovery-provider -- --confirm-paid --run-id=UUID` | D2 完成以已有 `selection_output` 为准；当前命令同时要求 Run 为 `partial` / `failed` | 只恢复该 Run 的 D4；复用原 Run ID、持久化 Leads 与 Candidate，不重新调用 D2，不覆盖已完成评价 |
| `npm run test:discovery-d3 -- --confirm-paid --run-id=UUID` | 已有持久化 D2 Topic Leads；需要 `DATABASE_URL`、Codex 与 Firecrawl 配置 | 对指定 Run 执行或恢复 D3；一个 Agent Run 接收全部 Topic Leads。真实付费调用，必须显式确认 |

`scripts/test-openai-call.ts` 的 positional API mode 支持 `responses`（默认）、`chat-completions`、`chat-completions-structured`。`test:openai*` wrapper 已固定 provider；调用其它 provider 时使用 `npx tsx scripts/test-openai-call.ts PROVIDER [MODE]`。

Discovery Provider 集成验证不会由 regression tests 自动执行。命令复用 Phase 1 Run Service 以及正式 D2 / D4 函数；输出 Run ID、全部 Direct / Topic Leads（含来源内容与 Direct URL）、逐篇 D4 评价、审核队列状态、Token Usage 与耗时。D4 每篇 Direct Candidate 串行发起一次 LLM 请求；每篇成功后立即持久化，单篇失败会记录诊断并继续后续 Candidate。输出会单列成功/失败请求数、各自累计耗时、已知 Token Usage 和 Usage 是否完整。`selection_output` 和 Candidate 均保留在数据库中，后续阶段可直接使用输出的 Run ID。失败时保留 Run、已创建 Candidate 和 diagnostics。指定 `--dates` 时日期必须升序，且每一期都必须存在同一 `daily_date` 的 `pipeline_runs.step IN ('daily', 'stage4') AND status = 'success'`；`--dates` 与 `--run-id` 不可同时使用。

Discovery 阶段级执行诊断保存在 `discovery_runs.execution_state`：D2–D5 都记录实际执行状态、结束原因、Provider / Model / API mode、累计耗时与模型 Usage。Usage 的 `cachedInputTokens` 已包含在 `inputTokens` 中，不能重复加入总 Token。若任一请求没有完整 Usage，`usageComplete` 为 `false`，缓存命中率不应作为完整统计显示；读取端可在完整时按 `cachedInputTokens / inputTokens` 计算。Resume 会累计该 Run 已记录的阶段 Usage；历史 Run 缺失此诊断时保持未知，不从 Candidate 或 Trace 反推。

Discovery D2 / D4 的 Structured Output 通过共享 LLM Client 走 Chat Completions；测试输出会显示实际 Provider、model、timeout、API mode 与 LLM request 耗时。`DISCOVERY_D2_PROVIDER` / `DISCOVERY_D4_PROVIDER` 优先于 `DISCOVERY_LLM_PROVIDER`，随后才使用既有 `LLM_PROVIDER`；模型、Base URL 与 API Key 始终由选定 Provider 的既有配置解析，其中模型使用该 Provider 的专属 `*_MODEL` 配置。`DISCOVERY_D2_TIMEOUT_MS` / `DISCOVERY_D4_TIMEOUT_MS` 优先于 `DISCOVERY_LLM_TIMEOUT_MS`；全部未设置时请求选项会省略 timeout，使用 SDK 默认值，并输出 `SDK default`。

Discovery Run 的正式恢复边界见 `06a-discovery-workflow.md` §8.3。操作时：没有持久化 `selection_output` 的失败 Run 不使用 `--run-id`，而是创建 New Run 并从 D2 开始；已有 `selection_output` 时，D3 / D4 Resume 复用原 Run。D3 读取 `execution_state.d3`：`completed` 直接跳过，失败、缺失或遗留 `running` 会重新执行整个 Agent Run；D4 复用同一 Candidate ID，仅评价仍为 `discovered` 的 Candidate。主动重新生成应创建 New Run。

## 8. `scripts/` 文件分类

| 文件 | 分类 | package script / 操作入口 |
|---|---|---|
| `run-daily-workflow.ts` | Production / operational command | `daily` |
| `run-model-evaluation.ts` | Production / operational command (manual Evaluation) | `eval:*` |
| `test-codex-call.ts` | One-off / obsolete diagnostic | 无 |
| `test-content-completion-runtime.ts` | Regression test | `test:content-completion-runtime` |
| `test-daily-scope.ts` | Regression test | `test:daily-scope` |
| `test-daily-workflow-retry.ts` | Regression test | `test:daily-workflow-retry` |
| `test-discovery-provider.ts` | Reusable diagnostic | `test:discovery-provider`；真实 DB/LLM 调用并写 Discovery 表 |
| `test-discovery-d3.ts` | Reusable diagnostic | `test:discovery-d3`；按已有 Run ID 真实执行 D3，需显式确认付费调用 |
| `test-discovery-phase3.ts` | Regression test | `test:discovery-phase3`；D3 Mock Agent、验证、持久化、Resume 与 Trace |
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
| `test-stage1-codex-rollout.ts` | Regression test | `test:stage1-codex-rollout` |
| `test-stage1-persistence.ts` | Regression test | `test:stage1-persistence` |
| `test-read-more-cache.ts` | Regression test | `test:read-more-cache` |
| `test-brief-read-more-availability.ts` | Regression test | `test:brief-read-more-availability` |
| `test-stage2-standalone.ts` | Regression test | `test:stage2-standalone` |
| `test-stage3-persistence-rules.ts` | Regression test | `test:stage3-persistence` |
| `test-stage4-event-date.ts` | Regression test | `test:stage4-event-date` |
| `test-stage4-fail-fast.ts` | Regression test | `test:stage4-fail-fast` |
| `test-stage4-persistence.ts` | Regression test | `test:stage4-persistence`（DB） |

## 9. Runtime Artifact 操作注意事项

`runtime/` 是本地 execution diagnostic artifact，不是跨机器业务真相。仅在本文件登记的 diagnostic/recovery command 会直接读取历史 runtime
