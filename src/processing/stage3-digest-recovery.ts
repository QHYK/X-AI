/** Digest-only recovery records live in pipeline_runs.metrics and commit with business ranks. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { DIGEST_CATEGORY_KEYS } from '../lib/daily-brief.js';
import type { SystemFragmentSnapshot } from '../lib/prompts/contracts.js';
import type { Stage3DigestRankingInput } from '../prompts/stage3-digest-ranking.js';
import { validateStage3RankingIntegrity, type Stage3RankingOutput } from './stage3-contract.js';
import {
  persistStage3Ranks,
  type Stage3PersistencePlan,
  type Stage3PersistenceResult,
} from './stage3-persistence.js';
import { lockDigestOrder } from '../lib/digest-order.js';

export type DigestCategoryWarning = {
  type: 'invalid_digest_category';
  processed_content_id: string;
  original_category: string;
  corrected_category: 'General';
};
export type DigestCheckpoint = {
  status: 'success';
  category: string;
  input_hash: string;
  prompt_version_id: string | null;
  system_fragment_versions: SystemFragmentSnapshot | null;
  ranked_ids: string[];
  execution?: DigestCategoryProgress;
};
export type DigestCategoryProgress = {
  category: string;
  input_hash: string;
  status: 'success' | 'failed' | 'skipped';
  reused: 'database' | 'artifact' | null;
  source_run_id?: string;
  llm_calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  warning_count: number;
  error: string | null;
};
export function stableDigestHash(input: Stage3DigestRankingInput, idMap: Record<string, string>) {
  // Serialize only effective model fields and the candidate identity mapping, in input order.
  return createHash('sha256')
    .update(
      JSON.stringify({
        category: input.category,
        candidates: input.candidates.map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          source: c.source,
          ...(c.publication !== undefined ? { publication: c.publication } : {}),
          processed_content_id: idMap[c.id],
        })),
      }),
    )
    .digest('hex');
}
export function sameFragmentSnapshot(a: unknown, b: unknown) {
  const keys = ['xfield.identity', 'daily_brief.editorial', 'discover.editorial'];
  if (!a || !b) return !a && !b;
  return keys.every(
    (key) => (a as Record<string, unknown>)[key] === (b as Record<string, unknown>)[key],
  );
}
// Digest ordered_ids is already converted into id/rank pairs; reason is optional in that stored form.
const StoredDigestRanking = z.object({
  rankings: z.array(
    z.object({ id: z.string(), rank: z.number().int().positive(), reason: z.string().optional() }),
  ),
});
export function strictDigestOutput(
  raw: unknown,
  input: Stage3DigestRankingInput,
): Stage3RankingOutput | null {
  const parsed = StoredDigestRanking.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.rankings.length !== input.candidates.length ||
    !validateStage3RankingIntegrity(
      parsed.data,
      input.candidates.map((c) => c.id),
    ).passed
  )
    return null;
  return { rankings: [...parsed.data.rankings].sort((a, b) => a.rank - b.rank) };
}
export async function correctInvalidDigestCategories(
  pool: Pick<Pool, 'query'>,
  dailyDate: string,
): Promise<DigestCategoryWarning[]> {
  const result = await pool.query<{ id: string; original_category: string }>(
    `
    with invalid as materialized (
      select pc.id,pc.category from processed_contents pc join raw_articles ra on ra.id=pc.raw_article_id
      where pc.daily_date=$1::date and pc.routing='digest' and ra.stage1_status='selected'
        and not (pc.category=any($2::text[])) for update of pc
    )
    update processed_contents pc set category='General',updated_at=now() from invalid i
    where pc.id=i.id and pc.daily_date=$1::date and pc.routing='digest' and pc.category=i.category
    returning pc.id,i.category as original_category`,
    [dailyDate, [...DIGEST_CATEGORY_KEYS]],
  );
  return result.rows.map((r) => ({
    type: 'invalid_digest_category',
    processed_content_id: r.id,
    original_category: r.original_category,
    corrected_category: 'General',
  }));
}
export async function persistDigestCategory(
  pool: Pool,
  runId: string,
  dailyDate: string,
  checkpoint: DigestCheckpoint,
  plan: Stage3PersistencePlan,
): Promise<Stage3PersistenceResult> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await lockDigestOrder(client);
    const ids = [...plan.ranked.map((r) => r.processedContentId), ...plan.staleProcessedContentIds];
    const scope = await client.query(
      `select id from processed_contents where id=any($1::uuid[]) and daily_date=$2::date
      and routing='digest' and category=$3 for update`,
      [ids, dailyDate, checkpoint.category],
    );
    if (scope.rows.length !== ids.length)
      throw new Error('Digest category membership changed during ranking.');
    const result = await persistStage3Ranks(client, plan);
    if (
      result.rankedUpdated !== plan.ranked.length ||
      result.staleCleared !== plan.staleProcessedContentIds.length
    )
      throw new Error('Digest category rows changed during persistence.');
    // Business ranks and the durable success marker are one commit, even if the process dies before run.json.
    const saved = await client.query(
      `update pipeline_runs set metrics=jsonb_set(metrics,'{stage3_digest_checkpoints}',
      coalesce(metrics->'stage3_digest_checkpoints','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)),updated_at=now()
      where id=$1::uuid and step='stage3' and daily_date=$4::date and status='running'`,
      [runId, checkpoint.category, JSON.stringify(checkpoint), dailyDate],
    );
    if (saved.rowCount !== 1)
      throw new Error('Stage3 durable category checkpoint could not be saved.');
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
export async function reusableDigestCheckpoint(
  pool: Pool,
  dailyDate: string,
  input: Stage3DigestRankingInput,
  idMap: Record<string, string>,
  inputHash: string,
  promptVersionId: string,
  snapshot: SystemFragmentSnapshot | undefined,
): Promise<Stage3RankingOutput | null> {
  const found = await pool.query<{ checkpoint: DigestCheckpoint }>(
    `select metrics->'stage3_digest_checkpoints'->$2::text as checkpoint from pipeline_runs
    where daily_date=$1::date and step='stage3' and metrics->'stage3_digest_checkpoints' ? $2::text
    order by started_at desc,id desc`,
    [dailyDate, input.category],
  );
  const byPcId = new Map(Object.entries(idMap).map(([id, pc]) => [pc, id]));
  for (const { checkpoint: c } of found.rows) {
    if (
      !c ||
      c.status !== 'success' ||
      c.category !== input.category ||
      c.input_hash !== inputHash ||
      c.prompt_version_id !== promptVersionId ||
      !sameFragmentSnapshot(c.system_fragment_versions, snapshot ?? null) ||
      !Array.isArray(c.ranked_ids)
    )
      continue;
    const output = strictDigestOutput(
      {
        rankings: c.ranked_ids.map((pc, index) => ({
          id: byPcId.get(pc) ?? '',
          rank: index + 1,
          reason: 'Reused persisted category ranking.',
        })),
      },
      input,
    );
    if (!output) continue;
    // Verify under the same short ranking lock used by writers. Never infer success from non-null ranks alone.
    const client = await pool.connect();
    try {
      await client.query('begin');
      await lockDigestOrder(client);
      const rows = await client.query<{ id: string; ai_rank: number }>(
        `select id,ai_rank from processed_contents
        where daily_date=$1::date and routing='digest' and category=$2 and id=any($3::uuid[])`,
        [dailyDate, input.category, c.ranked_ids],
      );
      const actual = new Map(rows.rows.map((r) => [r.id, r.ai_rank]));
      const valid =
        rows.rows.length === c.ranked_ids.length &&
        c.ranked_ids.every((pc, i) => actual.get(pc) === i + 1);
      await client.query('commit');
      if (valid) return output;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  return null;
}
/** Old PARTIAL files are evidence of paid output, not evidence of database success: revalidate then commit them. */
export async function reusableDigestArtifact(
  rootDir: string,
  currentDir: string,
  dailyDate: string,
  input: Stage3DigestRankingInput,
  idMap: Record<string, string>,
  inputHash: string,
  promptVersionId: string,
  snapshot: SystemFragmentSnapshot | undefined,
): Promise<(Stage3RankingOutput & { source_run_id: string }) | null> {
  let dirs;
  try {
    dirs = await readdir(join(rootDir, 'runtime/stage3'), { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const slug = input.category
    .toLowerCase()
    .replace(/&/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  for (const entry of dirs
    .filter((d) => d.isDirectory())
    .sort((a, b) => b.name.localeCompare(a.name))) {
    const dir = join(rootDir, 'runtime/stage3', entry.name);
    if (dir === currentDir) continue;
    try {
      const read = async (name: string) => JSON.parse(await readFile(join(dir, name), 'utf8'));
      const run = await read('run.json');
      if (
        run.run_id !== entry.name ||
        run.daily_date !== dailyDate ||
        run.promptVersionIds?.['daily.stage3.digest_ranking'] !== promptVersionId ||
        !sameFragmentSnapshot(run.systemFragmentVersions, snapshot)
      )
        continue;
      const previous = await read(`digest/${slug}-input.json`);
      const priorMap = (await read('id-map.json')).digest?.[input.category];
      if (!priorMap || stableDigestHash(previous, priorMap) !== inputHash) continue;
      const diagnostics = await read(`digest/${slug}-ranking-diagnostics.json`);
      if (
        diagnostics.category !== input.category ||
        diagnostics.input_count !== input.candidates.length
      )
        continue;
      const output = strictDigestOutput(await read(`digest/${slug}-ranking-output.json`), input);
      if (output) return { ...output, source_run_id: run.run_id };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      if (e instanceof SyntaxError || e instanceof TypeError) {
        console.warn('[stage3] Unusable Digest artifact:', dir, e.message);
        continue;
      }
      throw e;
    }
  }
  return null;
}
