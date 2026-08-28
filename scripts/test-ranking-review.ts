import type { Pool, PoolClient } from "pg";
import {
  buildEventReviewSnapshotItems,
  persistEventReviewSnapshot,
} from "../src/processing/event-review-persistence.js";
import {
  buildRankingChangeSet,
  saveLongFormReviewRanking,
} from "../src/lib/ranking-review.js";
import { getEventReviewData } from "../src/lib/review.js";

type Check = { name: string; passed: boolean; detail?: unknown };
const checks: Check[] = [];

const fifty = buildSnapshot(50, "10000000-0000-4000-8000-000000000001");
const three = buildSnapshot(3, "10000000-0000-4000-8000-000000000002");
checks.push({
  name: "Stage 3 persists every returned Event Ranking item up to Top 50",
  passed:
    fifty.length === 50 &&
    fifty.every((item, index) => item.aiRank === index + 1 && item.displayRank === index + 1),
});

const exactEventReview = await getEventReviewData(createEventReviewPool(false), "2026-08-25");
const staleEventReview = await getEventReviewData(createEventReviewPool(true), "2026-08-25");
checks.push({
  name: "Event Review uses Stage 4 content only for an exact member-set match",
  passed:
    exactEventReview.items[0]?.finalEvent?.titleZh === "最终事件" &&
    staleEventReview.items[0]?.finalEvent === null,
});

let snapshotInsertCount = 0;
const snapshotTransactionLog: string[] = [];
const snapshotPool = {
  connect: async () => ({
    query: async (text: string) => {
      const command = text.trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
      snapshotTransactionLog.push(command);
      if (command === "insert into") {
        snapshotInsertCount += 1;
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => snapshotTransactionLog.push("release"),
  } as unknown as PoolClient),
} as Pool;
const persistedCount = await persistEventReviewSnapshot(snapshotPool, fifty);
const persistedThreeCount = await persistEventReviewSnapshot(snapshotPool, three);
checks.push({
  name: "Top 50 and shorter snapshots persist every item in atomic transactions",
  passed:
    persistedCount === 50 &&
    persistedThreeCount === 3 &&
    snapshotInsertCount === 53 &&
    snapshotTransactionLog.includes("begin") &&
    snapshotTransactionLog.includes("commit") &&
    !snapshotTransactionLog.includes("rollback"),
});
checks.push({
  name: "snapshots keep all items when fewer than 50 and distinguish runs",
  passed:
    three.length === 3 &&
    new Set([...fifty, ...three].map((item) => item.reviewRunId)).size === 2,
});

checks.push(feedbackCheck("#20 → #5 is false_negative", 20, 5, 15, "false_negative"));
checks.push(feedbackCheck("#5 → #20 is false_positive", 5, 20, 15, "false_positive"));
checks.push(feedbackCheck("#3 → #8 is ranking_error", 3, 8, 15, "ranking_error"));
checks.push(feedbackCheck("#20 → #30 is ranking_error", 20, 30, 15, "ranking_error"));
checks.push(feedbackCheck("Long-form #12 → #4 uses its own cutoff", 12, 4, 10, "false_negative"));
checks.push(feedbackCheck("Long-form #4 → #12 is false_positive", 4, 12, 10, "false_positive"));
checks.push(feedbackCheck("Long-form #2 → #6 is ranking_error", 2, 6, 10, "ranking_error"));

const originalRows = rankingRows(30);
const movedTwenty = moveId(originalRows.map((row) => row.id), idForRank(20), 5);
const passiveChangeSet = buildRankingChangeSet({
  currentRows: originalRows,
  orderedIds: movedTwenty,
  touchedIds: [idForRank(20)],
  cutoff: 15,
});
checks.push({
  name: "passive cutoff displacement updates rank but creates no feedback",
  passed:
    passiveChangeSet.feedback.length === 1 &&
    passiveChangeSet.feedback[0]?.id === idForRank(20) &&
    passiveChangeSet.changes.find((change) => change.id === idForRank(15))?.nextDisplayRank === 16,
});

const movedTwice = moveId(
  moveId(originalRows.map((row) => row.id), idForRank(3), 8),
  idForRank(3),
  2,
);
const movedTwiceChangeSet = buildRankingChangeSet({
  currentRows: originalRows,
  orderedIds: movedTwice,
  touchedIds: [idForRank(3)],
  cutoff: 15,
});
checks.push({
  name: "multiple active moves create one feedback from initial to final rank",
  passed:
    movedTwiceChangeSet.feedback.length === 1 &&
    movedTwiceChangeSet.feedback[0]?.beforeRank === 3 &&
    movedTwiceChangeSet.feedback[0]?.afterRank === 2,
});

const movedBack = moveId(
  moveId(originalRows.map((row) => row.id), idForRank(3), 8),
  idForRank(3),
  3,
);
const movedBackChangeSet = buildRankingChangeSet({
  currentRows: originalRows,
  orderedIds: movedBack,
  touchedIds: [idForRank(3)],
  cutoff: 15,
});
checks.push({
  name: "moving back to the initial rank creates no feedback",
  passed: movedBackChangeSet.feedback.length === 0,
});

checks.push({
  name: "final display ranks are continuous and ai_rank remains unchanged",
  passed:
    passiveChangeSet.changes.every((change, index) => change.nextDisplayRank === index + 1) &&
    passiveChangeSet.changes.every(
      (change) => change.aiRank === originalRows.find((row) => row.id === change.id)?.aiRank,
    ),
});

const transactionLog: string[] = [];
let updateCount = 0;
const failingPool = {
  connect: async () => ({
    query: async (text: string) => {
      const normalized = text.trim().toLowerCase();
      transactionLog.push(normalized.split(/\s+/).slice(0, 2).join(" "));
      if (normalized.startsWith("select pc.id")) {
        return {
          rows: [
            { id: idForRank(1), ai_rank: 1, display_rank: 1 },
            { id: idForRank(2), ai_rank: 2, display_rank: 2 },
          ],
        };
      }
      if (normalized.startsWith("update processed_contents")) {
        updateCount += 1;
        if (updateCount === 2) {
          throw new Error("injected update failure");
        }
      }
      return { rows: [], rowCount: 1 };
    },
    release: () => transactionLog.push("release"),
  } as unknown as PoolClient),
} as Pool;

try {
  await saveLongFormReviewRanking(failingPool, {
    dailyDate: "2026-08-25",
    orderedIds: [idForRank(2), idForRank(1)],
    touchedIds: [idForRank(2)],
  });
  checks.push({ name: "transaction failure rolls back all ranking updates", passed: false });
} catch {
  checks.push({
    name: "transaction failure rolls back all ranking updates",
    passed: transactionLog.includes("rollback") && !transactionLog.includes("commit"),
    detail: transactionLog,
  });
}

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
if (checks.some((check) => !check.passed)) {
  process.exitCode = 1;
}

function buildSnapshot(count: number, reviewRunId: string) {
  const events = Array.from({ length: count }, (_, index) => ({
    id: `E${String(index + 1).padStart(3, "0")}`,
    event_hint: `Event ${index + 1}`,
    source_count: 1,
    sources: [{ source: "Source", title: `Title ${index + 1}`, summary: "Summary" }],
  }));
  return buildEventReviewSnapshotItems({
    reviewRunId,
    dailyDate: "2026-08-25",
    rankingOutput: {
      rankings: events.map((event, index) => ({ id: event.id, rank: index + 1 })),
    },
    eventInput: { events },
    eventIdMap: Object.fromEntries(
      events.map((event, index) => [event.id, [idForRank(index + 1)]]),
    ),
  });
}

function feedbackCheck(
  name: string,
  beforeRank: number,
  afterRank: number,
  cutoff: number,
  expected: string,
): Check {
  const rows = rankingRows(30);
  const orderedIds = moveId(rows.map((row) => row.id), idForRank(beforeRank), afterRank);
  const result = buildRankingChangeSet({
    currentRows: rows,
    orderedIds,
    touchedIds: [idForRank(beforeRank)],
    cutoff,
  });
  return { name, passed: result.feedback[0]?.feedbackType === expected };
}

function rankingRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: idForRank(index + 1),
    aiRank: index + 1,
    displayRank: index + 1,
  }));
}

