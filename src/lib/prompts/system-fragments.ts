import { z } from 'zod';
import type { Pool } from 'pg';
import {
  ACTIVE_FRAGMENT_KEYS,
  type SystemFragmentSnapshot,
  type PromptKey,
  type PromptVersion,
} from './contracts.js';
import { getActivePrompt, getPromptVersion } from './registry.js';

export function readSystemFragmentSnapshot(value: unknown): SystemFragmentSnapshot | undefined {
  if (value === undefined) return undefined; // Historical Runs remain historical.
  return z
    .object({
      'xfield.identity': z.uuid(),
      'daily_brief.editorial': z.uuid(),
      'discover.editorial': z.uuid(),
    })
    .strict()
    .parse(value);
}
/** One SQL snapshot of all three Active pointers; all versions are immutable. */
export async function captureSystemFragments(
  db: Pick<Pool, 'query'>,
): Promise<SystemFragmentSnapshot> {
  const result = await db.query<{ key: string; id: string }>(
    `select r.key, v.id from prompt_registry r join prompt_versions v on v.id = r.active_version_id
     and v.registry_id = r.id where r.key = any($1::text[]) and r.kind = 'fragment' and v.status = 'published'`,
    [[...ACTIVE_FRAGMENT_KEYS]],
  );
  const snapshot = Object.fromEntries(result.rows.map((row) => [row.key, row.id]));
  try {
    return readSystemFragmentSnapshot(snapshot)!;
  } catch {
    throw new Error('Three Active System Fragments must be initialized before starting a new Run.');
  }
}
import { SYSTEM_LAYER_NOTE } from './system-layers.js';
export function hasActiveFragments(version: Pick<PromptVersion, 'body'>) {
  return version.body.fragments.some((ref) => !!ref.activeKey);
}
/** Legacy unbound Request may use only the exact source recorded by the upgrade. */
export async function compatibleActiveRequest(
  db: Pick<Pool, 'query'>,
  key: PromptKey,
  snapshot?: SystemFragmentSnapshot,
) {
  const active = await getActivePrompt(db, key);
  if (snapshot || !hasActiveFragments(active)) return active;
  const previous = active.changeNote?.startsWith(SYSTEM_LAYER_NOTE)
    ? active.changeNote.slice(SYSTEM_LAYER_NOTE.length)
    : undefined;
  if (previous && z.uuid().safeParse(previous).success) {
    const old = await getPromptVersion(db, previous);
    if (old.key === key && old.status === 'published' && !hasActiveFragments(old)) return old;
  }
  throw new Error(
    `Historical Run has no System Fragment snapshot or provable previous Request: ${key}. Start a new Run.`,
  );
}
