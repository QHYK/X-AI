import { captureSystemFragments, readSystemFragmentSnapshot } from './system-fragments.js';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { getPromptVersion } from './registry.js';
import { withPromptBindings, type PromptBindings, type BindPrompt } from './runtime.js';

const writes = new Map<string, Promise<unknown>>();
async function readRun(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}
/** Serialize writers in this process. Daily parent waits for its Stage child; no extra file lock. */
export function updateRunFile(
  path: string,
  update: (
    old: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>,
): Promise<void> {
  const next = (writes.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const value = await update(await readRun(path));
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    });
  writes.set(path, next);
  void next
    .finally(() => {
      if (writes.get(path) === next) writes.delete(path);
    })
    .catch(() => {});
  return next;
}
/** Labels are for reading; precise IDs remain the only Resume binding source. */
function readMap(value: unknown): PromptBindings {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.values(value).some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('Invalid run.json Prompt mapping.');
  return value as PromptBindings;
}
export function readBindings(run: Record<string, unknown>): PromptBindings {
  const ids = readMap(run.promptVersionIds ?? run.promptVersions ?? {});
  if (Object.values(ids).some((id) => /^v\d+$/.test(id!)))
    throw new Error('Readable Prompt version has no precise UUID binding.');
  return ids;
}
function readLabels(run: Record<string, unknown>): PromptBindings {
  if (run.promptVersionIds === undefined) return {}; // Older artifacts contain UUIDs in promptVersions.
  const labels = readMap(run.promptVersions ?? {});
  if (Object.values(labels).some((label) => !/^v[1-9]\d*$/.test(label!)))
    throw new Error('Invalid readable Prompt version.');
  return labels;
}
function mergeBindings(old: Record<string, unknown>, incoming: Record<string, unknown>) {
  const ids = { ...readBindings(old) };
  const labels = { ...readLabels(old) };
  for (const [key, id] of Object.entries(readBindings(incoming))) {
    if (ids[key as keyof PromptBindings] && ids[key as keyof PromptBindings] !== id)
      throw new Error('Cannot overwrite an existing run.json Prompt binding.');
    ids[key as keyof PromptBindings] = id;
  }
  for (const [key, label] of Object.entries(readLabels(incoming))) {
    if (!ids[key as keyof PromptBindings]) throw new Error('Prompt label is missing its UUID.');
    if (labels[key as keyof PromptBindings] && labels[key as keyof PromptBindings] !== label)
      throw new Error('Conflicting readable Prompt version.');
    labels[key as keyof PromptBindings] = label;
  }
  const value: Record<string, unknown> = {
    ...incoming,
    ...(old.systemFragmentVersions ? { systemFragmentVersions: old.systemFragmentVersions } : {}),
    promptVersions: labels,
    promptVersionIds: ids,
  };
  // Keep existing diagnostic aliases readable as well (e.g. Stage2's singular prompt_version).
  const labelFor = (id: unknown) => Object.entries(ids).find(([, bound]) => bound === id)?.[0];
  const single = labelFor(value.prompt_version);
  if (single && labels[single as keyof PromptBindings]) {
    value.prompt_version_id = value.prompt_version;
    value.prompt_version = labels[single as keyof PromptBindings];
  }
  return value;
}
export function writeRunFile(path: string, value: Record<string, unknown>): Promise<void> {
  return updateRunFile(path, (old) => mergeBindings(old, value));
}
export async function readRunBindings(path: string): Promise<PromptBindings> {
  return readBindings(await readRun(path));
}
export function filePromptBinder(
  path: string,
  db: Pick<Pool, 'query'>,
  mirror?: string,
): BindPrompt {
  const binder: BindPrompt = async (key, active) => {
    let id = '';
    let label = '';
    await updateRunFile(path, async (old) => {
      id = readBindings(old)[key] ?? (await active());
      const version = await getPromptVersion(db, id);
      if (version.key !== key || version.status !== 'published')
        throw new Error('Invalid file Prompt binding.');
      label = `v${version.version}`;
      return mergeBindings(old, {
        ...old,
        promptVersions: { ...readLabels(old), [key]: label },
        promptVersionIds: { ...readBindings(old), [key]: id },
      });
    });
    if (mirror && mirror !== path)
      await updateRunFile(mirror, (old) =>
        mergeBindings(old, {
          ...old,
          promptVersions: { ...readLabels(old), [key]: label },
          promptVersionIds: { ...readBindings(old), [key]: id },
        }),
      );
    return id;
  };
  binder.systemFragments = async () =>
    readSystemFragmentSnapshot((await readRun(path)).systemFragmentVersions);
  return binder;
}
export async function withFilePrompts<T>(db: Pool, path: string, work: () => Promise<T>) {
  await initializeSystemFragmentFile(path, db, process.env.DAILY_PROMPT_RUN_PATH);
  return withPromptBindings(
    db,
    filePromptBinder(path, db, process.env.DAILY_PROMPT_RUN_PATH),
    work,
  );
}
/** Only new files get a fresh snapshot; historical files are never retroactively stamped. */
export async function initializeSystemFragmentFile(
  path: string,
  db: Pick<Pool, 'query'>,
  parent?: string,
  newRun = false,
) {
  await updateRunFile(path, async (old) => {
    if (old.systemFragmentVersions !== undefined) {
      readSystemFragmentSnapshot(old.systemFragmentVersions);
      return old;
    }
    if (!newRun && Object.keys(old).length > 0) return old;
    const snapshot =
      parent && parent !== path
        ? readSystemFragmentSnapshot((await readRun(parent)).systemFragmentVersions)
        : await captureSystemFragments(db);
    return { ...old, ...(snapshot ? { systemFragmentVersions: snapshot } : {}) };
  });
}
export async function readSystemFragmentFile(path: string) {
  return readSystemFragmentSnapshot((await readRun(path)).systemFragmentVersions);
}