function moveId(ids: string[], id: string, rank: number): string[] {
  const result = [...ids];
  const from = result.indexOf(id);
  result.splice(from, 1);
  result.splice(rank - 1, 0, id);
  return result;
}

function idForRank(rank: number): string {
  return `00000000-0000-4000-8000-${String(rank).padStart(12, "0")}`;
}

function createEventReviewPool(includeStaleExtraMember: boolean): Pool {
  const reviewRunId = "20000000-0000-4000-8000-000000000001";
  const finalEventId = "30000000-0000-4000-8000-000000000001";
  const memberIds = [idForRank(1), idForRank(2)];
  return {
    query: async (text: string) => {
      if (text.includes("group by review_run_id")) {
        return { rows: [{ review_run_id: reviewRunId }] };
      }
      if (text.includes("member_content_ids") && text.includes("from event_review_items")) {
        return {
          rows: [{
            id: "40000000-0000-4000-8000-000000000001",
            review_run_id: reviewRunId,
            event_temp_id: "E001",
            event_hint: "Event hint",
            ai_rank: 1,
            display_rank: 1,
            member_content_ids: memberIds,
          }],
        };
      }
      if (text.includes("join raw_articles")) {
        return {
          rows: memberIds.map((id, index) => ({
            id,
            event_id: finalEventId,
            source: `Source ${index + 1}`,
            title: `Title ${index + 1}`,
            title_zh: null,
            summary_zh: null,
            tags: [],
            entities: [],
            entities_zh: [],
            url: null,
          })),
        };
      }
      if (text.includes("from events")) {
        return {
          rows: [{
            id: finalEventId,
            title_zh: "最终事件",
            summary_zh: "摘要",
            tags: [],
            tags_zh: [],
            entities: [],
            entities_zh: [],
          }],
        };
      }
      if (text.includes("where event_id = any")) {
        return {
          rows: [
            ...memberIds.map((id) => ({ event_id: finalEventId, id })),
            ...(includeStaleExtraMember
              ? [{ event_id: finalEventId, id: idForRank(3) }]
              : []),
          ],
        };
      }
      throw new Error(`Unexpected Event Review query: ${text}`);
    },
  } as unknown as Pool;
}
