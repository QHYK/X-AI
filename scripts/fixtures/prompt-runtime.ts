import { buildProductionPromptSeeds } from '../../src/lib/prompts/production-seeds.js';
import { promptContentHash, initialPromptVersion } from '../../src/lib/prompts/registry.js';
import type { PromptVersion, RegistryKey } from '../../src/lib/prompts/contracts.js';
import type { Pool } from 'pg';
import { ACTIVE_FRAGMENT_KEYS } from '../../src/lib/prompts/contracts.js';
const seeds = await buildProductionPromptSeeds('a'.repeat(40));
export class PromptMemory {
  constructor() {
    for (const key of ACTIVE_FRAGMENT_KEYS) {
      const id = `00000000-0000-4000-8000-00000000090${ACTIVE_FRAGMENT_KEYS.indexOf(key)}`;
      const body = { systemInstructions: '', userTemplate: null, variants: {}, fragments: [] };
      this.versions.set(id, {
        id,
        registryId: id,
        key,
        kind: 'fragment',
        version: 1,
        status: 'published',
        body,
        contentHash: promptContentHash(body),
        sourceCommit: null,
        legacyVersion: null,
      });
      this.active.set(key, id);
    }
  }
  versions = new Map<string, PromptVersion>(
    seeds.map((s) => [
      s.id,
      {
        id: s.id,
        key: s.key,
        kind: s.kind,
        registryId: s.id,
        version: initialPromptVersion(s.source.legacyVersion),
        status: 'published',
        body: s.body,
        contentHash: promptContentHash(s.body),
        sourceCommit: 'a'.repeat(40),
        legacyVersion: s.source.legacyVersion ?? null,
      },
    ]),
  );
  active = new Map<RegistryKey, string>(seeds.map((s) => [s.key, s.id]));
  owners = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  failWrite = false;
  failRead = false;
  activeReads = 0;
  handle(sql: string, v: unknown[] = []) {
    this.calls.push(sql);
    if (sql.includes('select r.key, v.id from prompt_registry r'))
      return { rows: ACTIVE_FRAGMENT_KEYS.map((key) => ({ key, id: this.active.get(key) })) };
    if (sql.includes('active_version_id as "activeVersionId"')) {
      if (this.failRead) throw new Error('Mock Prompt DB unavailable');
      this.activeReads++;
      return {
        rows: this.active.has(v[0] as RegistryKey)
          ? [{ activeVersionId: this.active.get(v[0] as RegistryKey) }]
          : [],
      };
    }
    if (sql.includes('from prompt_versions v join prompt_registry')) {
      if (this.failRead) throw new Error('Mock Prompt DB unavailable');
      const value = this.versions.get(String(v[0]));
      return { rows: value ? [structuredClone(value)] : [] };
    }
    const table = sql.match(
      /(?:from|update) (stage4_runs|discovery_runs|discovery_candidates|raw_articles)\b/,
    )?.[1];
    const owner = `${table}:${v[0]}`;
    if (table && sql.includes(' as value ')) {
      return { rows: [{ value: structuredClone(this.owners.get(owner) ?? {}) }] };
    }
    if (
      table &&
      sql.startsWith('update') &&
      (sql.includes('to_jsonb($2::text)') ||
        (sql.includes('$3::jsonb') && Array.isArray(v[1])) ||
        (sql.includes('|| $2::jsonb') && v.length === 2))
    ) {
      if (this.failWrite) throw new Error('Mock binding persistence failed');
      const value = structuredClone(this.owners.get(owner) ?? {});
      if (sql.includes('to_jsonb($2::text)')) {
        const attempt = value.promptAttempt as Record<string, unknown> | undefined;
        if (attempt?.status !== 'running') return { rows: [], rowCount: 0 };
        value.promptAttempt = { ...attempt, status: v[1] };
      } else if (v.length === 2) Object.assign(value, JSON.parse(String(v[1])));
      else {
        const map = JSON.parse(String(v[2]));
        const path = v[1] as string[];
        if (!path.length) {
          this.owners.set(owner, map);
          return { rows: [], rowCount: 1 };
        }
        value[path[0]] = map;
      }
      this.owners.set(owner, value);
      return { rows: [], rowCount: 1 };
    }
    return undefined;
  }
  db: Pool = {
    query: async (sql: string, v: unknown[] = []) => this.handle(sql, v) ?? { rows: [] },
    connect: async () => ({
      query: async (sql: string, v: unknown[] = []) => this.handle(sql, v) ?? { rows: [] },
      release() {},
    }),
  } as unknown as Pool;
}
/** Decorate existing business fixtures, without a static fallback in production. */
export function attachPromptMemory<T>(db: T, prompts = new PromptMemory()): T {
  const original = db as unknown as Pool;
  return {
    ...db,
    query: async (sql: string, v: unknown[] = []) =>
      prompts.handle(sql, v) ?? original.query(sql, v),
    connect: async () => {
      const client = await original.connect();
      return {
        query: async (sql: string, v: unknown[] = []) =>
          prompts.handle(sql, v) ?? client.query(sql, v),
        release: () => client.release(),
      };
    },
  } as T;
}

/** Active-pointer snapshot rows for business-only DB fixtures. No network or production data. */
export function systemFragmentFixtureQuery(sql: string) {
  if (!sql.includes('select r.key, v.id from prompt_registry r')) return undefined;
  return {
    rows: ACTIVE_FRAGMENT_KEYS.map((key, i) => ({
      key,
      id: `00000000-0000-4000-8000-00000000090${i}`,
    })),
  };
}
