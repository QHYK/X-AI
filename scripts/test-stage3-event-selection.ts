import { selectTopEvents } from '../src/processing/stage3-job.js';
import { DEFAULT_STAGE4_EVENT_LIMIT } from '../src/processing/stage4-config.js';
import { buildEventReviewSnapshotItems } from '../src/processing/event-review-persistence.js';

type Check = { name: string; passed: boolean };
const checks: Check[] = [];
const events = Array.from({ length: 50 }, (_, index) => ({
  id: `event-${index + 1}`,
  event_hint: `Event ${index + 1}`,
  source_count: 1,
  sources: [{ source: 'Test', title: `Title ${index + 1}`, summary: 'Summary' }],
}));
const idMap = Object.fromEntries(
  events.map((event, index) => [event.id, [`content-${index + 1}`]]),
);
const rankingOutput = {
  rankings: events.map((event, index) => ({ id: event.id, rank: index + 1 })),
};

const selected = selectTopEvents({
  rankingOutput,
  eventInput: { events },
  eventIdMap: idMap,
  topN: DEFAULT_STAGE4_EVENT_LIMIT,
});
checks.push({
  name: 'Stage 3 selects only the shared Stage 4 Top 15 cutoff for consolidation',
  passed:
    selected.events.length === DEFAULT_STAGE4_EVENT_LIMIT &&
    selected.events.at(-1)?.id === 'event-15',
});
const snapshot = buildEventReviewSnapshotItems({
  reviewRunId: '10000000-0000-4000-8000-000000000001',
  dailyDate: '2026-08-25',
  rankingOutput,
  eventInput: { events },
  eventIdMap: idMap,
});
checks.push({
  name: 'Event Review snapshot retains all Top 50 ranked Events',
  passed: snapshot.length === 50 && snapshot.at(-1)?.aiRank === 50,
});

for (const check of checks) console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;
