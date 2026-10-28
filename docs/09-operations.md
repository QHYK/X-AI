# Operations

本文档是 X-AI-field 所有**操作入口**的唯一 Source of Truth：命令、CLI 参数、环境变量、测试、诊断、回填与人工恢复程序均以这里为准。

它不定义 Daily scope、阶段资格、排序、持久化/幂等性、AI 判断、Prompt 或数据模型。需要理解这些语义时，分别链接至 [Workflow Overview](02-workflow-overview.md)、[Technical Spec](04-technical-spec/architecture.md)、[Prompt Spec](07-prompt-spec/daily.md) 与 [Data Model](05-data-model/README.md)。

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
| `npm run db:seed` | `scripts/import-sources.ts` | 解析 `docs/08-source-list.md` 的 CSV，按 name + collection_method 更新或新增 `sources`，禁用列表中缺失的来源；事务写库 |
| `npm run admin:hash-password` | `scripts/hash-admin-password.ts` | 隐藏输入管理员密码并输出 scrypt hash；将输出配置为服务端 `ADMIN_PASSWORD_HASH` |

### 2.1 管理员登录配置

启动后台前，在服务端 `.env.local` 配置 `ADMIN_PASSWORD_HASH` 和 `ADMIN_COOKIE_SECURE`。密码至少 8 字符；运行 `npm run admin:hash-password` 时交互输入，复制输出的 hash，不要把明文密码写入仓库或命令参数。Next.js API/Dashboard 按 Next.js 规则加载环境变量；配置缺失或格式错误时后台拒绝访问。更换 hash 会使旧 Session 失效。

反向代理须保留浏览器请求的 Host，并让 Next.js 获得正确的外部请求协议；管理写入请求的 Origin 与该 Host / 协议比较，不使用客户端提供的 `X-Forwarded-Host` 作为白名单。

当前公网 HTTP 部署须设置 `ADMIN_COOKIE_SECURE=false` 才能登录。HTTP 无法保护密码和 Cookie 的传输机密性。启用 HTTPS 后，将外部登录流量转为 HTTPS，并设置 `ADMIN_COOKIE_SECURE=true`；Session Cookie 的 Path 固定为当前 `basePath=/ai`。会话有效期为 12 小时，退出会删除服务端记录。默认会话目录位于系统临时目录，按工作目录区分部署；临时目录被清理后用户需重新登录。生产部署可通过 `ADMIN_SESSION_DIR` 指定仅服务账户可访问的持久目录，该目录不属于 Pipeline `runtime/`。登录端点有每进程每分钟 10 次的基础限流，不依赖可伪造的转发 IP 头；多实例部署需要共享 Session 存储和统一限流后才能作为同一登录域使用。

### 2.2 手动构建与部署

