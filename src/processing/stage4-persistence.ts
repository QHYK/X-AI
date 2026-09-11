/**
 * Stage 4 Event 的事务内重建与关联写入。
 * 仅清理当前重建日期范围内的旧 Event，防止重跑误删除其他历史期次的数据。
 */
import type { Pool, PoolClient } from "pg";
import type { Stage4EventEnrichmentOutput } from "./stage4-contract.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage4EventToPersist = {
  eventGroupId: string;
  eventReviewItemId: string | null;
  processedContentIds: string[];
  aiRank: number;
  displayRank: number;
  eventDate: string;
  output: Stage4EventEnrichmentOutput;
};

export type Stage4PersistencePlan = {
  previousCreatedEventIds: string[];
  events: Stage4EventToPersist[];
};

export type Stage4PersistenceResult = {
  previousUnlinkedCount: number;
  previousDeletedCount: number;
  cleanupEventCount: number;
  cleanupEventDates: string[];
  createdEventIds: string[];
  eventGroupToEventId: Record<string, string>;
  associations: Array<{
    event_group_id: string;
    event_id: string;
    processed_content_ids: string[];
    updated_count: number;
  }>;
};

export type Stage4SelectedEvent = {
  reviewRunId: string;
  reviewItemId: string;
  eventGroupId: string;
  eventHint: string;
  aiRank: number;
  displayRank: number;
  processedContentIds: string[];
};

export async function loadLatestStage4Selection(
  queryable: Queryable,
  dailyDate: string,
  limit: number,
): Promise<Stage4SelectedEvent[]> {
  const snapshot = await queryable.query<{ review_run_id: string }>(`
    select review_run_id from event_review_items
    where daily_date = $1::date
    group by review_run_id
    order by max(created_at) desc
    limit 1`, [dailyDate]);
  const reviewRunId = snapshot.rows[0]?.review_run_id;
  if (!reviewRunId) return [];
  const result = await queryable.query<Stage4SelectedEvent>(`
    select eri.review_run_id as "reviewRunId", eri.id as "reviewItemId",
           eri.event_group_id as "eventGroupId", eri.event_hint as "eventHint",
           eri.ai_rank as "aiRank", eri.display_rank as "displayRank",
           array_agg(egi.processed_content_id order by egi.processed_content_id) as "processedContentIds"
    from event_review_items eri
    join event_group_items egi on egi.event_group_id = eri.event_group_id
    where eri.review_run_id = $1::uuid and eri.daily_date = $2::date
    group by eri.review_run_id, eri.id, eri.event_group_id, eri.event_hint, eri.ai_rank, eri.display_rank
    order by eri.display_rank asc, eri.id asc
    limit $3`, [reviewRunId, dailyDate, limit]);
  return result.rows;
}

export async function loadOrCreateStage4Run(
  pool: Pool,
  dailyDate: string,
  reviewRunId: string,
  expectedCount: number,
): Promise<{ id: string; successCount: number; status: string }> {
  const existing = await pool.query<{ id: string; success_count: number; status: string }>(`
    select id, success_count, status from stage4_runs where review_run_id = $1::uuid`, [reviewRunId]);
  if (existing.rows[0]) return {
    id: existing.rows[0].id,
    successCount: existing.rows[0].success_count,
    status: existing.rows[0].status,
  };
  const created = await pool.query<{ id: string; success_count: number; status: string }>(`
    insert into stage4_runs (daily_date, review_run_id, status, expected_count)
    values ($1::date, $2::uuid, 'running', $3)
    returning id, success_count, status`, [dailyDate, reviewRunId, expectedCount]);
  const row = created.rows[0];
  if (!row) throw new Error("Failed to create Stage 4 run.");
  return { id: row.id, successCount: row.success_count, status: row.status };
}

export async function loadDraftReviewItemIds(queryable: Queryable, stage4RunId: string): Promise<Set<string>> {
  const result = await queryable.query<{ event_review_item_id: string }>(`
    select event_review_item_id from events
    where stage4_run_id = $1::uuid and publication_status = 'draft'`, [stage4RunId]);
  return new Set(result.rows.map((row) => row.event_review_item_id));
}

