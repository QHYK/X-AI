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
import type { EnrichedStage4Event, Stage4EventGroup } from "../processing/stage4-event-processing.js";
import {
  persistStage4Events,
  type Stage4EventToPersist,
} from "../processing/stage4-persistence.js";

type Queryable = Pick<Pool | PoolClient, "query">;

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

type EventReviewRow = RankingRow & {
  eventHint: string;
  memberContentIds: string[];
};

type EventReviewLinks = {
  eventIdByReviewItemId: Map<string, string>;
  legacyLinks: Array<{ reviewItemId: string; eventId: string }>;
};

/** 在 transaction 外预检最终 Top 15，返回需要按需执行 Stage 4 的 Event Group。 */
export async function getEventReviewEnrichmentRequests(
  pool: Pool,
  input: {
    dailyDate: string;
    reviewRunId: string;
    orderedIds: string[];
    touchedIds: string[];
  },
): Promise<Stage4EventGroup[]> {
  const rows = await loadEventReviewRows(pool, input, false);
  const changeSet = buildRankingChangeSet({
    currentRows: rows,
    orderedIds: input.orderedIds,
    touchedIds: input.touchedIds,
    cutoff: EVENT_DISPLAY_CUTOFF,
  });
  const links = await loadEventReviewLinks(pool, rows, false);

  return changeSet.changes
    .filter((change) => change.nextDisplayRank <= EVENT_DISPLAY_CUTOFF)
    .filter((change) => !links.eventIdByReviewItemId.has(change.id))
    .map((change) => {
      const row = rows.find((candidate) => candidate.id === change.id)!;
      return {
        eventGroupId: row.id,
        eventReviewItemId: row.id,
        eventHint: row.eventHint,
        aiRank: row.aiRank,
        displayRank: change.nextDisplayRank,
        processedContentIds: row.memberContentIds,
      };
    });
}

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
    enrichedEvents?: EnrichedStage4Event[];
  },
): Promise<{
  updatedCount: number;
  feedbackCount: number;
  eventsUpdated: number;
  eventsCreated: number;
}> {
  return withTransaction(pool, async (client) => {
    const rows = await loadEventReviewRows(client, input, true);
    const changeSet = buildRankingChangeSet({
      currentRows: rows,
      orderedIds: input.orderedIds,
      touchedIds: input.touchedIds,
      cutoff: EVENT_DISPLAY_CUTOFF,
    });
    const links = await loadEventReviewLinks(client, rows, true);
    await backfillLegacyEventReviewLinks(client, links.legacyLinks);

    const missingTopIds = changeSet.changes
      .filter((change) => change.nextDisplayRank <= EVENT_DISPLAY_CUTOFF)
      .filter((change) => !links.eventIdByReviewItemId.has(change.id))
      .map((change) => change.id);
    const enrichedByReviewItemId = new Map(
      (input.enrichedEvents ?? []).flatMap((event) =>
        event.group.eventReviewItemId ? [[event.group.eventReviewItemId, event]] : [],
      ),
    );
    if (!sameIdSet(missingTopIds, [...enrichedByReviewItemId.keys()])) {
      throw new ReviewValidationError(
        "Review ranking changed while enrichment was in progress. Reload and save again.",
      );
    }

    let eventsCreated = 0;
    if (missingTopIds.length > 0) {
      const persisted = await persistStage4Events(client, {
        previousCreatedEventIds: [],
        events: missingTopIds.map((reviewItemId) =>
          toReviewStage4EventToPersist(enrichedByReviewItemId.get(reviewItemId)!),
        ),
      });
      eventsCreated = persisted.createdEventIds.length;
      for (const reviewItemId of missingTopIds) {
        const eventId = persisted.eventGroupToEventId[reviewItemId];
        if (!eventId) {
          throw new Error(`Stage 4 persistence did not create Event for Review item ${reviewItemId}.`);
        }
        links.eventIdByReviewItemId.set(reviewItemId, eventId);
      }
    }

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
    let eventsUpdated = 0;
    for (const change of changeSet.changes) {
      const eventId = links.eventIdByReviewItemId.get(change.id);
      if (!eventId) {
        continue;
      }
      const update = await client.query(
        `update events set display_rank = $2, updated_at = now() where id = $1::uuid`,
        [eventId, change.nextDisplayRank],
      );
      eventsUpdated += update.rowCount ?? 0;
    }
    await persistFeedback(client, "event_review_item", changeSet.feedback);
    return {
      updatedCount: changeSet.changes.length,
      feedbackCount: changeSet.feedback.length,
      eventsUpdated,
      eventsCreated,
    };
  });
}

