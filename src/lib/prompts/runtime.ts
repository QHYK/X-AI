import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';
import { getActivePrompt, getPromptVersion, resolvePromptFragments } from './registry.js';
import { renderResolvedPrompt, type PromptKey, type PromptVersion } from './contracts.js';

export type PromptBindingState = 'new' | 'reused' | 'active';
export type PromptBindings = Partial<Record<PromptKey, string>>;
export type PromptDb = Pick<Pool | PoolClient, 'query'>;
export type BindPrompt = (
  key: PromptKey,
  active: (db?: PromptDb) => Promise<string>,
) => Promise<string>;
type Scope = {
  db: PromptDb;
  bind: BindPrompt;
  binding?: PromptBindingState;
  logged: Set<string>;
  versions: Map<
    PromptKey,
    Promise<{
      version: PromptVersion;
      binding: PromptBindingState;
      fragments: Awaited<ReturnType<typeof resolvePromptFragments>>;
    }>
  >;
};
const scopes = new AsyncLocalStorage<Scope>();
/** Only a request-local Prompt cache; it neither creates nor schedules business runs. */
export function withPromptBindings<T>(
  db: PromptDb,
  bind: BindPrompt,
  work: () => Promise<T>,
  logging: { binding?: PromptBindingState; logged?: Set<string> } = {},
): Promise<T> {
  return scopes.run(
    {
      db,
      bind,
      binding: logging.binding,
      logged: logging.logged ?? new Set(),
      versions: new Map(),
    },
    work,
  );
}
export function hasPromptBindings(): boolean {
  return !!scopes.getStore();
}
export function logPromptError(
  key: PromptKey,
  phase: 'context' | 'binding' | 'load' | 'render',
  logged?: Set<string>,
) {
  const marker = `error:${key}:${phase}`;
  if (logged?.has(marker)) return;
  logged?.add(marker);
  // Never forward error messages/objects: database and template errors can contain private data.
  console.error(`[prompt] key=${key} event=error phase=${phase}`);
}
export async function productionPrompt(
  key: PromptKey,
  input: string,
  options: {
    category?: string;
    variant?: string;
  } = {},
) {
  const scope = scopes.getStore();
  if (!scope) {
    logPromptError(key, 'context');
    throw new Error(`Missing persistent Prompt binding context: ${key}`);
  }
  let pending = scope.versions.get(key);
  if (!pending) {
    pending = (async () => {
      let phase: 'binding' | 'load' = 'binding';
      let selectedActive = false;
      try {
        const id = await scope.bind(key, async (db = scope.db) => {
          selectedActive = true;
          return (await getActivePrompt(db, key)).id;
        });
        // BindPrompt returns only after its persistence/mirror work succeeds.
        const binding = scope.binding ?? (selectedActive ? 'new' : 'reused');
        phase = 'load';
        const version = await getPromptVersion(scope.db, id);
        if (version.key !== key || version.kind !== 'request' || version.status !== 'published')
          throw new Error(`Invalid bound Prompt version for ${key}: ${id}`);
        const fragments = await resolvePromptFragments(scope.db, version);
        return { version, fragments, binding };
      } catch (error) {
        logPromptError(key, phase, scope.logged);
        throw error;
      }
    })();
    scope.versions.set(key, pending);
  }
  const { version, fragments, binding } = await pending;
  let rendered: ReturnType<typeof renderResolvedPrompt>;
  try {
    rendered = renderResolvedPrompt(
      version,
      fragments,
      { input, ...(options.category !== undefined ? { category: options.category } : {}) },
      options.variant,
    );
  } catch (error) {
    logPromptError(key, 'render', scope.logged);
    throw error;
  }
  const marker = `${key}:${version.id}`;
  if (!scope.logged.has(marker)) {
    scope.logged.add(marker);
    console.info(`[prompt] key=${key} version=${version.id} binding=${binding}`);
  }
  return { versionId: version.id, ...rendered, input: rendered.user! };
}

