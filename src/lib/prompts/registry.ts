import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  type PromptBody,
  type PromptVersion,
  type RegistryKey,
  type RegistryKind,
  validatePromptBody,
  renderResolvedPrompt,
} from './contracts.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Database = Pick<Pool, 'connect'>;
export type RegistryInput = {
  key: RegistryKey;
  kind: RegistryKind;
  workflow: string;
  step: string;
  requestType: string;
  displayName: string;
};
/** Initial import preserves an existing static vN label; unlabeled Prompts start at v1. */
export function initialPromptVersion(legacyVersion?: string): number {
  if (legacyVersion === undefined) return 1;
  const match = /^v([1-9]\d*)$/.exec(legacyVersion);
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version) || version > 2_147_483_647)
    throw new Error(`Unsupported initial Prompt version: ${legacyVersion}`);
  return version;
}
export type VersionSource = { sourceCommit?: string; legacyVersion?: string; changeNote?: string };
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function promptContentHash(body: PromptBody): string {
  return createHash('sha256').update(canonical(body)).digest('hex');
}
const SELECT_VERSION = `select v.id, v.registry_id as "registryId", r.key, r.kind,
  v.version, v.status, v.body, v.content_hash as "contentHash",
  v.source_commit as "sourceCommit", v.legacy_version as "legacyVersion"
  from prompt_versions v join prompt_registry r on r.id = v.registry_id`;
