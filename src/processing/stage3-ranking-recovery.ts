import type { Pool } from 'pg';
import { stage3Checkpoints, stage3Hash } from './stage3-progress.js';
import type { Stage3EventRankingInput, Stage3RankingOutput } from './stage3-contract.js';

export async function reusableEventCheckpoint(
  pool: Pool,
  date: string,
  hash: string,
  input: Stage3EventRankingInput,
  idMap: Record<string, string[]>,
) {
  for (const prior of await stage3Checkpoints(pool, date, 'event_ranking')) {
    const d = prior.detail;
    if (
      d.input_hash !== hash ||
      d.id_map_hash !== stage3Hash(idMap) ||
      typeof d.review_run_id !== 'string' ||
      !Array.isArray(d.ordered_ids)
    )
      continue;
    const ids = d.ordered_ids as string[];
    if (
      ids.length > 50 ||
      (input.events.length > 0 && !ids.length) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !input.events.some((e) => e.id === id))
    )
      continue;
    const review = await pool.query<{
      event_group_id: string;
      ai_rank: number;
      member_content_ids: string[];
    }>(
      'select event_group_id,ai_rank,member_content_ids from event_review_items where review_run_id=$1::uuid and daily_date=$2::date order by ai_rank',
      [d.review_run_id, date],
    );
    if (
      review.rows.length !== ids.length ||
      !review.rows.every(
        (r, i) =>
          r.event_group_id === ids[i] &&
          r.ai_rank === i + 1 &&
          stage3Hash([...r.member_content_ids].sort()) ===
            stage3Hash([...(idMap[r.event_group_id] ?? [])].sort()),
      )
    )
      continue;
    return {
      ...prior,
      reviewRunId: d.review_run_id,
      output: { rankings: ids.map((id, i) => ({ id, rank: i + 1 })) },
    };
  }
  return null;
}
export async function reusableLongFormCheckpoint(
  pool: Pool,
  date: string,
  hash: string,
  idMap: Record<string, string>,
) {
  for (const prior of await stage3Checkpoints(pool, date, 'long_form_ranking')) {
    const d = prior.detail;
    if (
      d.input_hash !== hash ||
      d.id_map_hash !== stage3Hash(idMap) ||
      !Array.isArray(d.ranked_ids)
    )
      continue;
    const ids = d.ranked_ids as string[];
    const inverse = new Map(Object.entries(idMap).map(([temp, id]) => [id, temp]));
    if (
      ids.length !== inverse.size ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !inverse.has(id))
    )
      continue;
    const actual = await pool.query<{ id: string; ai_rank: number }>(
      "select id,ai_rank from processed_contents where daily_date=$1::date and routing='long_form' and id=any($2::uuid[])",
      [date, ids],
    );
    if (
      actual.rows.length !== ids.length ||
      !ids.every((id, i) => actual.rows.some((r) => r.id === id && r.ai_rank === i + 1))
    )
      continue;
    const output: Stage3RankingOutput = {
      rankings: ids.map((id, i) => ({ id: inverse.get(id)!, rank: i + 1 })),
    };
    return { ...prior, output };
  }
  return null;
}
