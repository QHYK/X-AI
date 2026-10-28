# Prompt Registry 数据模型

本文件定义 Registry / Version 的存储和约束，以及既有业务对象的绑定载体。不定义模板加载、角色映射、Retry / Resume 或管理 UI 行为；这些规则见 [Prompt Registry Contract](../07-prompt-spec/registry.md)。Schema 见 `src/db/schema.ts`，数据库 Trigger 由 `drizzle/0021_prompt_registry.sql` 创建，`0024_active_system_fragments.sql` 扩展三个限定动态引用，`0025_fragment_key_references.sql` 允许无 Slot 的直接 Key 引用，不能仅凭 ORM 声明推断其存在。

## `prompt_registry`

保存稳定唯一 Prompt Key 和 Active 指针；kind 为 request / fragment。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `key` | text | NOT NULL |
| `kind` | text | NOT NULL |
| `workflow` | text | NOT NULL |
| `step` | text | NOT NULL |
| `request_type` | text | NOT NULL |
| `display_name` | text | NOT NULL |
| `active_version_id` | uuid | nullable |
| `created_at` | timestamptz | NOT NULL；默认 now() |
| `updated_at` | timestamptz | NOT NULL；默认 now() |

`active_version_id` 可为空；复合 FK `(active_version_id, id)` → `prompt_versions(id, registry_id)` 防止跨 Registry 指向错误版本，NULL 指针无需关联版本。Migration 中 `key` 是 UNIQUE constraint，Drizzle 声明同名 unique index。

`prompt_registry_guard` 在 INSERT / UPDATE 调用 `guard_prompt_registry()`：拒绝修改 Registry id / key / kind，非空 Active 必须指向本 Registry 的 Published Version。Workflow / Step / Request Type / 显示名称是元数据，不是路由注册，也没有固定请求清单 CHECK。

### 索引与数据库约束

