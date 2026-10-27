import type { Pool } from 'pg';
import type { Memory, MemoryCreate, MemoryType, MemoryUpdate } from './memory-contracts.js';

type Db = Pick<Pool, 'query'>;
type Row = Omit<Memory, 'createdAt' | 'updatedAt'> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};
const columns =
  'id, content, type, priority, enabled, created_at as "createdAt", updated_at as "updatedAt"';
const serialize = (row: Row): Memory => ({
  ...row,
  createdAt: new Date(row.createdAt).toISOString(),
  updatedAt: new Date(row.updatedAt).toISOString(),
});

export async function listMemories(db: Db, type?: MemoryType): Promise<Memory[]> {
  const result = await db.query<Row>(
    `select ${columns} from memories ${type ? 'where type = $1' : ''}
     order by priority desc, created_at desc, id desc`,
    type ? [type] : [],
  );
  return result.rows.map(serialize);
}

/** Runtime reads are explicit: an empty type list never expands to all types. */
export async function getActiveMemories(
  db: Db,
  { types }: { types: readonly MemoryType[] },
): Promise<Memory[]> {
  if (types.length === 0) return [];
  const result = await db.query<Row>(
    `select ${columns} from memories where enabled = true and type = any($1::text[])
     order by priority desc, created_at desc, id desc`,
    [[...types]],
  );
  return result.rows.map(serialize);
}

/** Plain-text data context; never a replacement for the request's system rules. */
export function formatMemories(memories: readonly Pick<Memory, 'type' | 'content'>[]): string {
  if (memories.length === 0) return '';
  return `以下是长期编辑偏好，供当前任务参考：${memories
    .map(({ content }) => content)
    .join('；')}`;
}

export async function createMemory(db: Db, input: MemoryCreate): Promise<Memory> {
  const result = await db.query<Row>(
    `insert into memories (content, type, priority, enabled) values ($1, $2, $3, $4) returning ${columns}`,
    [input.content, input.type, input.priority, input.enabled],
  );
  if (!result.rows[0]) throw new Error('Memory insert did not return a row.');
  return serialize(result.rows[0]);
}

export async function updateMemory(db: Db, input: MemoryUpdate): Promise<Memory | null> {
  // Keep the enabled-only API compatible; row editing saves all four fields atomically.
  const result = !('content' in input)
    ? await db.query<Row>(
        `update memories set enabled = $2, updated_at = now() where id = $1::uuid returning ${columns}`,
        [input.id, input.enabled],
      )
    : await db.query<Row>(
        `update memories set content = $2, type = $3, priority = $4, enabled = $5, updated_at = now()
       where id = $1::uuid returning ${columns}`,
        [input.id, input.content, input.type, input.priority, input.enabled],
      );
  return result.rows[0] ? serialize(result.rows[0]) : null;
}
