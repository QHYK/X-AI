/** Bounded per-attempt Stage 3 state. No Prompt text, model responses or article bodies. */
import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { readBindings, updateRunFile, readSystemFragmentFile } from '../lib/prompts/run-file.js';
import { getPromptVersion } from '../lib/prompts/registry.js';
import type { PromptKey, SystemFragmentSnapshot } from '../lib/prompts/contracts.js';
import { isDeepStrictEqual as sameFragmentSnapshot } from 'node:util';

type Queryable = Pick<Pool | PoolClient, 'query'>;
export type Stage3Section =
  'event_ranking' | 'consolidation' | 'digest_ranking' | 'long_form_ranking';
export type Stage3Step = Record<string, unknown> & {
  status: 'running' | 'success' | 'failed' | 'skipped';
  input_hash?: string;
  prompt_version_id?: string | null;
  system_fragment_versions?: SystemFragmentSnapshot | null;
};
export const stage3Hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const stage3Error = (error: unknown) =>
  (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+|sk-[\w-]+/gi, '[REDACTED]')
    .slice(0, 1500);

/** SQL merges only one section/category; concurrent updates never read and replace the whole JSON. */
export async function writeStage3Step(
  db: Queryable,
  runId: string,
  section: Stage3Section,
  category: string | null,
  step: Stage3Step,
) {
  const result = await db.query(
    `update pipeline_runs set details = jsonb_set(details, array[$2::text],
       case when $3::text is null then $4::jsonb else
         coalesce(details->$2::text,'{}'::jsonb) || jsonb_build_object($3::text,$4::jsonb) end), updated_at=now()
     where id=$1::uuid and step='stage3' and status='running'`,
    [runId, section, category, JSON.stringify(step)],
  );
  if (result.rowCount !== 1) throw new Error('Stage3 durable step record could not be saved.');
}
export async function stage3Checkpoints(
  db: Queryable,
  dailyDate: string,
  section: Stage3Section,
  category: string | null = null,
) {
  const rows = await db.query<{ id: string; detail: Stage3Step }>(
    `select id, case when $3::text is null then details->$2::text else details->$2::text->$3::text end as detail
     from pipeline_runs where daily_date=$1::date and step='stage3'
       and details ? $2::text order by started_at desc,id desc`,
    [dailyDate, section, category],
  );
  return rows.rows.filter((r) => r.detail && ['success', 'skipped'].includes(r.detail.status));
}
/** Restore proven UUIDs before any request in the attempt binds an Active version. */
export async function restoreStage3Prompt(
  db: Queryable,
  path: string,
  key: PromptKey,
  step: Stage3Step,
) {
  if (!step.prompt_version_id) return;
  const prompt = await getPromptVersion(db, step.prompt_version_id);
  if (prompt.key !== key || prompt.status !== 'published')
    throw new Error('Invalid resumed Stage3 Prompt version.');
  const parent = process.env.DAILY_PROMPT_RUN_PATH;
  if (parent && step.system_fragment_versions) {
    const parentSnapshot = await readSystemFragmentFile(parent);
    if (parentSnapshot && !sameFragmentSnapshot(parentSnapshot, step.system_fragment_versions))
      throw new Error('Stage3 recovery conflicts with the parent Daily Fragment snapshot.');
  }
  await updateRunFile(path, (old) => {
    const bindings = readBindings(old);
    if (bindings[key] && bindings[key] !== prompt.id)
      throw new Error('Conflicting Stage3 Request binding.');
    if (
      Object.keys(bindings).length &&
      step.system_fragment_versions &&
      !sameFragmentSnapshot(old.systemFragmentVersions, step.system_fragment_versions)
    )
      throw new Error('Conflicting Stage3 Fragment recovery snapshot.');
    return {
      ...old,
      ...(step.system_fragment_versions
        ? { systemFragmentVersions: step.system_fragment_versions }
        : {}),
      promptVersionIds: { ...bindings, [key]: prompt.id },
      promptVersions: {
        ...((old.promptVersions as Record<string, string>) ?? {}),
        [key]: `v${prompt.version}`,
      },
    };
  });
}
