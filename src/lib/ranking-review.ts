/**
 * Human Review 排序提交的纯业务规则与事务 persistence。
 *
 * 只为用户主动触碰且最终 rank 改变的 item 写 feedback；被动位移只更新 display_rank。
 */
import type { Pool, PoolClient } from "pg";
import { resolveDailyScope } from "./daily-scope.js";
import {
  EVENT_DISPLAY_CUTOFF,
  LONG_FORM_DISPLAY_CUTOFF,
} from "./ranking-config.js";

export type RankingFeedbackType = "ranking_error" | "false_positive" | "false_negative";

export type RankingRow = {
  id: string;
  aiRank: number;
  displayRank: number;
};

export type RankingChange = RankingRow & {
  nextDisplayRank: number;
};

export type RankingFeedbackChange = {
  id: string;
  aiRank: number;
  beforeRank: number;
  afterRank: number;
  feedbackType: RankingFeedbackType;
};

export type RankingChangeSet = {
  changes: RankingChange[];
  feedback: RankingFeedbackChange[];
};

export class ReviewValidationError extends Error {}

/** 根据一次主动移动是否跨越正式展示 cutoff，推导 Ranking Feedback 类型。 */
export function classifyRankingFeedback(
  beforeRank: number,
  afterRank: number,
  cutoff: number,
): RankingFeedbackType {
  if (beforeRank > cutoff && afterRank <= cutoff) {
    return "false_negative";
  }
  if (beforeRank <= cutoff && afterRank > cutoff) {
    return "false_positive";
  }
  return "ranking_error";
}

/** 校验完整排序并生成 display rank 更新和仅针对 touched item 的 feedback。 */
export function buildRankingChangeSet(options: {
  currentRows: RankingRow[];
  orderedIds: string[];
  touchedIds: string[];
  cutoff: number;
}): RankingChangeSet {
  if (options.currentRows.length === 0) {
    throw new ReviewValidationError("Review scope has no ranked items.");
  }
  const currentById = new Map(options.currentRows.map((row) => [row.id, row]));
  assertUniqueIds(options.orderedIds, "orderedIds");
  assertUniqueIds(options.touchedIds, "touchedIds");

  if (options.orderedIds.length !== options.currentRows.length) {
    throw new ReviewValidationError("orderedIds must contain every item in the review scope.");
  }
  for (const id of options.orderedIds) {
    if (!currentById.has(id)) {
      throw new ReviewValidationError(`Item ${id} does not belong to this review scope.`);
    }
  }
  for (const id of options.touchedIds) {
    if (!currentById.has(id)) {
      throw new ReviewValidationError(`Touched item ${id} does not belong to this review scope.`);
    }
  }

  const touched = new Set(options.touchedIds);
  const changes = options.orderedIds.map((id, index) => ({
    ...currentById.get(id)!,
    nextDisplayRank: index + 1,
  }));
  const feedback = changes.flatMap((change): RankingFeedbackChange[] => {
    if (!touched.has(change.id) || change.displayRank === change.nextDisplayRank) {
      return [];
    }
    return [
      {
        id: change.id,
        aiRank: change.aiRank,
        beforeRank: change.displayRank,
        afterRank: change.nextDisplayRank,
        feedbackType: classifyRankingFeedback(
          change.displayRank,
          change.nextDisplayRank,
          options.cutoff,
        ),
      },
    ];
  });

  return { changes, feedback };
}

