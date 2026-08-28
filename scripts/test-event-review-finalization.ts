import type { Pool, PoolClient } from "pg";
import {
  getEventReviewEnrichmentRequests,
  saveEventReviewRanking,
} from "../src/lib/ranking-review.js";
import type { EnrichedStage4Event } from "../src/processing/stage4-event-processing.js";

type Check = { name: string; passed: boolean; detail?: unknown };
const checks: Check[] = [];
const inputIds = rows().map((row) => row.id);

const internalMove = moveId(inputIds, idForRank(3), 8);
checks.push({
  name: "Top 15 internal reorder does not request a new Stage 4 enrichment",
  passed:
    (await getEventReviewEnrichmentRequests(createPlanningPool([]), {
      dailyDate: "2026-08-25",
      reviewRunId: runId(),
      orderedIds: internalMove,
      touchedIds: [idForRank(3)],
    })).length === 0,
});

const promoted = moveId(inputIds, idForRank(25), 6);
const promotionRequests = await getEventReviewEnrichmentRequests(createPlanningPool([25]), {
  dailyDate: "2026-08-25",
  reviewRunId: runId(),
  orderedIds: promoted,
  touchedIds: [idForRank(25)],
});
checks.push({
  name: "#25 → #6 requests exactly one missing Stage 4 Event with original AI rank",
  passed:
    promotionRequests.length === 1 &&
    promotionRequests[0]?.eventReviewItemId === idForRank(25) &&
    promotionRequests[0]?.aiRank === 25 &&
    promotionRequests[0]?.displayRank === 6,
});

checks.push({
  name: "an already enriched #20 → #5 reuses its Event instead of calling Stage 4",
  passed:
    (await getEventReviewEnrichmentRequests(createPlanningPool([]), {
      dailyDate: "2026-08-25",
      reviewRunId: runId(),
      orderedIds: moveId(inputIds, idForRank(20), 5),
      touchedIds: [idForRank(20)],
    })).length === 0,
});

const passivePromotion = moveId(inputIds, idForRank(5), 22);
const passiveRequests = await getEventReviewEnrichmentRequests(createPlanningPool([16]), {
  dailyDate: "2026-08-25",
  reviewRunId: runId(),
  orderedIds: passivePromotion,
  touchedIds: [idForRank(5)],
});
checks.push({
  name: "passively promoted #16 still requests Stage 4 without becoming touched feedback",
  passed:
    passiveRequests.length === 1 &&
    passiveRequests[0]?.eventReviewItemId === idForRank(16),
});

const savedLog: Array<{ text: string; values: unknown[] | undefined }> = [];
const savedResult = await saveEventReviewRanking(createSavePool(savedLog, []), {
  dailyDate: "2026-08-25",
  reviewRunId: runId(),
  orderedIds: internalMove,
  touchedIds: [idForRank(3)],
});
checks.push({
  name: "Top 15 internal reorder synchronizes Event display_rank and preserves ai_rank",
  passed:
    savedResult.eventsCreated === 0 &&
    savedResult.eventsUpdated === 30 &&
    savedResult.feedbackCount === 1 &&
    savedLog.filter((entry) => entry.text.startsWith("update events set display_rank")).length === 30 &&
    !savedLog.some((entry) => entry.text.includes("set ai_rank")),
});

const enrichmentFailureLog: Array<{ text: string; values: unknown[] | undefined }> = [];
try {
  await saveEventReviewRanking(createSavePool(enrichmentFailureLog, [25]), {
    dailyDate: "2026-08-25",
    reviewRunId: runId(),
    orderedIds: promoted,
    touchedIds: [idForRank(25)],
  });
  checks.push({ name: "missing enrichment blocks ranking commit", passed: false });
} catch {
  checks.push({
    name: "missing enrichment blocks Review, feedback and Brief-rank writes",
    passed:
      enrichmentFailureLog.some((entry) => entry.text === "rollback") &&
      !enrichmentFailureLog.some((entry) => entry.text.startsWith("update event_review_items")) &&
      !enrichmentFailureLog.some((entry) => entry.text.startsWith("insert into feedback")),
  });
}

