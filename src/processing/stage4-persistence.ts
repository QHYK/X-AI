import type { Pool, PoolClient } from "pg";
import type { Stage4EventEnrichmentOutput } from "./stage4-contract.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type Stage4EventToPersist = {
  eventGroupId: string;
  processedContentIds: string[];
  rank: number;
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
  createdEventIds: string[];
  eventGroupToEventId: Record<string, string>;
  associations: Array<{
    event_group_id: string;
    event_id: string;
    processed_content_ids: string[];
    updated_count: number;
  }>;
};

export async function persistStage4Events(
  client: Queryable,
  plan: Stage4PersistencePlan,
): Promise<Stage4PersistenceResult> {
  let previousUnlinkedCount = 0;
  let previousDeletedCount = 0;

  if (plan.previousCreatedEventIds.length > 0) {
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
          $12,
          $12
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
        event.rank,
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
    createdEventIds,
    eventGroupToEventId,
    associations,
  };
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