/** A successful enrichment is durable immediately; draft rows never change live source associations. */
export async function persistStage4Draft(
  pool: Pool,
  stage4RunId: string,
  event: Stage4EventToPersist,
): Promise<boolean> {
  const result = await pool.query(`
    insert into events (event_date, title, title_zh, tags, tags_zh, entities, entities_zh,
      summary, summary_zh, source_perspectives, external_context, event_review_item_id,
      stage4_run_id, publication_status, ai_rank, display_rank)
    values ($1::date, $2, $3, $4::text[], $5::text[], $6::text[], $7::text[], $8, $9,
      $10::jsonb, $11::jsonb, $12::uuid, $13::uuid, 'draft', $14, $15)
    on conflict (stage4_run_id, event_review_item_id) do nothing`, [
    event.eventDate, event.output.event_title, event.output.event_title_zh,
    event.output.event_tags, event.output.event_tags_zh, event.output.event_entities,
    event.output.event_entities_zh, event.output.event_summary, event.output.event_summary_zh,
    JSON.stringify(event.output.source_perspectives), toExternalContextJson(event.output),
    event.eventReviewItemId, stage4RunId, event.aiRank, event.displayRank,
  ]);
  return (result.rowCount ?? 0) === 1;
}

/** Publish is the only operation that changes live Events and processed_contents.event_id. */
export async function publishStage4Run(pool: Pool, stage4RunId: string): Promise<{ publishedCount: number; associationCount: number }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const run = await client.query<{ daily_date: string; expected_count: number }>(`
      select daily_date::text, expected_count from stage4_runs where id = $1::uuid for update`, [stage4RunId]);
    const row = run.rows[0];
    if (!row) throw new Error("Stage 4 run not found.");
    const drafts = await client.query<{ count: string }>(`select count(*) as count from events where stage4_run_id=$1::uuid and publication_status='draft'`, [stage4RunId]);
    if (Number(drafts.rows[0]?.count ?? 0) !== row.expected_count) throw new Error("Stage 4 run does not have every expected draft.");
    const old = await client.query<{ id: string }>(`
      select e.id from events e join stage4_runs r on r.id=e.stage4_run_id
      where r.daily_date=$1::date and e.publication_status='published' for update`, [row.daily_date]);
    const oldIds = old.rows.map((item) => item.id);
    if (oldIds.length) {
      await client.query(`update processed_contents set event_id=null, updated_at=now() where event_id=any($1::uuid[])`, [oldIds]);
      await client.query(`update events set publication_status='archived', updated_at=now() where id=any($1::uuid[])`, [oldIds]);
    }
    const published = await client.query(`update events set publication_status='published', updated_at=now() where stage4_run_id=$1::uuid and publication_status='draft'`, [stage4RunId]);
    const associations = await client.query(`
      update processed_contents pc set event_id=e.id, updated_at=now()
      from events e join event_review_items eri on eri.id=e.event_review_item_id
      join event_group_items egi on egi.event_group_id=eri.event_group_id
      where e.stage4_run_id=$1::uuid and e.publication_status='published' and pc.id=egi.processed_content_id`, [stage4RunId]);
    await client.query(`update stage4_runs set status='success', success_count=$2, completed_at=now() where id=$1::uuid`, [stage4RunId, row.expected_count]);
    await client.query("commit");
    return { publishedCount: published.rowCount ?? 0, associationCount: associations.rowCount ?? 0 };
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

export async function updateStage4RunProgress(pool: Pool, stage4RunId: string, status: "running" | "partial" | "failed") {
  const result = await pool.query<{ count: string }>(`select count(*) as count from events where stage4_run_id=$1::uuid and publication_status='draft'`, [stage4RunId]);
  await pool.query(`update stage4_runs set status=$2, success_count=$3, completed_at=case when $2 in ('partial','failed') then now() else completed_at end where id=$1::uuid`, [stage4RunId, status, Number(result.rows[0]?.count ?? 0)]);
}

/**
 * 删除本次可证明同 scope 的旧 Event 后插入新结果，并回写 processed_contents.event_id。
 * 由调用方包裹事务，任一步失败都会整体回滚。
 */