const promotionLog: Array<{ text: string; values: unknown[] | undefined }> = [];
const promotionResult = await saveEventReviewRanking(createSavePool(promotionLog, [25]), {
  dailyDate: "2026-08-25",
  reviewRunId: runId(),
  orderedIds: promoted,
  touchedIds: [idForRank(25)],
  enrichedEvents: [fakeEnrichment(promotionRequests[0]!)],
});
const insertedEvent = promotionLog.find((entry) => entry.text.startsWith("insert into events"));
checks.push({
  name: "new Top 15 Event persists once with explicit Review link and final display rank",
  passed:
    promotionResult.eventsCreated === 1 &&
    promotionResult.feedbackCount === 1 &&
    insertedEvent?.values?.at(-3) === idForRank(25) &&
    insertedEvent.values?.at(-2) === 25 &&
    insertedEvent.values?.at(-1) === 6,
});

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
if (checks.some((check) => !check.passed)) {
  process.exitCode = 1;
}

function createPlanningPool(missingRanks: number[]): Pool {
  return { query: async (text: string, values?: unknown[]) => respondToReviewQuery(text, values, missingRanks) } as Pool;
}

function createSavePool(
  log: Array<{ text: string; values: unknown[] | undefined }>,
  missingRanks: number[],
): Pool {
  return {
    connect: async () => ({
      query: async (text: string, values?: unknown[]) => {
        const normalized = normalize(text);
        log.push({ text: normalized, values });
        if (normalized === "begin" || normalized === "commit" || normalized === "rollback") {
          return { rows: [], rowCount: 1 };
        }
        if (normalized.startsWith("insert into events")) {
          return { rows: [{ id: eventIdForRank(25) }], rowCount: 1 };
        }
        if (normalized.startsWith("update processed_contents")) {
          return { rows: [], rowCount: 1 };
        }
        return respondToReviewQuery(text, values, missingRanks);
      },
      release: () => undefined,
    } as unknown as PoolClient),
  } as Pool;
}

function respondToReviewQuery(text: string, _values: unknown[] | undefined, missingRanks: number[]) {
  const normalized = normalize(text);
  if (normalized.startsWith("select id, ai_rank, display_rank, event_hint, member_content_ids")) {
    return {
      rows: rows().map((row) => ({
        id: row.id,
        ai_rank: row.rank,
        display_rank: row.rank,
        event_hint: `Event ${row.rank}`,
        member_content_ids: [contentIdForRank(row.rank)],
      })),
    };
  }
  if (normalized.startsWith("select e.id, e.event_review_item_id")) {
    return {
      rows: rows()
        .filter((row) => !missingRanks.includes(row.rank))
        .map((row) => ({ id: eventIdForRank(row.rank), event_review_item_id: row.id })),
    };
  }
  if (normalized.startsWith("select e.id from events e join processed_contents")) {
    return { rows: [] };
  }
  if (normalized.startsWith("update event_review_items") || normalized.startsWith("update events set display_rank") || normalized.startsWith("insert into feedback")) {
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unexpected test query: ${normalized}`);
}

function fakeEnrichment(group: NonNullable<typeof promotionRequests[number]>): EnrichedStage4Event {
  return {
    group,
    input: { event_hint: group.eventHint, sources: [] },
    eventDate: { eventDate: "2026-08-25", source: "earliest_published_at" },
    publishedAtValues: [],
    llm: {} as EnrichedStage4Event["llm"],
    output: {
      event_title: "Event",
      event_title_zh: "事件",
      event_tags: [],
      event_tags_zh: [],
      event_entities: [],
      event_entities_zh: [],
      event_summary: "Summary",
      event_summary_zh: "摘要",
      source_perspectives: [],
      external_context: { performed: false, sources: [], sources_summary: "" },
    },
    toolUsage: { webSearchPerformed: false, webSearchCallCount: 0, sources: [], calls: [] },
  };
}

function rows(): Array<{ id: string; rank: number }> {
  return Array.from({ length: 30 }, (_, index) => ({ id: idForRank(index + 1), rank: index + 1 }));
}

function moveId(ids: string[], id: string, rank: number): string[] {
  const result = [...ids];
  const from = result.indexOf(id);
  result.splice(from, 1);
  result.splice(rank - 1, 0, id);
  return result;
}

function idForRank(rank: number): string {
  return `10000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
}

function contentIdForRank(rank: number): string {
  return `20000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
}

function eventIdForRank(rank: number): string {
  return `30000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
}

function runId(): string {
  return "40000000-0000-4000-8000-000000000001";
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