GitHub Actions 的 **Build X-AI** 可单独手动运行；**Deploy X-AI** 仅通过 `workflow_dispatch` 手动触发。复用 Build X-AI 的 Node 22 / `npm ci` / `npm run build` 配置。Runner 上传经过 SHA-256 校验的 `.next` 构建包、manifest 和目标 `package.json` / `package-lock.json`；服务器不执行 Build。需要已有 Repository Secrets：`DEPLOY_HOST`、`DEPLOY_USER`、`DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`，无需上传服务器 `.env.local` 或新增业务密钥。

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
curl --fail --max-time 10 http://127.0.0.1:5260/ai >/dev/null || echo 'Old HTTP route is unavailable'
```

服务器 Git `origin` 须能取得本次固定 Commit；工作区须无本地改动或未跟踪文件，当前 Commit 必须是目标 Commit 的祖先。Ubuntu 服务器的架构、Node ABI、glibc 须与 Runner 产物兼容。部署前请安排不会与 Cron Pipeline 重叠的窗口；Workflow 会检查现有进程并在切换前再次检查，但在不修改 Cron 配置的条件下，无法消除检查后新任务启动的竞态。

上传暂存于 `/home/ubuntu/.x-ai-deploy/<commit>-<run>-<attempt>/`，不会覆盖 `.env.local`、`runtime/`、`logs/` 或 `.git/`。只有部署 Commit 与服务器当前 Commit 的 `package-lock.json` 不同，或 `node_modules` 缺失时，才在独立暂存目录执行服务器 `npm ci`；无法确认已有依赖状态则停止。验证完毕后，脚本复用 Discovery 既有执行锁并确认没有 running Run，在锁内停止空闲的 `x-ai-discovery-worker`，再停止 `x-ai-field`；有实际任务、锁占用或数据库不可验证时拒绝停止服务。随后 fast-forward 更新源码、替换整目录 `.next` 与必要的 `node_modules`，启动两个固定服务，确认均为 active，并检查 Web `/ai` HTTP 健康状态。回滚同样安全停止 Worker、恢复旧代码 / 构建 / 依赖并启动及检查两个服务；若回滚时已有 Discovery 任务，则保留现场并要求人工恢复，不强行中断付费任务。旧 `.next`、旧依赖与 Commit 信息保留在暂存目录，供人工诊断和恢复；清理历史暂存目录前应先确认当前版本稳定。本地回归命令为 `node scripts/deploy/test.mjs`，使用数据库与 systemd 替身，不执行真实部署。

旧构建完整时，切换后失败会尝试恢复原分支及 Commit、旧 `.next`、`node_modules` 并重新验证服务。旧构建不完整或不存在时仍可部署，但没有自动回滚：激活失败会保留当前源码、`.next`、依赖及暂存目录现场，并提示人工恢复，不会声称旧服务已恢复。无法安全恢复分支时会明确报错；按 Action 输出的暂存目录人工处理，不要仅恢复 `.next`。当前服务器 `ubuntu` 用户具有广泛免密 sudo 权限，这是现有部署账户的安全风险，建议后续收窄为服务管理所需命令。

### 2.3 Prompt 基线导入与生产接入

先提交并部署经过验收的基线源码，`npm run db:migrate` 应用 `0021_prompt_registry.sql`（两表及保护 Trigger）及 `0022_stage4_prompt_versions.sql`（Stage4 映射列）。在启动新 Web / Worker / CLI 前完成导入；尚无 Active 的请求会明确失败。随后可运行：

```bash
npm run prompts:import -- --dry-run
npm run prompts:import
npm run test:prompt-registry
npm run test:prompt-runtime
npm run test:system-prompt-layers
npm run test:prompt-requests
npm run test:prompt-management
```

Dry-run 只读当前 Git / 冻结 Seed 数据，输出 18 项 key、拟导入的 `vN` 编号、来源和 Hash，不连接数据库。测试默认使用 Mock；若显式提供 `PROMPT_REGISTRY_TEST_DATABASE_URL`（独立测试数据库），同一测试还会创建隔离 Schema 并在事务结束时回滚全部 DDL / 数据，用于验证真实 PostgreSQL 约束。不要填生产连接。正式导入使用现有环境加载顺序与 DATABASE_URL，单事务导入 3 个 Fragment 和 15 个 Request；已有任意版本的 Registry 全部跳过，不覆盖人工 Draft / Published / Active。正式导入要求 `production-seeds.ts` 和 `seed-baseline.json` 已提交且无未提交修改，否则拒绝标注不真实的来源 Commit；未提交时 dry-run 允许预览，但会明确警告，不能作为已提交来源验收。无新环境变量、依赖或付费调用。

新环境按 Migration → 幂等导入 → 启动调用方部署；已有版本的 Registry 不会被导入覆盖，启用前核对有效 Active 和精确 Fragment。回滚保留表、Stage4 映射列和历史版本，不自动删表或重置 Active。运行时契约见 `07-prompt-spec/registry.md`。

Mock / 请求一致性测试不连接生产或调用模型；B3.1 **真实 PostgreSQL 约束验收尚未完成**，未提供独立测试 URL 时测试会明确 skip，不算通过。Stage4 行锁并发首次绑定也仍需独立 PostgreSQL 验收；不得把 Mock 结果等同真实事务验证。

已有环境升级 Prompt Management / 静态清理不需额外 Migration 或重导入。直接 Fragment Key 引用需先执行新增 `0025_fragment_key_references.sql`（通过既有 `npm run db:migrate`）；它仅替换 Guard Function，不改写 Prompt 数据或 Active。部署后从旧 Request 创建 Draft 时仅转换本地编辑副本，保存、Publish 和 Activate 均须人工操作。登录 `/ai/prompts` 管理版本；手动保存 / Activate 会写 Web 当前连接的数据库，验收须使用测试环境。`test:prompt-registry` 检查 Service 和生产依赖边界；`test:prompt-runtime` 检查绑定；`test:prompt-requests` 检查实际请求一致性；`test:prompt-management` 检查 UI。认证 / 导航回归为 `test:admin-auth`、`test:admin-navigation`。均不调用模型；真实 Stage1 冒烟 `test:stage1:chat` 需另行授权。

Manual / Put Back 进程硬退出可能遗留 `promptAttempt.status=running`：先确认原请求进程已结束、无模型请求仍在进行，并检查是否已有成功结果，再由运维针对该文章 / Candidate 将标记恢复为 failed；不要自动超时接管或批量清除。Put Back 保留原绑定 UUID，Manual 下一次主动点击重新选择 Active。此流程不提供未经确认的自动修复脚本。

### 三层 System Fragment 升级

新环境先完成 `prompts:import`；已有环境不要重导入覆盖 Prompt。使用本次代码执行：

```bash
npm run db:migrate
npm run prompts:system-layers -- --dry-run
npm run prompts:system-layers -- --execute
```

`--execute` 在单事务中创建缺失的三个空 Published v1，基于每个**当前 Active** 创建带显式引用的新 Request Published 版本，再切换 Active；重复执行无变化，已有 Fragment / Draft / Published 均不覆盖。输出包含原 / 新 UUID 与实际新版本号；中途失败整体回滚。共涉及 13 个 Request，不升级 `in_depth.*`；原始 18 项 Seed / Parity 基线不变。

启动新 Run 需要三个 Fragment 都有有效 Active，不能让旧代码加载新动态引用。

回滚优先在 `/prompts` 按命令输出恢复各 Request 的旧 Published Active，保留 Migration、Fragment 和新版本记录；不要删表或修改 Published。新动态 Request 已绑定的 Run 仍需兼容代码完成或恢复，不能直接换回不识别该引用的旧 Runtime。历史 Run 的严格兼容和快照定义见 [Prompt Contract](07-prompt-spec/registry.md#三层-system-prompt)。真实 PostgreSQL Trigger 与并发验收需独立测试库，Mock 不代替该验证。

### 2.4 人工候选与 Put Back 部署前提

Put Back 部署需通过 `npm run db:migrate` 应用 `0020_digest_put_back.sql` 并重启服务；不需回填或运行 Daily。模型使用 Stage1 Provider / Model，无新增环境变量。业务与字段定义见 `06-workflow-spec/manual-operations.md` §2、[processed_contents](05-data-model/daily.md#processed_contents)。

人工 URL 候选需要先应用 `0019_manual_in_depth.sql`（使用既有 `npm run db:migrate`），再部署并按既有方式重启 Web 和正在运行的 Discovery Worker；无需回填旧候选，人工提交本身不依赖 Worker。人工 Generate 使用 `DISCOVERY_LLM_PROVIDER`（回退 `LLM_PROVIDER`）及该 Provider 的模型配置，单次调用、不自动重试。人工候选行为与正文策略见 `01` §4.2、`04-technical-spec/discovery.md` §6.4；Step 1 抓取需要已有 `FIRECRAWL_API_KEY`。

原文 Cache 使用 `0017_discovery_fetch_cache.sql`，平铺 Editorial 字段使用 `0018_flatten_in_depth_editorial.sql`；部署前确认这些既有 Migration 已应用。Mock 回归入口见 [§6](#6-regression-tests)。

### 2.5 Memory 管理部署

先核对数据库连接目标与待执行迁移，使用现有 `npm run db:migrate` 应用 `0023_memories.sql`，再部署并按既有方式重启 Web。只新增独立管理表，无回填、Seed、Prompt 导入或 Pipeline 操作；接入 Memory Runtime 的代码部署后需按既有方式重启 Discovery Worker；本次 Runtime 无额外 Migration。不要为回滚界面自动删表。管理入口与行为见 [Technical Spec](04-technical-spec/admin-api.md#75-memory-管理)，字段见 [Data Model](05-data-model/memory.md#memories)。

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

### 3.3 Discovery D2–D5 Workflow

```bash
npm run discovery -- --dates=YYYY-MM-DD,YYYY-MM-DD --confirm-paid
npm run discovery -- --run-id=UUID --confirm-paid
npm run discovery -- --open-parent-run-id=UUID --open-context="可选人工补充方向" --confirm-paid
```

第一个命令创建新的常规 Discovery Run；第二个命令恢复已有 Run；第三个命令创建关联原 Regular Run 的独立人工 Open Run。该入口会调用真实 Provider、D3/D5 Web Search 与 Firecrawl，必须显式 `--confirm-paid`。常规 Run 在 D3、D4 都完成且没有合格候选时自动执行 D5；人工 Open 只执行 D5，不重跑 D2–D4。终端报告输出 Run / Parent Run ID、阶段状态、Usage、缓存命中率和候选/审核数量。

In-depth 人工审核入口为 `/review/in-depth`，审核 API 为 `/api/admin/review/in-depth`，公开数据仅通过 `/api/in-depth` 提供。当前 Next.js `basePath=/ai`，实际浏览器路径分别为 `/ai/review/in-depth`、`/ai/api/admin/review/in-depth`、`/ai/api/in-depth`。审核页与 API 使用统一管理员 Session，公开 API 保持匿名访问。相关状态语义见 [Discovery Workflow](06-workflow-spec/discovery.md) 和 [Data Model](05-data-model/discovery.md#in_depth_candidates)。回归入口见 [§6](#6-regression-tests)。

#### Discovery Worker

```bash
npm run discovery:worker
```

该命令持续执行 Dashboard / Scheduled CLI 已接受的任务，会产生付费模型 / Web Search / Firecrawl 调用；只在正式配置好数据库与 Provider 的环境启动。CLI 仍使用上节命令；Worker / CLI 的数据库连接必须支持 session advisory lock（直连或 Session Pooling，不使用 Transaction Pooling）。

Ubuntu systemd 安装入口为 `deploy/x-ai-discovery-worker.service`。先核对 User、WorkingDirectory、npm / Node 22 路径与服务器一致，再执行：

```bash
cd /home/ubuntu/X-AI
sudo install -m 644 deploy/x-ai-discovery-worker.service /etc/systemd/system/x-ai-discovery-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now x-ai-discovery-worker
sudo systemctl status x-ai-discovery-worker
journalctl -u x-ai-discovery-worker -n 100 --no-pager
```

Worker unit 必须先安装；Deploy 统一管理 Web 与 Worker 的停启及回滚，步骤见 §2.2。空闲常驻 Worker 不再因进程名阻止部署，但正在执行的 Discovery 必须等待结束；不要为了通过检查强停付费任务。若在部署之外人工停止 Worker，优先等待当前工作完成；超出 systemd 停止窗口会终止进程，已开始任务在下次 Worker 启动时明确标记失败，不自动付费重试。pending 任务保留在数据库，Web 请求或部署中断不丢失已接受提交。不要在旧版不认识队列的代码上遗留无人消费的 pending 任务。

按部署版本确认既有 Migration 已应用。协调上线先部署 X-field 的分页消费者（兼容旧 `{ items }` 响应），再上线 X-AI-field 分页 API，避免旧客户端只看到前 10 篇。API 契约见 `04-technical-spec/admin-api.md`，任务执行与恢复语义见 `04-technical-spec/discovery.md`。

任务队列、Dashboard 操作与公开分页的 Mock 回归见 [§6](#6-regression-tests)。

#### Discovery Scheduled CLI / Crontab

`npm run discovery:scheduled` 供 Cron 每天调用；它按 [Discovery Workflow §2.1](06-workflow-spec/discovery.md#21-触发与依赖) 的上海自然日规则检查是否执行，不依赖服务器本地时区。非执行日只记录 skipped、退出码为 0，不连接数据库；执行日只提交 Regular 任务，窗口为前一天和今天，`trigger_source = schedule`，由上述 Worker 异步执行完整流程（D5 仍遵循原自动触发条件）。不要求 `--confirm-paid`；启用 Cron 即授权自动任务的付费调用，提交脚本自身不调用模型或 Firecrawl。

同日 Cron 重复调用返回已存在的定时 Run，包括已完成、失败或 blocked 的记录，不自动重复付费；幂等标识由 [Data Model](05-data-model/discovery.md#discovery_runs) 定义。Dashboard 手动 Retry 使用独立请求标识，终态 Cron Run 不阻止手动新建 Run。沿用现有业务窗口互斥：首次提交时如果同窗口已有 pending / running 则报错，退出码为 1；数据库或提交异常同样非零退出。修复上游后可手动 Retry，或在当天重新调用未成功提交的 Cron 入口；已记录 blocked 的定时 Run 不会被该命令重置。

**先部署新代码并安装、启动 Worker，再启用 Cron。** 若尚未安装，按上一节操作；确认：

```bash
cd /home/ubuntu/X-AI
mkdir -p runtime
sudo systemctl is-active x-ai-discovery-worker
timedatectl
date '+%F %T %Z %z'
sudo systemctl status cron --no-pager
crontab -l
```

在 `ubuntu` 用户的 `crontab -e` 中保留原 Daily 条目并追加 Discovery：

```cron
CRON_TZ=Asia/Shanghai
30 8 * * * cd /home/ubuntu/X-AI && /usr/bin/npm run daily >> /home/ubuntu/X-AI/runtime/daily.log 2>&1
0 12 * * * cd /home/ubuntu/X-AI && /usr/bin/npm run discovery:scheduled >> /home/ubuntu/X-AI/runtime/discovery.log 2>&1
```

上线前必须检查**生产服务器实际 Cron 实现是否支持 `CRON_TZ`，以及实际采用的调度时区**（服务器上 `man 5 crontab`、现有 Cron 配置与运行日志）；不能仅凭该环境变量已写入就认为触发时间正确。如果 Cron 不按 `CRON_TZ` 调度，需先确认实际时区与上海 12:00 对应关系，再配置触发时刻。只设置任务内的 TZ 不等于改变调度器触发时区。本文给出的两条表达式以调度器实际按上海时间执行为前提，不自动修改服务器时区或原 Daily 配置。

```bash
tail -n 30 /home/ubuntu/X-AI/runtime/discovery.log
sudo journalctl -u cron --since today --no-pager
sudo journalctl -u x-ai-discovery-worker -n 100 --no-pager
```

提交日志显示上海日期及 Run ID / 状态，实际执行日志在 Worker journald。结合 Cron 日志核对首次调用确为上海 12:00。部署时沿用上一节 Worker 停启流程，避开 Cron 提交时刻；排队任务会保留。该入口不新增依赖、Schema、Migration 或调度服务。安全回归见 [§6](#6-regression-tests)；不要直接运行真实 Scheduled CLI 代替 Mock 测试。

### 3.4 In-depth「完善介绍」运行前提

Generate / Regenerate 通过共享 Structured Output Client 调用一次介绍模型。正文已存时不抓取；Cache / Daily 全文均未命中时，需要 `FIRECRAWL_API_KEY`，对固定 Original URL 调用一次 Firecrawl（不自动重试），写入 Cache 后再调用模型。没有 Web Search 或 Agent Loop。D3 / D5 也使用该 Cache，缓存命中不消耗 Firecrawl Credit；错误 / 不完整正文不会作为完整内容复用。

模型请求超时 120 秒，单次输入正文上限仍为 60,000 字符；超出时明确失败并保留已缓存原文，不截断后假称阅读全文。输出预算 8,000 tokens，每段 Markdown 存储 / 传输安全上限为 32,000 字符；这些是资源边界，不是写作字数要求。日志记录 Provider / Model / Prompt version / Usage、正文来源和 Cache 写入异常，不输出凭据。实际费用取决于配置模型和 Token 用量；Save changes 与 Save notes 不调用模型或 Firecrawl。

部署前提见 [§2.4](#24-人工候选与-put-back-部署前提)，Mock 回归见 [§6](#6-regression-tests)。

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

需要 `DATABASE_URL`。详情与隔离原则见 [Technical Spec](04-technical-spec/admin-api.md)。

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
| `DISCOVERY_LLM_PROVIDER` | Discovery D2 / D4 与 Editorial Generate shared Provider | 覆盖既有 `LLM_PROVIDER`；模型、Base URL 与 API Key 均由该 Provider 的既有配置解析 |
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
| `ADMIN_PASSWORD_HASH` | 管理员登录 | 必填；`npm run admin:hash-password` 生成的 scrypt hash，不填写明文密码 |
| `ADMIN_COOKIE_SECURE` | 管理员 Session Cookie | 必填；当前 HTTP 部署设 `false`，切换 HTTPS 后设 `true`；不由 `NODE_ENV` 或请求头推断 |
| `ADMIN_SESSION_DIR` | Session 文件目录 | 可选；默认系统临时目录中按工作目录区分的目录；持久部署可指定服务账户专用目录 |

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

回归测试保护稳定的正确性契约，不运行生产 Pipeline。以下按主要业务边界列出常用入口；完整可执行脚本以 `package.json` 的 `scripts` 为准。

本节列出的测试使用 Mock / Fixture，不调用真实模型或 Firecrawl；部分测试会创建和清理本地临时文件。数据库集成验证及付费诊断单列于 [§7](#7-reusable-diagnostics-and-smoke-tests)，不要将其作为安全 Mock 集合批量执行。

### Daily Processing

覆盖 Daily scope、内容补全、Stage1–4、排名持久化与 Usage。Stage4 的真实数据库持久化验证见 §7，不在此列表内。

```bash
npm run test:daily-scope
npm run test:pre-stage1-duplicates
npm run test:content-completion-runtime
npm run test:content-completion-pools
npm run test:stage1-codex-rollout
npm run test:stage2-retry
npm run test:stage3-persistence
npm run test:stage4-event-date
npm run test:daily-llm-usage
```

### Discovery

覆盖 D2 / D4、D3 Agent、D5、Orchestrator / Resume、Worker 队列、Scheduled 提交、Dashboard 操作及 Tags / Cover / Fetch Cache。Phase1 同时包含真实数据库检查，单列于 §7；不要用真实 Worker、Scheduled CLI 或 Discovery CLI 代替以下 Mock 测试。

```bash
npm run test:discovery-phase2
npm run test:discovery-phase3
npm run test:discovery-d5
npm run test:discovery-orchestrator
npm run test:discovery-jobs
npm run test:discovery-scheduled
npm run test:discovery-actions
npm run test:discovery-dashboard
npm run test:discovery-metadata
npm run test:discovery-fetch-cache
npm run test:discovery-presentation
```

### Admin / Editorial / Manual Operations

覆盖管理员认证与导航、Review / Evaluation、Read More、人工候选、Introduction、Put Back 及公开分页。部署前提见 [§2.4](#24-人工候选与-put-back-部署前提)，后台结构见 [Technical Spec](04-technical-spec/admin-api.md#7-internal-dashboard)。

```bash
npm run test:admin-auth
npm run test:admin-navigation
npm run test:memories
npm run test:memories-ui
npm run test:ranking-review
npm run test:model-evaluation
npm run test:read-more-cache
npm run test:brief-read-more-availability
npm run test:manual-in-depth
npm run test:manual-in-depth-ui
npm run test:in-depth-introduction
npm run test:in-depth-introduction-ui
npm run test:in-depth-review
npm run test:digest-put-back
npm run test:digest-put-back-ui
npm run test:in-depth-pagination
```

下列客户端分页回归需要相邻 `Xfield` 仓库，验证追加、去重、末页和错误恢复；不访问真实 Discovery 或付费服务。

```bash
npm run test:in-depth-load-more
```

### Shared Infrastructure

覆盖环境加载与 Prompt Registry、版本绑定、请求 Parity、管理 UI。运行 Registry 的 Mock 测试前，确认未设置 `PROMPT_REGISTRY_TEST_DATABASE_URL`；设置该变量会额外执行 §7 的真实 PostgreSQL 验证，不属于纯 Mock。

```bash
npm run test:pipeline-env
npm run test:prompt-registry
npm run test:prompt-runtime
npm run test:system-prompt-layers
npm run test:prompt-requests
npm run test:prompt-management
npm run test:fragment-key-references
```

## 7. Reusable Diagnostics and Smoke Tests

以下为人工数据库集成验证与诊断，不是安全 Mock 集合。数据库测试仅可使用独立测试库，执行前核对脚本实际加载的连接配置，不能只假定 Shell 指向测试环境。

这些命令可能调用真实外部服务、读取真实数据库或写入本地 `runtime/`；不要把它们当作无副作用 regression tests。

| 命令 | 参数 / 前提 | 实际用途 |
|---|---|---|
| `npm run test:d2-input -- [--dates=YYYY-MM-DD,YYYY-MM-DD]` | 当前数据库；默认取最近两期成功 Daily；只读事务 | 用正式 D2 请求准备与 SDK 参数构造逻辑加载 Active Published Prompt、精确 Fragment 与启用的 general/topic Memory，完整打印 `chat.completions.create` 参数对象和 requestOptions；终端仅将 Daily contents 隐藏为 `{}`，Prompt/Memory 全量可见。无模型调用、Run 创建或数据库写入；请勿将包含编辑偏好的输出随意公开 |
| `npm run test:discovery-phase1` | 仅使用独立测试数据库；脚本会加载 `.env.local` / `.env` 的 `DATABASE_URL` | Mock 适配器 / Run 生命周期，并在有连接配置时创建隔离 Schema、执行 Migration 和写入测试数据，最终回滚；无 URL 时数据库部分跳过，不算通过 |
| `npm run test:stage4-persistence` | 必须是独立测试数据库，包含所需表及 Event 输入记录；脚本会加载 `.env` / `.env.local`，后者可覆盖 Shell 配置 | 对真实表执行 Event 持久化、替换与跨日保护检查，事务最终回滚；不能因回滚就使用生产数据库 |
| `npm run test:prompt-registry` | 显式设置独立测试库 `PROMPT_REGISTRY_TEST_DATABASE_URL`；无此变量仅跑 §6 的 Mock 部分 | 在隔离 Schema 验证 PostgreSQL 约束、事务及导入幂等性，结束回滚；未提供 URL 的 skip 不算真实验收通过 |
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

Discovery Run 的正式恢复边界见 `06-workflow-spec/discovery.md` §8.3。操作时：没有持久化 `selection_output` 的失败 Run 不使用 `--run-id`，而是创建 New Run 并从 D2 开始；已有 `selection_output` 时，D3 / D4 Resume 复用原 Run。D3 读取 `execution_state.d3`：`completed` 直接跳过，失败、缺失或遗留 `running` 会重新执行整个 Agent Run；D4 复用同一 Candidate ID，仅评价仍为 `discovered` 的 Candidate。主动重新生成应创建 New Run。

## 8. `scripts/` 文件分类

| 文件 | 分类 | package script / 操作入口 |
|---|---|---|
| `run-daily-workflow.ts` | Production / operational command | `daily` |
| `run-model-evaluation.ts` | Production / operational command (manual Evaluation) | `eval:*` |
| `test-codex-call.ts` | 保留的手动 Codex diagnostic | 无 package 入口；按脚本头部示例调用 |
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
| `test-stage4-persistence.ts` | Regression test | `test:stage4-persistence`（仅独立测试 DB，见 §7） |

## 9. Runtime Artifact 操作注意事项

`runtime/` 是本地 execution diagnostic artifact，不是跨机器业务真相。仅在本文件登记的 diagnostic/recovery command 会直接读取历史 runtime