/** 保存一个 Event Review snapshot 的完整新顺序。 */
export async function saveEventReviewRanking(
  pool: Pool,
  input: {
    dailyDate: string;
    reviewRunId: string;
    orderedIds: string[];
    touchedIds: string[];
  },
): Promise<{ updatedCount: number; feedbackCount: number }> {
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      id: string;
      ai_rank: number;
      display_rank: number;
    }>(
      `
        select id, ai_rank, display_rank
        from event_review_items
        where review_run_id = $1::uuid
          and daily_date = $2::date
        order by display_rank, id
        for update
      `,
      [input.reviewRunId, input.dailyDate],
    );
    const changeSet = buildRankingChangeSet({
      currentRows: result.rows.map((row) => ({
        id: row.id,
        aiRank: row.ai_rank,
        displayRank: row.display_rank,
      })),
      orderedIds: input.orderedIds,
      touchedIds: input.touchedIds,
      cutoff: EVENT_DISPLAY_CUTOFF,
    });

    // 唯一索引下先移到负数空间，再写连续正 rank，避免交换时的中间 collision。
    await client.query(
      `
        update event_review_items
        set display_rank = -display_rank, updated_at = now()
        where review_run_id = $1::uuid
          and daily_date = $2::date
      `,
      [input.reviewRunId, input.dailyDate],
    );
    await persistDisplayRanks(client, "event_review_items", changeSet.changes);
    await persistFeedback(client, "event_review_item", changeSet.feedback);
    return {
      updatedCount: changeSet.changes.length,
      feedbackCount: changeSet.feedback.length,
    };
  });
}

/** 保存一个 Daily scope 内所有已参与排名的 Long-form 新顺序。 */
export async function saveLongFormReviewRanking(
  pool: Pool,
  input: {
    dailyDate: string;
    orderedIds: string[];
    touchedIds: string[];
  },
): Promise<{ updatedCount: number; feedbackCount: number }> {
  const scope = resolveDailyScope(input.dailyDate);
  return withTransaction(pool, async (client) => {
    const result = await client.query<{
      id: string;
      ai_rank: number;
      display_rank: number;
    }>(
      `
        select pc.id, pc.ai_rank, pc.display_rank
        from processed_contents pc
        join raw_articles ra on ra.id = pc.raw_article_id
        where pc.routing = 'long_form'
          and pc.ai_rank is not null
          and pc.display_rank is not null
          and ra.published_at >= $1::timestamptz
          and ra.published_at < $2::timestamptz
        order by pc.display_rank, pc.id
        for update of pc
      `,
      [scope.startAt, scope.endAt],
    );
    const changeSet = buildRankingChangeSet({
      currentRows: result.rows.map((row) => ({
        id: row.id,
        aiRank: row.ai_rank,
        displayRank: row.display_rank,
      })),
      orderedIds: input.orderedIds,
      touchedIds: input.touchedIds,
      cutoff: LONG_FORM_DISPLAY_CUTOFF,
    });

    await persistDisplayRanks(client, "processed_contents", changeSet.changes);
    await persistFeedback(client, "processed_content", changeSet.feedback);
    return {
      updatedCount: changeSet.changes.length,
      feedbackCount: changeSet.feedback.length,
    };
  });
}

async function persistDisplayRanks(
  client: Pick<PoolClient, "query">,
  table: "event_review_items" | "processed_contents",
  changes: RankingChange[],
): Promise<void> {
  for (const change of changes) {
    await client.query(
      `update ${table} set display_rank = $2, updated_at = now() where id = $1::uuid`,
      [change.id, change.nextDisplayRank],
    );
  }
}

async function persistFeedback(
  client: Pick<PoolClient, "query">,
  targetType: "event_review_item" | "processed_content",
  changes: RankingFeedbackChange[],
): Promise<void> {
  for (const change of changes) {
    await client.query(
      `
        insert into feedback (
          target_type, target_id, feedback_type, before_value, after_value
        )
        values ($1, $2::uuid, $3, $4::jsonb, $5::jsonb)
      `,
      [
        targetType,
        change.id,
        change.feedbackType,
        JSON.stringify({ rank: change.beforeRank }),
        JSON.stringify({ rank: change.afterRank }),
      ],
    );
  }
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

function assertUniqueIds(ids: string[], name: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new ReviewValidationError(`${name} must not contain duplicate IDs.`);
  }
}