const CARRIERS = {
  discovery: { table: 'discovery_runs', column: 'config_snapshot', parent: 'promptVersions' },
  stage4: { table: 'stage4_runs', column: 'prompt_versions', parent: null },
  candidate: { table: 'discovery_candidates', column: 'evaluation', parent: 'promptVersions' },
  raw: { table: 'raw_articles', column: 'metadata', parent: 'promptVersions' },
} as const;
/** Existing row is locked only while choosing/saving a version; committed before any model call. */
export function databasePromptBinder(
  db: Pick<Pool, 'connect'>,
  carrier: keyof typeof CARRIERS,
  id: string,
  options: { fresh?: boolean; observe?: (key: PromptKey, id: string) => Promise<void> } = {},
): BindPrompt {
  const { table, column, parent } = CARRIERS[carrier];
  return async (key, active) => {
    const client = await db.connect();
    let versionId: string;
    try {
      await client.query('begin');
      const result = await client.query<{ value: Record<string, unknown> | null }>(
        `select ${column} as value from ${table} where id = $1::uuid for update`,
        [id],
      );
      if (!result.rows[0]) throw new Error(`Prompt binding owner not found: ${carrier}/${id}`);
      const value = result.rows[0].value ?? {};
      const bindings = parent ? value[parent] : value;
      if (
        bindings !== undefined &&
        (!bindings || typeof bindings !== 'object' || Array.isArray(bindings))
      )
        throw new Error('Invalid persisted Prompt bindings.');
      const previous = (bindings as PromptBindings | undefined)?.[key];
      if (previous !== undefined && (typeof previous !== 'string' || !previous))
        throw new Error('Invalid persisted Prompt version ID.');
      versionId = !options.fresh && previous ? previous : await active(client);
      const path = parent ? [parent] : [];
      const merged = { ...(bindings as PromptBindings | undefined), [key]: versionId };
      const updated = await client.query(
        parent
          ? `update ${table} set ${column} = jsonb_set(coalesce(${column}, '{}'::jsonb), $2::text[], $3::jsonb, true) where id = $1::uuid`
          : `update ${table} set ${column} = $3::jsonb where id = $1::uuid and $2::text[] = '{}'::text[]`,
        [id, path, JSON.stringify(merged)],
      );
      if (updated.rowCount !== 1) throw new Error('Prompt binding was not persisted.');
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
    await options.observe?.(key, versionId);
    return versionId;
  };
}

export function evaluationPromptBinder(
  db: Pick<Pool, 'connect'>,
  inputId: string,
  runId: string,
): BindPrompt {
  return async (key, active) => {
    const client = await db.connect();
    try {
      await client.query('begin');
      const owner = await client.query(
        'select id from evaluation_inputs where id = $1::uuid for update',
        [inputId],
      );
      if (!owner.rows.length) throw new Error('Evaluation input not found.');
      const existing = await client.query<{ prompt_version: string }>(
        `select prompt_version from evaluation_runs where evaluation_input_id = $1::uuid
         and prompt_version ~ '^[a-fA-F0-9-]{36}$' order by started_at, id`,
        [inputId],
      );
      if (new Set(existing.rows.map((row) => row.prompt_version)).size > 1)
        throw new Error('Evaluation input contains conflicting Prompt bindings.');
      const id = existing.rows[0]?.prompt_version ?? (await active(client));
      const version = await getPromptVersion(client, id);
      if (version.key !== key) throw new Error('Evaluation Prompt key mismatch.');
      const updated = await client.query(
        `update evaluation_runs set prompt_version = $2
        where evaluation_input_id = $1::uuid and status = 'running'
          and (prompt_version !~ '^[a-fA-F0-9-]{36}$' or prompt_version = $2) returning id`,
        [inputId, id],
      );
      if (!updated.rows.some((row) => row.id === runId))
        throw new Error('Evaluation binding conflict or run no longer running.');
      await client.query('commit');
      return id;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  };
}

export class PromptAttemptBusyError extends Error {}

/** A short transaction claim replaces the old transaction held across paid manual work. */
export async function claimManualPrompt(
  client: PoolClient,
  carrier: 'raw' | 'candidate',
  id: string,
  key: PromptKey,
  reuse: boolean,
) {
  try {
    const { table, column } = CARRIERS[carrier];
    const result = await client.query<{ value: Record<string, unknown> | null }>(
      `select ${column} as value from ${table} where id = $1::uuid for update`,
      [id],
    );
    if (!result.rows[0]) throw new Error('Prompt operation owner not found.');
    const value = result.rows[0].value ?? {};
    const state = value.promptAttempt as { status?: string; key?: string } | undefined;
    if (state?.status === 'running')
      throw new PromptAttemptBusyError(
        'Another generation attempt is still running; no model request was sent.',
      );
    const previous = (value.promptVersions as PromptBindings | undefined)?.[key];
    const version =
      reuse && previous
        ? await getPromptVersion(client, previous)
        : await getActivePrompt(client, key);
    if (version.key !== key || version.status !== 'published')
      throw new Error('Invalid manual Prompt binding.');
    await resolvePromptFragments(client, version);
    const updated = await client.query(
      `update ${table} set ${column} = coalesce(${column}, '{}'::jsonb) || $2::jsonb where id = $1::uuid`,
      [
        id,
        JSON.stringify({
          promptVersions: { ...(value.promptVersions as PromptBindings), [key]: version.id },
          promptAttempt: { key, status: 'running' },
        }),
      ],
    );
    if (updated.rowCount !== 1) throw new Error('Manual Prompt binding was not saved.');
    return version.id;
  } catch (error) {
    logPromptError(key, 'binding');
    throw error;
  }
}
export async function finishManualPrompt(
  db: PromptDb,
  carrier: 'raw' | 'candidate',
  id: string,
  status: 'failed' | 'completed',
) {
  const { table, column } = CARRIERS[carrier];
  const result = await db.query(
    `update ${table} set ${column} = jsonb_set(${column}, '{promptAttempt,status}', to_jsonb($2::text), true)
    where id = $1::uuid and ${column}->'promptAttempt'->>'status' = 'running'`,
    [id, status],
  );
  if (result.rowCount !== 1) throw new Error('Manual Prompt attempt status was not saved.');
}
