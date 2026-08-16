import type { Pool, PoolClient } from "pg";

type Queryable = Pick<Pool | PoolClient, "query">;

export type RankingPersistenceUpdate = {
  processedContentId: string;
  rank: number;
};

export type Stage3PersistencePlan = {
  ranked: RankingPersistenceUpdate[];
  staleProcessedContentIds: string[];
};

export type Stage3PersistenceResult = {
  rankedUpdated: number;
  staleCleared: number;
};

export function nextDisplayRankForAiRankUpdate(
  oldAiRank: number | null,
  oldDisplayRank: number | null,
  newAiRank: number,
): number | null {
  if (oldDisplayRank === null) {
    return newAiRank;
  }

  if (oldAiRank !== null && oldDisplayRank === oldAiRank) {
    return newAiRank;
  }

  return oldDisplayRank;
}

export function nextDisplayRankForStaleClear(
  oldAiRank: number | null,
  oldDisplayRank: number | null,
): number | null {
  if (oldDisplayRank === null) {
    return null;
  }

  if (oldAiRank !== null && oldDisplayRank === oldAiRank) {
    return null;
  }

  return oldDisplayRank;
}

export async function persistStage3Ranks(
  client: Queryable,
  plan: Stage3PersistencePlan,
): Promise<Stage3PersistenceResult> {
  let rankedUpdated = 0;
  let staleCleared = 0;

  for (const update of plan.ranked) {
    const result = await client.query(
      `
        update processed_contents
        set
          ai_rank = $2,
          display_rank = case
            when display_rank is null then $2
            when ai_rank is not null and display_rank = ai_rank then $2
            else display_rank
          end,
          updated_at = now()
        where id = $1::uuid
      `,
      [update.processedContentId, update.rank],
    );
    rankedUpdated += result.rowCount ?? 0;
  }

  if (plan.staleProcessedContentIds.length > 0) {
    const result = await client.query(
      `
        update processed_contents
        set
          ai_rank = null,
          display_rank = case
            when display_rank is null then null
            when ai_rank is not null and display_rank = ai_rank then null
            else display_rank
          end,
          updated_at = now()
        where id = any($1::uuid[])
      `,
      [plan.staleProcessedContentIds],
    );
    staleCleared = result.rowCount ?? 0;
  }

  return {
    rankedUpdated,
    staleCleared,
  };
}
