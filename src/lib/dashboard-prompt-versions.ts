import type { Pool } from 'pg';
import { z } from 'zod';

/** Display-only lookup: exact bound Published Request IDs, never current Active or Fragments. */
export async function loadDashboardPromptVersions(db: Pick<Pool, 'query'>, values: unknown[]) {
  const ids = [
    ...new Set(
      values
        .filter((id): id is string => z.uuid().safeParse(id).success)
        .map((id) => id.toLowerCase()),
    ),
  ];
  const rows = ids.length
    ? (
        await db.query<{ id: string; key: string; version: number }>(
          `select v.id, r.key, v.version from prompt_versions v
         join prompt_registry r on r.id = v.registry_id
         where v.id = any($1::uuid[]) and v.status = 'published' and r.kind = 'request'`,
          [ids],
        )
      ).rows
    : [];
  const versions = new Map(rows.map((row) => [row.id, row]));
  return (id: unknown, key: string): string | null => {
    const row = typeof id === 'string' ? versions.get(id.toLowerCase()) : undefined;
    return row?.key === key && Number.isSafeInteger(row.version) && row.version > 0
      ? `v${row.version}`
      : null;
  };
}