export async function inheritRunPrompt(
  path: string,
  priorPath: string,
  key: keyof PromptBindings,
  db?: Pick<Pool, 'query'>,
) {
  const previous = await readRun(priorPath);
  const prior = readBindings(previous)[key];
  if (!prior) return; // Legacy artifacts have no provable version; never invent one for reused output.
  let label = readLabels(previous)[key];
  if (!label && db) {
    const version = await getPromptVersion(db, prior);
    if (version.key !== key || version.status !== 'published')
      throw new Error('Invalid resumed Prompt binding.');
    label = `v${version.version}`;
  }
  await updateRunFile(path, (old) => {
    if (
      previous.systemFragmentVersions &&
      old.systemFragmentVersions &&
      JSON.stringify(previous.systemFragmentVersions) !== JSON.stringify(old.systemFragmentVersions)
    )
      throw new Error(
        'Cannot reuse ranking from a different System Fragment snapshot. Start a fresh ranking attempt.',
      );
    return mergeBindings(old, {
      ...old,
      ...(previous.systemFragmentVersions
        ? { systemFragmentVersions: previous.systemFragmentVersions }
        : {}),
      promptVersionIds: { ...readBindings(old), [key]: prior },
      promptVersions: { ...readLabels(old), ...(label ? { [key]: label } : {}) },
    });
  });
}
export function runPath(stage: string, startedAt: Date, root = process.cwd()) {
  return join(
    root,
    `runtime/${stage}`,
    startedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-'),
    'run.json',
  );
}

export function observeRunPrompts(
  path: string,
  db: Pick<Pool, 'query'>,
  mirror = process.env.DAILY_PROMPT_RUN_PATH,
) {
  return async (key: keyof PromptBindings, id: string) => {
    const recorded = await filePromptBinder(path, db, mirror)(key, async () => id);
    if (recorded !== id)
      throw new Error('Stage4 file mirror conflicts with authoritative database Prompt binding.');
  };
}
