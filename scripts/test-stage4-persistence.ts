import { config } from "dotenv";
import { Pool, type PoolClient } from "pg";
import {
  persistStage4Events,
  type Stage4EventToPersist,
} from "../src/processing/stage4-persistence.js";
import type { Stage4EventEnrichmentOutput } from "../src/processing/stage4-contract.js";

config({ path: ".env" });
config({ path: ".env.local", override: true });

type Check = {
  name: string;
  passed: boolean;
  detail?: unknown;
};

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for Stage 4 persistence tests.");
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });

  const client = await pool.connect();
  const checks: Check[] = [];
  try {
    await client.query("begin");
    const processedContentIds = await loadTwoEventProcessedContentIds(client);
    const [firstProcessedContentId, secondProcessedContentId] = processedContentIds;

    const firstRun = await persistStage4Events(client, {
      previousCreatedEventIds: [],
      events: [sampleEvent("EV_TEST_A", [firstProcessedContentId], 3)],
    });
    const firstEventId = firstRun.createdEventIds[0];
    const firstEvent = await loadEventRow(client, firstEventId);
    const firstAssociation = await loadProcessedContentEventId(client, firstProcessedContentId);

    checks.push({
      name: "A. first run creates event and association",
      passed:
        firstRun.createdEventIds.length === 1 &&
        firstRun.associations[0]?.updated_count === 1 &&
        firstAssociation === firstEventId,
    });
    checks.push({
      name: "D. external_context false persists as null",
      passed: firstEvent.externalContext === null,
    });
    checks.push({
      name: "E. rank writes ai_rank and display_rank",
      passed: firstEvent.aiRank === 3 && firstEvent.displayRank === 3,
      detail: firstEvent,
    });
    checks.push({
      name: "F. event_tags/event_tags_zh map to tags/tags_zh",
      passed:
        JSON.stringify(firstEvent.tags) === JSON.stringify(["test-tag"]) &&
        JSON.stringify(firstEvent.tagsZh) === JSON.stringify(["测试标签"]),
      detail: firstEvent,
    });

    const rebuild = await persistStage4Events(client, {
      previousCreatedEventIds: firstRun.createdEventIds,
      events: [sampleEvent("EV_TEST_B", [secondProcessedContentId], 2)],
    });
    const rebuiltEventId = rebuild.createdEventIds[0];
    checks.push({
      name: "B. rebuild unlinks/deletes previous derived event and relinks current event",
      passed:
        rebuild.previousDeletedCount === 1 &&
        rebuild.createdEventIds.length === 1 &&
        (await eventExists(client, firstEventId)) === false &&
        (await loadProcessedContentEventId(client, firstProcessedContentId)) === null &&
        (await loadProcessedContentEventId(client, secondProcessedContentId)) === rebuiltEventId,
    });

    await client.query("savepoint stage4_rollback_case");
    try {
      await persistStage4Events(client, {
        previousCreatedEventIds: rebuild.createdEventIds,
        events: [sampleEvent("EV_TEST_C", [firstProcessedContentId], 1)],
      });
      throw new Error("Simulated failure after Stage 4 persistence.");
    } catch {
      await client.query("rollback to savepoint stage4_rollback_case");
    }

    checks.push({
      name: "C. rollback preserves previous events and associations",
      passed:
        (await eventExists(client, rebuiltEventId)) === true &&
        (await loadProcessedContentEventId(client, secondProcessedContentId)) === rebuiltEventId,
    });

    await client.query("rollback");
  } finally {
    client.release();
    await pool.end();
  }

  const failures = checks.filter((check) => !check.passed);
  console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

async function loadTwoEventProcessedContentIds(client: PoolClient): Promise<[string, string]> {
  const result = await client.query<{ id: string }>(
    `
      select id
      from processed_contents
      where routing = 'event'
      order by id
      limit 2
    `,
  );

  if (result.rows.length < 2) {
    throw new Error("Need at least two event processed_contents rows for Stage 4 persistence tests.");
  }

  return [result.rows[0].id, result.rows[1].id];
}

function sampleEvent(
  eventGroupId: string,
  processedContentIds: string[],
  rank: number,
): Stage4EventToPersist {
  return {
    eventGroupId,
    processedContentIds,
    rank,
    eventDate: "2026-08-16",
    output: sampleOutput(eventGroupId),
  };
}

function sampleOutput(eventGroupId: string): Stage4EventEnrichmentOutput {
  return {
    event_title: `Test Event ${eventGroupId}`,
    event_title_zh: `测试事件 ${eventGroupId}`,
    event_tags: ["test-tag"],
    event_tags_zh: ["测试标签"],
    event_entities: ["Test Entity"],
    event_entities_zh: ["测试实体"],
    event_summary: "Test summary.",
    event_summary_zh: "测试摘要。",
    source_perspectives: [
      {
        source: "Test Source",
        summary: "测试来源摘要。",
      },
    ],
    external_context: {
      performed: false,
      sources: [],
      sources_summary: "",
    },
  };
}

async function loadEventRow(
  client: PoolClient,
  id: string,
): Promise<{
  tags: string[] | null;
  tagsZh: string[] | null;
  externalContext: unknown | null;
  aiRank: number | null;
  displayRank: number | null;
}> {
  const result = await client.query<{
    tags: string[] | null;
    tagsZh: string[] | null;
    externalContext: unknown | null;
    aiRank: number | null;
    displayRank: number | null;
  }>(
    `
      select
        tags,
        tags_zh as "tagsZh",
        external_context as "externalContext",
        ai_rank as "aiRank",
        display_rank as "displayRank"
      from events
      where id = $1::uuid
    `,
    [id],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Missing test event ${id}.`);
  }

  return row;
}

async function loadProcessedContentEventId(
  client: PoolClient,
  processedContentId: string,
): Promise<string | null> {
  const result = await client.query<{ eventId: string | null }>(
    `
      select event_id as "eventId"
      from processed_contents
      where id = $1::uuid
    `,
    [processedContentId],
  );

  return result.rows[0]?.eventId ?? null;
}

async function eventExists(client: PoolClient, eventId: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      select exists(select 1 from events where id = $1::uuid)
    `,
    [eventId],
  );

  return result.rows[0]?.exists === true;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