export async function getPromptVersion(db: Queryable, id: string): Promise<PromptVersion> {
  const result = await db.query<PromptVersion>(`${SELECT_VERSION} where v.id = $1::uuid`, [id]);
  const version = result.rows[0];
  if (!version) throw new Error(`Prompt version not found: ${id}`);
  validatePromptBody(version.key, version.kind, version.body);
  if (promptContentHash(version.body) !== version.contentHash)
    throw new Error('Prompt content hash mismatch.');
  return version;
}
export async function getActivePrompt(db: Queryable, key: RegistryKey): Promise<PromptVersion> {
  const result = await db.query<{ activeVersionId: string | null }>(
    'select active_version_id as "activeVersionId" from prompt_registry where key = $1',
    [key],
  );
  const id = result.rows[0]?.activeVersionId;
  if (!id) throw new Error(`No Active Prompt: ${key}`);
  const version = await getPromptVersion(db, id);
  if (version.key !== key || version.status !== 'published')
    throw new Error('Invalid Active Prompt binding.');
  return version;
}
export async function resolvePromptFragments(db: Queryable, version: Pick<PromptVersion, 'body'>) {
  const fragments = new Map<string, PromptVersion>();
  for (const ref of version.body.fragments) {
    const fragment = await getPromptVersion(db, ref.versionId);
    if (fragment.kind !== 'fragment' || fragment.status !== 'published')
      throw new Error('Request must reference a published fragment.');
    fragments.set(ref.versionId, fragment);
  }
  return fragments;
}
export async function renderPromptVersion(
  db: Queryable,
  versionId: string,
  values: { input: string; category?: string },
  variant?: string,
) {
  const version = await getPromptVersion(db, versionId);
  return renderResolvedPrompt(version, await resolvePromptFragments(db, version), values, variant);
}
async function transaction<T>(db: Database, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const value = await work(client);
    await client.query('commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
async function lockRegistry(client: PoolClient, key: RegistryKey) {
  const result = await client.query<{ id: string; key: RegistryKey; kind: RegistryKind }>(
    'select id, key, kind from prompt_registry where key = $1 for update',
    [key],
  );
  if (!result.rows[0]) throw new Error(`Registry not found: ${key}`);
  return result.rows[0];
}
async function insertDraft(
  client: PoolClient,
  registry: { id: string; key: RegistryKey; kind: RegistryKind },
  rawBody: PromptBody,
  source: VersionSource,
  id: string = randomUUID(),
  initialVersion = 1,
) {
  const body = validatePromptBody(registry.key, registry.kind, rawBody);
  await resolvePromptFragments(client, { body });
  const result = await client.query<{ id: string }>(
    `insert into prompt_versions
    (registry_id, version, status, body, content_hash, source_commit, legacy_version, change_note, id)
    select $1::uuid, coalesce(max(version) + 1, $8::integer), 'draft', $2::jsonb, $3, $4, $5, $6, $7::uuid
      from prompt_versions where registry_id = $1::uuid returning id`,
    [
      registry.id,
      JSON.stringify(body),
      promptContentHash(body),
      source.sourceCommit ?? null,
      source.legacyVersion ?? null,
      source.changeNote ?? null,
      id,
      initialVersion,
    ],
  );
  return getPromptVersion(client, result.rows[0].id);
}
export async function createPromptDraft(
  db: Database,
  key: RegistryKey,
  body: PromptBody,
  source: VersionSource = {},
) {
  return transaction(db, async (client) =>
    insertDraft(client, await lockRegistry(client, key), body, source),
  );
}
export async function publishPromptVersion(db: Database, key: RegistryKey, versionId: string) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    const version = await getPromptVersion(client, versionId);
    if (version.registryId !== registry.id) throw new Error('Version belongs to another Registry.');
    await resolvePromptFragments(client, version);
    if (version.status === 'draft')
      await client.query("update prompt_versions set status = 'published' where id = $1::uuid", [
        versionId,
      ]);
    return getPromptVersion(client, versionId);
  });
}
export async function activatePromptVersion(db: Database, key: RegistryKey, versionId: string) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    const version = await getPromptVersion(client, versionId);
    if (version.registryId !== registry.id || version.status !== 'published')
      throw new Error('Active must be a published version of the same Registry.');
    await resolvePromptFragments(client, version);
    await client.query(
      'update prompt_registry set active_version_id = $2::uuid, updated_at = now() where id = $1::uuid',
      [registry.id, versionId],
    );
    return version;
  });
}
/** Pure helper for a future batch-upgrade UI: creates a new body, never updates a published version. */
export function withFragmentVersions(
  body: PromptBody,
  replacements: Readonly<Record<string, string>>,
): PromptBody {
  if (Object.keys(replacements).some((slot) => !body.fragments.some((f) => f.slot === slot)))
    throw new Error('Unknown fragment slot.');
  return {
    ...body,
    fragments: body.fragments.map((ref) => ({
      ...ref,
      versionId: replacements[ref.slot] ?? ref.versionId,
    })),
  };
}
export type PromptSeed = RegistryInput & { id: string; body: PromptBody; source: VersionSource };
/** All registries/versions are imported atomically; any existing version protects future administrator edits. */
export async function importPromptSeeds(db: Database, seeds: PromptSeed[]) {
  return transaction(db, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('prompt-registry-import', 0))",
    );
    const imported: string[] = [],
      skipped: string[] = [];
    for (const seed of seeds) {
      validatePromptBody(seed.key, seed.kind, seed.body);
      await client.query(
        `insert into prompt_registry (key, kind, workflow, step, request_type, display_name)
        values ($1, $2, $3, $4, $5, $6) on conflict (key) do nothing`,
        [seed.key, seed.kind, seed.workflow, seed.step, seed.requestType, seed.displayName],
      );
      const registry = await lockRegistry(client, seed.key);
      if (registry.kind !== seed.kind)
        throw new Error('Existing Registry kind differs from import.');
      const existing = await client.query(
        'select id from prompt_versions where registry_id = $1::uuid limit 1',
        [registry.id],
      );
      if (existing.rows.length) {
        skipped.push(seed.key);
        continue;
      }
      for (const ref of seed.body.fragments) {
        const expected = seeds.find((s) => s.id === ref.versionId);
        const stored = await getPromptVersion(client, ref.versionId);
        if (!expected || stored.contentHash !== promptContentHash(expected.body))
          throw new Error(
            'Imported fragment differs from the source baseline; explicit migration required.',
          );
      }
      const draft = await insertDraft(
        client,
        registry,
        seed.body,
        seed.source,
        seed.id,
        initialPromptVersion(seed.source.legacyVersion),
      );
      await resolvePromptFragments(client, draft);
      await client.query("update prompt_versions set status = 'published' where id = $1::uuid", [
        draft.id,
      ]);
      await client.query(
        'update prompt_registry set active_version_id = $2::uuid, updated_at = now() where id = $1::uuid',
        [registry.id, draft.id],
      );
      imported.push(seed.key);
    }
    return { imported, skipped };
  });
}