/** 读取指定 snapshot 的完整排序项；保存时以 row lock 固定短 transaction 内的基线。 */
async function loadEventReviewRows(
  queryable: Queryable,
  input: { dailyDate: string; reviewRunId: string },
  lockRows: boolean,
): Promise<EventReviewRow[]> {
  const result = await queryable.query<{
    id: string;
    ai_rank: number;
    display_rank: number;
    event_hint: string;
    member_content_ids: string[];
  }>(
    `
      select id, ai_rank, display_rank, event_hint, member_content_ids
      from event_review_items
      where review_run_id = $1::uuid
        and daily_date = $2::date
      order by display_rank, id
      ${lockRows ? "for update" : ""}
    `,
    [input.reviewRunId, input.dailyDate],
  );
  return result.rows.map((row) => ({
    id: row.id,
    aiRank: row.ai_rank,
    displayRank: row.display_rank,
    eventHint: row.event_hint,
    memberContentIds: row.member_content_ids,
  }));
}

/**
 * 优先按显式 event_review_item_id 建立关联；旧数据仅在完整成员集合唯一匹配时作为 fallback。
 * 保存时会把这种确定性 fallback 补写成正式关联，之后不再依赖成员集合推断。
 */
async function loadEventReviewLinks(
  queryable: Queryable,
  rows: EventReviewRow[],
  lockEvents: boolean,
): Promise<EventReviewLinks> {
  if (rows.length === 0) {
    return { eventIdByReviewItemId: new Map(), legacyLinks: [] };
  }
  const reviewItemIds = rows.map((row) => row.id);
  const memberContentIds = [...new Set(rows.flatMap((row) => row.memberContentIds))];
  const lockClause = lockEvents ? "for update of e" : "";
  const direct = await queryable.query<{ id: string; event_review_item_id: string }>(
    `
      select e.id, e.event_review_item_id
      from events e
      where e.event_review_item_id = any($1::uuid[])
      ${lockClause}
    `,
    [reviewItemIds],
  );
  const eventIdByReviewItemId = new Map(
    direct.rows.map((row) => [row.event_review_item_id, row.id]),
  );
  if (memberContentIds.length === 0) {
    return { eventIdByReviewItemId, legacyLinks: [] };
  }

  const legacyCandidates = await queryable.query<{ id: string }>(
    `
      select e.id
      from events e
      join processed_contents pc on pc.event_id = e.id
      where e.event_review_item_id is null
        and pc.id = any($1::uuid[])
      ${lockClause}
    `,
    [memberContentIds],
  );
  const candidateEventIds = [...new Set(legacyCandidates.rows.map((row) => row.id))];
  if (candidateEventIds.length === 0) {
    return { eventIdByReviewItemId, legacyLinks: [] };
  }
  const members = await queryable.query<{ event_id: string; id: string }>(
    `
      select event_id, id
      from processed_contents
      where event_id = any($1::uuid[])
      order by event_id, id
    `,
    [candidateEventIds],
  );
  const memberIdsByEvent = new Map<string, string[]>();
  for (const member of members.rows) {
    const ids = memberIdsByEvent.get(member.event_id) ?? [];
    ids.push(member.id);
    memberIdsByEvent.set(member.event_id, ids);
  }

  const legacyLinks: EventReviewLinks["legacyLinks"] = [];
  for (const row of rows) {
    if (eventIdByReviewItemId.has(row.id)) {
      continue;
    }
    const exactMatches = candidateEventIds.filter((eventId) =>
      sameIdSet(memberIdsByEvent.get(eventId) ?? [], row.memberContentIds),
    );
    if (exactMatches.length === 1) {
      eventIdByReviewItemId.set(row.id, exactMatches[0]);
      legacyLinks.push({ reviewItemId: row.id, eventId: exactMatches[0] });
    }
  }
  return { eventIdByReviewItemId, legacyLinks };
}

/** 首次 Review 保存时，将唯一的 legacy 成员匹配转成明确外键。 */
async function backfillLegacyEventReviewLinks(
  client: Pick<PoolClient, "query">,
  links: EventReviewLinks["legacyLinks"],
): Promise<void> {
  for (const link of links) {
    const result = await client.query(
      `
        update events
        set event_review_item_id = $2::uuid, updated_at = now()
        where id = $1::uuid
          and event_review_item_id is null
      `,
      [link.eventId, link.reviewItemId],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new ReviewValidationError("A legacy Event association changed; reload and save again.");
    }
  }
}

function toReviewStage4EventToPersist(event: EnrichedStage4Event): Stage4EventToPersist {
  const reviewItemId = event.group.eventReviewItemId;
  if (!reviewItemId) {
    throw new Error("Review-triggered Stage 4 enrichment requires an event_review_item_id.");
  }
  return {
    eventGroupId: reviewItemId,
    eventReviewItemId: reviewItemId,
    processedContentIds: event.group.processedContentIds,
    aiRank: event.group.aiRank,
    displayRank: event.group.displayRank,
    eventDate: event.eventDate.eventDate,
    output: event.output,
  };
}

function sameIdSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedRight = [...right].sort();
  return [...left].sort().every((id, index) => id === sortedRight[index]);
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
