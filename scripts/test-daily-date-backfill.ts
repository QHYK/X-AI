import { strict as assert } from "node:assert";
import { deriveDailyDateFromPublishedAt } from "../src/lib/daily-scope.js";
import { buildDailyDateBackfillPlan } from "../src/processing/daily-date-backfill.js";

assert.equal(
  deriveDailyDateFromPublishedAt("2026-09-08T00:29:00.000Z"),
  "2026-09-08",
  "08:29 Asia/Shanghai belongs to the same Daily date",
);
assert.equal(
  deriveDailyDateFromPublishedAt("2026-09-08T00:30:00.000Z"),
  "2026-09-09",
  "08:30 Asia/Shanghai belongs to the next Daily date",
);
assert.equal(
  deriveDailyDateFromPublishedAt("2026-09-08T14:00:00.000Z"),
  "2026-09-09",
  "22:00 Asia/Shanghai belongs to the next Daily date",
);

const initialRows = [
  { id: "00000000-0000-0000-0000-000000000001", dailyDate: null, publishedAt: "2026-09-08T00:30:00.000Z" },
  { id: "00000000-0000-0000-0000-000000000002", dailyDate: "2026-09-10", publishedAt: "2026-09-08T14:00:00.000Z" },
  { id: "00000000-0000-0000-0000-000000000003", dailyDate: null, publishedAt: null },
  { id: "00000000-0000-0000-0000-000000000004", dailyDate: null, publishedAt: "not-a-date" },
];
const plan = buildDailyDateBackfillPlan(initialRows);

assert.deepEqual(plan.updates, [{
  id: "00000000-0000-0000-0000-000000000001",
  dailyDate: "2026-09-09",
}], "only NULL daily_date with published_at is backfilled");
assert.equal(plan.skippedCount, 3, "existing attribution and unavailable published_at values are skipped");

const rerunPlan = buildDailyDateBackfillPlan(
  initialRows.map((row) => row.id === plan.updates[0]?.id
    ? { ...row, dailyDate: plan.updates[0].dailyDate }
    : row),
);
assert.equal(rerunPlan.updates.length, 0, "a second run does not overwrite a filled daily_date");

console.log("daily_date backfill focused tests passed");