- `prompt_registry_key_unique`：UNIQUE (`key`)。
- FK (`active_version_id, id`) → `prompt_versions` (`id, registry_id`)，ON DELETE `NO ACTION`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- prompt_registry_kind_check
CHECK ("kind" in ('request', 'fragment'));
```

## `prompt_versions`

保存精确 UUID、Registry 内版本号和不可变的 Published 内容。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | NOT NULL；Primary Key；默认 gen_random_uuid() |
| `registry_id` | uuid | NOT NULL；FK → `prompt_registry.id` |
| `version` | integer | NOT NULL；Registry 内正整数；显示为 vN，不代替 UUID |
| `status` | text | NOT NULL |
| `body` | jsonb | NOT NULL；受控模板及 Fragment 引用；结构见下节 |
| `content_hash` | text | NOT NULL |
| `source_commit` | text | nullable |
| `legacy_version` | text | nullable；原代码版本标签，仅导入 provenance，不是第二个运行时版本号 |
| `change_note` | text | nullable |
| `created_at` | timestamptz | NOT NULL；默认 now() |

Migration 中两项唯一性以 UNIQUE constraints 建立；Drizzle 使用同名 unique indexes。版本 id / registry_id / version / created_at 不可修改；`prompt_version_guard` 在 INSERT / UPDATE / DELETE 调用 `guard_prompt_version()`，Published 不可 UPDATE / DELETE，Draft 可以编辑后变为 Published。数据库不强制编号连续，也不自动递增。

初始导入保留原标签 vN 的 N，无标签则从 1 开始；后续新 Draft 由服务在 Registry 行锁内取最大版本号加一。重复导入跳过已有版本的 Registry，不重编号、不覆盖管理员内容。`source_commit` / `legacy_version` 不参与正文 Hash。

### 索引与数据库约束

- `prompt_versions_registry_version_unique`：UNIQUE (`registry_id, version`)。
- `prompt_versions_id_registry_unique`：UNIQUE (`id, registry_id`)。
- FK (`registry_id`) → `prompt_registry` (`id`)，ON DELETE `NO ACTION`。

数据库 CHECK（仅省略表名前缀；不是应用层 Schema）：

```sql
-- prompt_versions_version_check
CHECK ("version" > 0);
-- prompt_versions_status_check
CHECK ("status" in ('draft', 'published'));
-- prompt_versions_body_check
CHECK (jsonb_typeof("body") = 'object');
-- prompt_versions_content_hash_check
CHECK ("content_hash" ~ '^[a-f0-9]{64}$');
```

### body JSONB

应用 `src/lib/prompts/contracts.ts` 的存储结构：

```json
{
  "systemInstructions": "{{fragment.shared.discovery.editorial_criteria}}",
  "userTemplate": "{{input}}",
  "variants": {},
  "fragments": [
    { "key": "shared.discovery.editorial_criteria", "versionId": "00000000-0000-4000-8000-000000000001" }
  ]
}
```

示例 UUID 仅表示形状，不是可导入的真实引用。System / User 均允许字符串、空字符串或 JSON null；`variants` 按名称保存同样的两个角色模板；`fragments` 保存引用配置而非内容排序：普通项是 `{key, versionId}`；三个限定 System Fragment 使用 `{key, activeKey}`，且 key=activeKey。旧 `{slot, versionId}` / `{slot, activeKey}` 仍可读取；同一项 key 与 slot 互斥，Key 清单与运行时规则见 [三层 System Prompt](../07-prompt-spec/registry.md#三层-system-prompt)。

数据库 Trigger 检查四个顶层键及基本类型，拒绝重复引用名、非法历史 slot，以及不存在 / 非 Published / 非 Fragment 的目标版本。Fragment 必须 `userTemplate=null`、`variants={}`、`fragments=[]`，不支持嵌套。`0024` 要求动态目标为三个指定 Key 之一且存在有效 Active Published Fragment；`0025` 校验直接 Key 对应真实 Fragment；精确版本须属于该 Key，三个特殊 Key 仅使用动态绑定。目标 Published 不能删除，JSONB 引用不是独立 FK。

严格的额外键、variant 内部形状、允许的模板变量和占位符与引用配置一致性由应用 Schema 校验；不能写成数据库已经验证全部模板语义。`content_hash` 的 CHECK 仅要求 64 位小写十六进制；它是否等于规范序列化 body（含引用配置）的 SHA-256，由应用保存 / 加载时验证，不含动态业务输入。

## 版本绑定载体

这些载体保存精确 UUID，而不是 Prompt 文本副本；除 Active 复合 FK 外，JSONB / text / 文件中的 UUID 均没有数据库外键。应用负责所属 Key、Published、Hash 和 Fragment 完整性校验。

| 载体 | 存储与兼容语义 |
|---|---|
| Daily Stage1–3 | 对应 `run.json.promptVersionIds` 保存 Request Key → UUID，`promptVersions` 保存可读 vN；Orchestrator 汇总。兼容历史仅 UUID 的 `promptVersions`，不能凭 vN 恢复。诊断 `prompt_version` 与 `prompt_version_id` 同样区分标签 / 精确引用；`legacy_prompt_version(s)` 只是原静态基线标签 |
| Stage4 | [stage4_runs.prompt_versions](daily.md#stage4_runs) 为权威，文件仅镜像；Decision / Enrichment 使用不同 Key |
| Discovery | [discovery_runs.config_snapshot.promptVersions](discovery.md#discovery_runs)，与 d2–d5 配置并存 |
| Evaluation | [evaluation_runs.prompt_version](daily.md#evaluation_runs) 是 text，当前存精确 UUID；同一 input 的模型运行由应用绑定同一版本，历史静态标签不等于可验证 UUID |
| Introduction / Manual Generate | [discovery_candidates.evaluation.promptVersions](discovery.md#discovery_candidates) 只记录最近一次相应生成尝试，不是跨请求 Resume 或完整历史 |
| Put Back / Read More | [raw_articles.metadata.promptVersions](daily.md#raw_articles) |

Manual / Put Back 同一 JSONB 下还保存 `promptAttempt = {key, status}`，应用状态为 running / completed / failed。这是执行领取标记，不是数据库枚举或独立操作历史；硬退出遗留 running 的恢复入口见 [Operations](../09-operations.md)。每次新 Generate、失败重试、Resume 的具体选版行为统一见 [Runtime Contract](../07-prompt-spec/registry.md)，这里不再复制。

### System Fragment 快照载体

`systemFragmentVersions` 是三个限定 Fragment Key → 精确 UUID 的对象，不保存文本。它不放宽 `version > 0`，不新增表或列：

- Daily / 独立 Stage：`run.json.systemFragmentVersions`；Daily 子阶段继承父文件，原子更新保留快照。
- Discovery：`config_snapshot.systemFragmentVersions`；独立 Open 不继承父 Run 的快照。
- Stage4：`stage4_runs.prompt_versions.systemFragmentVersions`，与平铺的 Request UUID 并存。
- Read More / Put Back：`raw_articles.metadata.systemFragmentVersions`，与操作绑定一起保存。
- 新 Evaluation：`evaluation_inputs.input_json = {evaluationBusinessInput, systemFragmentVersions}`；input_hash 对完整包装计算，执行时恢复原业务输入。历史未包装 JSON 仍可读取。

历史没有该字段不回填。升级 Request 的 `change_note` 记录 `system-fragments-v1:previous=<UUID>`，是确切的升级来源，不是版本号或推测历史的依据。
