import { addSystemPromptLayers, SYSTEM_LAYER_NOTE } from './system-layers.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  ACTIVE_FRAGMENT_KEYS,
  PROMPT_CONTRACTS,
  type PromptKey,
  type SystemFragmentSnapshot,
  type PromptBody,
  type PromptVersion,
  type RegistryKey,
  type RegistryKind,
  validatePromptBody,
  renderResolvedPrompt,
} from './contracts.js';

type Queryable = Pick<Pool | PoolClient, 'query'>;
type Database = Pick<Pool, 'connect'>;
export class PromptManagementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}
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
  v.source_commit as "sourceCommit", v.legacy_version as "legacyVersion", v.change_note as "changeNote"
  from prompt_versions v join prompt_registry r on r.id = v.registry_id`;
export async function getPromptVersion(db: Queryable, id: string): Promise<PromptVersion> {
  const result = await db.query<PromptVersion>(`${SELECT_VERSION} where v.id = $1::uuid`, [id]);
  const version = result.rows[0];
  if (!version) throw new PromptManagementError(`Prompt version not found: ${id}`, 404);
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
export async function resolvePromptFragments(
  db: Queryable,
  version: Pick<PromptVersion, 'body'>,
  snapshot?: SystemFragmentSnapshot,
) {
  const fragments = new Map<string, PromptVersion>();
  const seenSystem = new Set<string>();
  for (const ref of version.body.fragments) {
    const fragment = ref.versionId
      ? await getPromptVersion(db, ref.versionId)
      : snapshot
        ? await getPromptVersion(db, snapshot[ref.activeKey!])
        : await getActivePrompt(db, ref.activeKey!);
    if (ref.activeKey && fragment.key !== ref.activeKey)
      throw new Error('Dynamic Fragment key mismatch.');
    if ((ACTIVE_FRAGMENT_KEYS as readonly string[]).includes(fragment.key)) {
      if (ref.versionId) throw new Error('System Fragments must use an activeKey reference.');
      if (seenSystem.has(fragment.key)) throw new Error('Duplicate System Fragment reference.');
      seenSystem.add(fragment.key);
    }
    if (fragment.kind !== 'fragment' || fragment.status !== 'published')
      throw new Error('Request must reference a published fragment.');
    fragments.set(ref.versionId ?? ref.activeKey!, fragment);
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
async function transaction<T>(
  db: Database,
  work: (client: PoolClient) => Promise<T>,
  rollback = false,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const value = await work(client);
    await client.query(rollback ? 'rollback' : 'commit');
    return value;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
async function lockRegistry(client: PoolClient, key: RegistryKey) {
  const result = await client.query<{
    id: string;
    key: RegistryKey;
    kind: RegistryKind;
    activeVersionId: string | null;
  }>(
    'select id, key, kind, active_version_id as "activeVersionId" from prompt_registry where key = $1 for update',
    [key],
  );
  if (!result.rows[0]) throw new PromptManagementError(`Registry not found: ${key}`, 404);
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
export async function publishPromptVersion(
  db: Database,
  key: RegistryKey,
  versionId: string,
  expectedHash?: string,
) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    const version = await getPromptVersion(client, versionId);
    if (version.registryId !== registry.id)
      throw new PromptManagementError('Version belongs to another Registry.', 400);
    if (
      expectedHash !== undefined &&
      (version.status !== 'draft' || version.contentHash !== expectedHash)
    )
      throw new PromptManagementError('版本已被修改或发布，请重新检查版本后再发布。', 409);
    await resolvePromptFragments(client, version);
    if (version.status === 'draft')
      await client.query("update prompt_versions set status = 'published' where id = $1::uuid", [
        versionId,
      ]);
    await touchRegistry(client, registry.id);
    return getPromptVersion(client, versionId);
  });
}
export async function activatePromptVersion(
  db: Database,
  key: RegistryKey,
  versionId: string,
  expectedActiveVersionId?: string | null,
) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    if (
      expectedActiveVersionId !== undefined &&
      (registry.activeVersionId ?? null) !== expectedActiveVersionId
    )
      throw new PromptManagementError('Active Version 已变化，请刷新核对后重新确认切换。', 409);
    const version = await getPromptVersion(client, versionId);
    if (version.registryId !== registry.id || version.status !== 'published')
      throw new PromptManagementError(
        'Active must be a published version of the same Registry.',
        400,
      );
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
  if (
    Object.keys(replacements).some(
      (slot) => !body.fragments.some((f) => f.slot === slot && !f.activeKey),
    )
  )
    throw new Error('Unknown fragment slot.');
  return {
    ...body,
    fragments: body.fragments.map((ref) => ({
      ...ref,
      ...(ref.activeKey ? {} : { versionId: replacements[ref.slot] ?? ref.versionId }),
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
        if (!ref.versionId) throw new Error('Frozen baseline requires exact fragments.');
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

export type PromptRegistryItem = RegistryInput & {
  id: string;
  activeVersionId: string | null;
  activeVersion: number | null;
  updatedAt: string;
};
export type ManagedPromptVersion = PromptVersion & { createdAt: string; changeNote: string | null };
export type PromptManagementDetail = {
  registry: PromptRegistryItem;
  versions: ManagedPromptVersion[];
  fragments: ManagedPromptVersion[];
};
const SELECT_REGISTRY = `select r.id,r.key,r.kind,r.workflow,r.step,r.request_type as "requestType",
  r.display_name as "displayName",r.active_version_id as "activeVersionId",v.version as "activeVersion",
  r.updated_at as "updatedAt" from prompt_registry r left join prompt_versions v on v.id=r.active_version_id`;
function iso(value: Date | string) {
  return new Date(value).toISOString();
}
export async function listPromptRegistries(
  db: Queryable,
  search = '',
  kind?: RegistryKind,
): Promise<PromptRegistryItem[]> {
  const result = await db.query<PromptRegistryItem>(
    `${SELECT_REGISTRY}
    where strpos(lower(r.key),lower($1::text))>0 and ($2::text is null or r.kind=$2)
    order by r.workflow,r.step,r.key`,
    [search, kind ?? null],
  );
  return result.rows.map((row) => ({ ...row, updatedAt: iso(row.updatedAt) }));
}
export async function getPromptManagementDetail(
  db: Queryable,
  key: RegistryKey,
): Promise<PromptManagementDetail> {
  const result = await db.query<PromptRegistryItem>(`${SELECT_REGISTRY} where r.key=$1`, [key]);
  if (!result.rows[0]) throw new PromptManagementError('Prompt Registry 不存在。', 404);
  const select = SELECT_VERSION.replace('select v.id,', 'select v.created_at as "createdAt",v.id,');
  const versions = await db.query<ManagedPromptVersion>(
    `${select} where r.key=$1 order by v.version desc`,
    [key],
  );
  const fragments = await db.query<ManagedPromptVersion>(
    `${select} where r.kind='fragment' and v.status='published' order by r.key,v.version desc`,
  );
  const checked = (row: ManagedPromptVersion) => {
    validatePromptBody(row.key, row.kind, row.body);
    if (promptContentHash(row.body) !== row.contentHash)
      throw new Error('Prompt content hash mismatch.');
    return { ...row, createdAt: iso(row.createdAt) };
  };
  return {
    registry: { ...result.rows[0], updatedAt: iso(result.rows[0].updatedAt) },
    versions: versions.rows.map(checked),
    fragments: fragments.rows.map(checked),
  };
}
async function touchRegistry(client: PoolClient, id: string) {
  await client.query('update prompt_registry set updated_at=now() where id=$1::uuid', [id]);
}
function requireOwnedVersion(
  version: PromptVersion,
  registry: { id: string },
  expectedHash: string,
) {
  if (version.registryId !== registry.id)
    throw new PromptManagementError('Version belongs to another Registry.', 400);
  if (version.contentHash !== expectedHash)
    throw new PromptManagementError(
      '版本已被其他操作修改，当前编辑内容已保留。请刷新并重新检查版本。',
      409,
    );
}
export async function createPromptDraftFromVersion(
  db: Database,
  key: RegistryKey,
  sourceVersionId: string,
  expectedHash: string,
) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    const source = await getPromptVersion(client, sourceVersionId);
    requireOwnedVersion(source, registry, expectedHash);
    const draft = await insertDraft(client, registry, source.body, {
      changeNote: `Derived from v${source.version}`,
    });
    await touchRegistry(client, registry.id);
    return draft;
  });
}
export async function updatePromptDraft(
  db: Database,
  key: RegistryKey,
  versionId: string,
  expectedHash: string,
  rawBody: PromptBody,
) {
  return transaction(db, async (client) => {
    const registry = await lockRegistry(client, key);
    const current = await getPromptVersion(client, versionId);
    requireOwnedVersion(current, registry, expectedHash);
    if (current.status !== 'draft')
      throw new PromptManagementError('Published 版本不可修改，请创建新的 Draft。', 409);
    const body = validatePromptBody(key, registry.kind, rawBody);
    await resolvePromptFragments(client, { body });
    const result = await client.query(
      `update prompt_versions set body=$3::jsonb,content_hash=$4
      where id=$1::uuid and registry_id=$2::uuid and status='draft' and content_hash=$5 returning id`,
      [versionId, registry.id, JSON.stringify(body), promptContentHash(body), expectedHash],
    );
    if (result.rowCount !== 1)
      throw new PromptManagementError('Draft 已变化，当前编辑内容已保留，请重新检查版本。', 409);
    await touchRegistry(client, registry.id);
    return getPromptVersion(client, versionId);
  });
}

/** Idempotent upgrade from the CURRENT Active bodies, serialized with ordinary admin writes. */
export async function installSystemPromptLayers(
  db: Database,
  sourceCommit?: string,
  dryRun = false,
) {
  return transaction(
    db,
    async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended('prompt-system-layers-v1', 0))",
      );
      const changes: Array<{ key: string; from: string | null; to: string; version: number }> = [];
      for (const key of ACTIVE_FRAGMENT_KEYS) {
        await client.query(
          `insert into prompt_registry (key,kind,workflow,step,request_type,display_name)
        values ($1,$2,$3,$4,$5,$6) on conflict (key) do nothing`,
          [key, 'fragment', 'shared', 'system', 'fragment', key],
        );
        const registry = await lockRegistry(client, key);
        if (registry.kind !== 'fragment') throw new Error(`Wrong registry kind: ${key}`);
        const existing = await client.query(
          'select id from prompt_versions where registry_id = $1::uuid limit 1',
          [registry.id],
        );
        if (existing.rows.length) {
          await getActivePrompt(client, key);
          continue;
        }
        const draft = await insertDraft(
          client,
          registry,
          { systemInstructions: '', userTemplate: null, variants: {}, fragments: [] },
          { sourceCommit, changeNote: 'Empty System Fragment initialization' },
        );
        await client.query("update prompt_versions set status='published' where id=$1::uuid", [
          draft.id,
        ]);
        await client.query(
          'update prompt_registry set active_version_id=$2::uuid,updated_at=now() where id=$1::uuid',
          [registry.id, draft.id],
        );
        changes.push({ key, from: null, to: draft.id, version: draft.version });
      }
      const keys = Object.keys(PROMPT_CONTRACTS).filter(
        (key) => key.startsWith('daily.') || key.startsWith('discovery.'),
      ) as PromptKey[];
      for (const key of keys) {
        const registry = await lockRegistry(client, key);
        const previous = await getActivePrompt(client, key);
        const body = addSystemPromptLayers(key, previous.body);
        if (promptContentHash(body) === previous.contentHash) continue;
        const draft = await insertDraft(client, registry, body, {
          sourceCommit,
          changeNote: SYSTEM_LAYER_NOTE + previous.id,
        });
        await client.query("update prompt_versions set status='published' where id=$1::uuid", [
          draft.id,
        ]);
        const result = await client.query(
          'update prompt_registry set active_version_id=$2::uuid,updated_at=now() where id=$1::uuid and active_version_id=$3::uuid',
          [registry.id, draft.id, previous.id],
        );
        if (result.rowCount !== 1)
          throw new Error(`Active changed during System layer upgrade: ${key}`);
        changes.push({ key, from: previous.id, to: draft.id, version: draft.version });
      }
      return changes;
    },
    dryRun,
  );
}
