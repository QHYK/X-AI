/**
 * Stage 3 Event Ranking snapshot 的构造与事务持久化。
 *
 * snapshot 只保存排名、Event hint 与成员 ID；Review 展示内容继续关联现有业务表读取。
 */
import type { Pool, PoolClient } from "pg";
import type {
  Stage3EventRankedOutput,
  Stage3EventRankingInput,
} from "./stage3-contract.js";
import { MAX_STAGE3_EVENT_RANKINGS } from "./stage3-contract.js";

type Queryable = Pick<PoolClient, "query">;

export type EventReviewSnapshotItem = {
  reviewRunId: string;
  dailyDate: string;
  eventTempId: string;
  eventHint: string;
  aiRank: number;
  displayRank: number;
  memberContentIds: string[];
};

/** 将完整 Event Ranking 输出转换成一个独立、不可混淆的 Review snapshot。 */
export function buildEventReviewSnapshotItems(options: {
  reviewRunId: string;
  dailyDate: string;
  rankingOutput: Stage3EventRankedOutput;
  eventInput: Stage3EventRankingInput;
  eventIdMap: Record<string, string[]>;
}): EventReviewSnapshotItem[] {
  if (options.rankingOutput.rankings.length > MAX_STAGE3_EVENT_RANKINGS) {
    throw new Error(`Event Review snapshot cannot exceed ${MAX_STAGE3_EVENT_RANKINGS} items.`);
  }
  const eventById = new Map(options.eventInput.events.map((event) => [event.id, event]));
  return [...options.rankingOutput.rankings]
    .sort((left, right) => left.rank - right.rank)
    .map((ranking) => {
      const event = eventById.get(ranking.id);
      if (!event) {
        throw new Error(`Event Ranking output references unknown event id ${ranking.id}.`);
      }
      const memberContentIds = options.eventIdMap[ranking.id];
      if (!memberContentIds) {
        throw new Error(`Event Ranking id-map is missing members for ${ranking.id}.`);
      }

      return {
        reviewRunId: options.reviewRunId,
        dailyDate: options.dailyDate,
        eventTempId: ranking.id,
        eventHint: event.event_hint,
        aiRank: ranking.rank,
        displayRank: ranking.rank,
        memberContentIds,
      };
    });
}

/** 原子写入一个 snapshot；任一 item 失败时整组回滚。 */
export async function persistEventReviewSnapshot(
  pool: Pool,
  items: EventReviewSnapshotItem[],
): Promise<number> {
  if (items.length === 0) {
    return 0;
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await insertEventReviewSnapshotItems(client, items);
    await client.query("commit");
    return inserted;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function insertEventReviewSnapshotItems(
  queryable: Queryable,
  items: EventReviewSnapshotItem[],
): Promise<number> {
  let inserted = 0;
  for (const item of items) {
    const result = await queryable.query(
      `
        insert into event_review_items (
          review_run_id,
          daily_date,
          event_temp_id,
          event_hint,
          ai_rank,
          display_rank,
          member_content_ids
        )
        values ($1::uuid, $2::date, $3, $4, $5, $6, $7::uuid[])
      `,
      [
        item.reviewRunId,
        item.dailyDate,
        item.eventTempId,
        item.eventHint,
        item.aiRank,
        item.displayRank,
        item.memberContentIds,
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}
