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

type EventSnapshot = {
  id: string;
  event_date: string;
  title: string;
  ai_rank: number | null;
  display_rank: number | null;
};

const DAY_1 = "2026-08-18";
const DAY_2 = "2026-08-19";
const EVENT_COUNT = 10;

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
    const processedContentIds = await loadEventProcessedContentIds(client);

    const day1 = await persistStage4Events(client, {
      previousCreatedEventIds: [],
      events: sampleEvents("DAY1", DAY_1, processedContentIds),
    });
    const day1Snapshot = await loadEventSnapshots(client, day1.createdEventIds);

    const day2Old = await persistStage4Events(client, {
      previousCreatedEventIds: [],
      events: sampleEvents("DAY2_OLD", DAY_2, processedContentIds),
    });

    checks.push({
      name: "Cross-date append keeps Day 1 and creates Day 2",
      passed:
        day1.createdEventIds.length === EVENT_COUNT &&
        day2Old.createdEventIds.length === EVENT_COUNT &&
        day2Old.previousDeletedCount === 0 &&
        (await countExistingEvents(client, [...day1.createdEventIds, ...day2Old.createdEventIds])) ===
          EVENT_COUNT * 2,
    });

    const day2New = await persistStage4Events(client, {
      previousCreatedEventIds: day2Old.createdEventIds,
      events: sampleEvents("DAY2_NEW", DAY_2, processedContentIds),
    });
    const day1AfterDay2Rebuild = await loadEventSnapshots(client, day1.createdEventIds);

    checks.push({
      name: "Same-date rebuild replaces only Day 2",
      passed:
        snapshotsEqual(day1Snapshot, day1AfterDay2Rebuild) &&
        (await countExistingEvents(client, day1.createdEventIds)) === EVENT_COUNT &&
        (await countExistingEvents(client, day2Old.createdEventIds)) === 0 &&
        (await countExistingEvents(client, day2New.createdEventIds)) === EVENT_COUNT &&
        (await countExistingEvents(client, [...day1.createdEventIds, ...day2New.createdEventIds])) ===
          EVENT_COUNT * 2 &&
        day2New.previousDeletedCount === EVENT_COUNT &&
        day2New.cleanupEventCount === EVENT_COUNT &&
        JSON.stringify(day2New.cleanupEventDates) === JSON.stringify([DAY_2]),
      detail: {
        previousDeletedCount: day2New.previousDeletedCount,
        cleanupEventCount: day2New.cleanupEventCount,
        cleanupEventDates: day2New.cleanupEventDates,
      },
    });

    let guardError: string | null = null;
    await client.query("savepoint cross_date_guard");
    try {
      await persistStage4Events(client, {
        previousCreatedEventIds: [...day1.createdEventIds, ...day2New.createdEventIds],
        events: sampleEvents("DAY2_GUARD", DAY_2, processedContentIds),
      });
    } catch (error) {
      guardError = error instanceof Error ? error.message : String(error);
      await client.query("rollback to savepoint cross_date_guard");
    }

    checks.push({
      name: "Cross-date delete guard fails loudly",
      passed:
        guardError !== null &&
        guardError.includes("Refusing to delete Stage 4 Events outside the current rebuild scope") &&
        (await countExistingEvents(client, day1.createdEventIds)) === EVENT_COUNT &&
        (await countExistingEvents(client, day2New.createdEventIds)) === EVENT_COUNT,
      detail: guardError,
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

async function loadEventProcessedContentIds(client: PoolClient): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `
      select id
      from processed_contents
      where routing = 'event'
      order by id
      limit $1
    `,
    [EVENT_COUNT],
  );

  if (result.rows.length === 0) {
    throw new Error("Need at least one event processed_content row for Stage 4 persistence tests.");
  }

  return result.rows.map((row) => row.id);
}

function sampleEvents(
  prefix: string,
  eventDate: string,
  processedContentIds: string[],
): Stage4EventToPersist[] {
  return Array.from({ length: EVENT_COUNT }, (_, index) => ({
    eventGroupId: `${prefix}_${index + 1}`,
    eventReviewItemId: null,
    processedContentIds: [processedContentIds[index % processedContentIds.length]],
    aiRank: index + 1,
    displayRank: index + 1,
    eventDate,
    output: sampleOutput(`${prefix}_${index + 1}`),
  }));
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

async function loadEventSnapshots(
  client: PoolClient,
  eventIds: string[],
): Promise<EventSnapshot[]> {
  const result = await client.query<EventSnapshot>(
    `
      select id, event_date::text, title, ai_rank, display_rank
      from events
      where id = any($1::uuid[])
      order by id
    `,
    [eventIds],
  );

  return result.rows;
}

async function countExistingEvents(
  client: PoolClient,
  eventIds: string[],
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `
      select count(*) as count
      from events
      where id = any($1::uuid[])
    `,
    [eventIds],
  );

  return Number(result.rows[0]?.count ?? 0);
}

function snapshotsEqual(left: EventSnapshot[], right: EventSnapshot[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
