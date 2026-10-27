# Memory Data Model

## `memories`

管理员维护的自然语言编辑偏好。无业务关联 FK 或历史 Memory Snapshot；运行时使用见 [Memory Runtime](../04-technical-spec/discovery.md#memory-runtime)。

| Field | Type | Constraint / Notes |
|---|---|---|
| `id` | uuid | Primary Key，默认 `gen_random_uuid()` |
| `content` | text | NOT NULL；API 去除首尾空白后要求非空 |
| `type` | text | NOT NULL，默认 `general` |
| `priority` | integer | NOT NULL，默认 `0`；PostgreSQL 有符号整数，不另设非负 CHECK |
| `enabled` | boolean | NOT NULL，默认 `true`；不影响管理列表是否可见 |
| `created_at` | timestamptz | NOT NULL，默认 `now()`；编辑不改变创建时间 |
| `updated_at` | timestamptz | NOT NULL，默认 `now()`；更新操作显式写入当前时间 |

Type 定义：`general` 为通用编辑偏好，`topic` 为话题选择与关注方向，`source` 为来源发现与选择偏好，`content` 为内容整理、翻译、总结偏好。

### 索引与数据库约束

- 除主键外无额外索引、唯一键或外键。
- `memories_type_check`：仅允许上述四种 Type。
- `memories_content_check`：`length(btrim(content)) > 0`；应用层另用字符串 trim 校验空白输入。
- Schema 与 Migration `0023_memories.sql` 定义一致；无到期、标签、权重或版本表。管理读写契约见 [Memory 管理](../04-technical-spec/admin-api.md#75-memory-管理)。