export async function persistStage4Events(
  client: Queryable,
  plan: Stage4PersistencePlan,
): Promise<Stage4PersistenceResult> {
  let previousUnlinkedCount = 0;
  let previousDeletedCount = 0;
  let cleanupEventCount = 0;
  let cleanupEventDates: string[] = [];

  if (plan.previousCreatedEventIds.length > 0) {
    const previousEvents = await loadExistingPreviousEvents(
      client,
      plan.previousCreatedEventIds,
    );
    const rebuildEventDates = uniqueSorted(plan.events.map((event) => event.eventDate));
    cleanupEventDates = uniqueSorted(previousEvents.map((event) => event.event_date));
    cleanupEventCount = previousEvents.length;
    const outOfScopeEventDates = cleanupEventDates.filter(
      (eventDate) => !rebuildEventDates.includes(eventDate),
    );
    if (outOfScopeEventDates.length > 0) {
      throw new Error(
        [
          "Refusing to delete Stage 4 Events outside the current rebuild scope.",
          `rebuild_event_dates=${rebuildEventDates.join(",") || "none"}`,
          `cleanup_event_dates=${cleanupEventDates.join(",")}`,
        ].join(" "),
      );
    }

    const unlinkResult = await client.query(
      `
        update processed_contents
        set event_id = null, updated_at = now()
        where event_id = any($1::uuid[])
      `,
      [plan.previousCreatedEventIds],
    );
    previousUnlinkedCount = unlinkResult.rowCount ?? 0;

    const deleteResult = await client.query(
      `
        delete from events
        where id = any($1::uuid[])
      `,
      [plan.previousCreatedEventIds],
    );
    previousDeletedCount = deleteResult.rowCount ?? 0;
  }

  const createdEventIds: string[] = [];
  const eventGroupToEventId: Record<string, string> = {};
  const associations: Stage4PersistenceResult["associations"] = [];

  for (const event of plan.events) {
    const insertResult = await client.query<{ id: string }>(
      `
        insert into events (
          event_date,
          title,
          title_zh,
          tags,
          tags_zh,
          entities,
          entities_zh,
          summary,
          summary_zh,
          source_perspectives,
          external_context,
          event_review_item_id,
          ai_rank,
          display_rank
        )
        values (
          $1::date,
          $2,
          $3,
          $4::text[],
          $5::text[],
          $6::text[],
          $7::text[],
          $8,
          $9,
          $10::jsonb,
          $11::jsonb,
          $12::uuid,
          $13,
          $14
        )
        returning id
      `,
      [
        event.eventDate,
        event.output.event_title,
        event.output.event_title_zh,
        event.output.event_tags,
        event.output.event_tags_zh,
        event.output.event_entities,
        event.output.event_entities_zh,
        event.output.event_summary,
        event.output.event_summary_zh,
        JSON.stringify(event.output.source_perspectives),
        toExternalContextJson(event.output),
        event.eventReviewItemId,
        event.aiRank,
        event.displayRank,
      ],
    );
    const eventId = insertResult.rows[0]?.id;
    if (!eventId) {
      throw new Error(`Failed to insert event for ${event.eventGroupId}.`);
    }

    createdEventIds.push(eventId);
    eventGroupToEventId[event.eventGroupId] = eventId;

    const updateResult = await client.query(
      `
        update processed_contents
        set event_id = $1::uuid, updated_at = now()
        where id = any($2::uuid[])
      `,
      [eventId, event.processedContentIds],
    );

    associations.push({
      event_group_id: event.eventGroupId,
      event_id: eventId,
      processed_content_ids: event.processedContentIds,
      updated_count: updateResult.rowCount ?? 0,
    });
  }

  return {
    previousUnlinkedCount,
    previousDeletedCount,
    cleanupEventCount,
    cleanupEventDates,
    createdEventIds,
    eventGroupToEventId,
    associations,
  };
}

async function loadExistingPreviousEvents(
  client: Queryable,
  eventIds: string[],
): Promise<Array<{ id: string; event_date: string }>> {
  const result = await client.query<{ id: string; event_date: string }>(
    `
      select id, event_date::text
      from events
      where id = any($1::uuid[])
      order by event_date, id
    `,
    [eventIds],
  );

  return result.rows;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function toExternalContextJson(output: Stage4EventEnrichmentOutput): string | null {
  if (output.external_context.performed === false) {
    return null;
  }

  return JSON.stringify({
    sources: output.external_context.sources,
    summary: output.external_context.sources_summary,
  });
}
