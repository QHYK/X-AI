import {
  applyCrossChannelDedup,
  selectTopEvents,
} from "../src/processing/stage3-job.js";
import { DEFAULT_STAGE4_EVENT_LIMIT } from "../src/processing/stage4-config.js";
import { buildEventReviewSnapshotItems } from "../src/processing/event-review-persistence.js";

type Check = { name: string; passed: boolean };
const checks: Check[] = [];
const events = Array.from({ length: 50 }, (_, index) => ({
  id: `event-${index + 1}`,
  event_hint: `Event ${index + 1}`,
  source_count: 1,
  sources: [{ source: "Test", title: `Title ${index + 1}`, summary: "Summary" }],
}));
const idMap = Object.fromEntries(events.map((event, index) => [event.id, [`content-${index + 1}`]]));
const rankingOutput = { rankings: events.map((event, index) => ({ id: event.id, rank: index + 1 })) };

const selected = selectTopEvents({
  rankingOutput,
  eventInput: { events },
  eventIdMap: idMap,
  topN: DEFAULT_STAGE4_EVENT_LIMIT,
});
const selectedUrlToEvent = new Map(
  selected.events.map((event) => [`https://example.test/${event.id}`, event.id]),
);
const deduped = applyCrossChannelDedup({
  digestRecords: [digestRecord(1), digestRecord(16)],
  longFormRecords: [longFormRecord(15), longFormRecord(50)],
  selectedKeyToEventId: selectedUrlToEvent,
});

checks.push({
  name: "Stage 3 selects only the shared Stage 4 Top 15 cutoff for cross-channel dedup",
  passed: selected.events.length === DEFAULT_STAGE4_EVENT_LIMIT && selected.events.at(-1)?.id === "event-15",
});
checks.push({
  name: "Top 1–15 Event source duplicates are removed from Digest and Long-form",
  passed:
    deduped.removed.some((item) => item.processed_content_id === "digest-1") &&
    deduped.removed.some((item) => item.processed_content_id === "long-form-15"),
});
checks.push({
  name: "Rank 16–50 Event source duplicates remain eligible for Digest and Long-form",
  passed:
    deduped.digestRecords.some((item) => item.processedContentId === "digest-16") &&
    deduped.longFormRecords.some((item) => item.processedContentId === "long-form-50"),
});
const snapshot = buildEventReviewSnapshotItems({
  reviewRunId: "10000000-0000-4000-8000-000000000001",
  dailyDate: "2026-08-25",
  rankingOutput,
  eventInput: { events },
  eventIdMap: idMap,
});
checks.push({
  name: "Event Review snapshot retains all Top 50 ranked Events",
  passed: snapshot.length === 50 && snapshot.at(-1)?.aiRank === 50,
});

for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;

function digestRecord(rank: number) {
  const eventId = `event-${rank}`;
  return {
    category: "Technology",
    candidate: { id: `digest-${rank}`, title: `Digest ${rank}`, summary: "Summary", source: "Test" },
    processedContentId: `digest-${rank}`,
    sourcePriority: "High",
    url: `https://example.test/${eventId}`,
    normalizedUrl: `https://example.test/${eventId}`,
    originalIndex: rank,
  };
}

function longFormRecord(rank: number) {
  const eventId = `event-${rank}`;
  return {
    category: "Long-form",
    candidate: { id: `long-form-${rank}`, title: `Long-form ${rank}`, summary: "Summary", source: "Test" },
    processedContentId: `long-form-${rank}`,
    sourcePriority: "High",
    url: `https://example.test/${eventId}`,
    normalizedUrl: `https://example.test/${eventId}`,
    originalIndex: rank,
  };
}
