import { strict as assert } from "node:assert";
import type { Pool } from "pg";
import {
  loadIgnoredArticles,
  loadSourceAnalytics,
  loadSourceAnalyticsDays,
  resolveAnalyticsScopes,
} from "../src/lib/dashboard-analytics.js";
import { sortSourceRows } from "../src/lib/source-analytics-sort.js";

const sortableRows = [
  { sourceId: "1", sourceName: "Zulu", raw: 2, selected: 1, ignored: 1, duplicate: 0, pending: 0, failed: 0 },
  { sourceId: "2", sourceName: "Alpha", raw: 1, selected: 1, ignored: 0, duplicate: 0, pending: 0, failed: 0 },
  { sourceId: "3", sourceName: "No rate", raw: 1, selected: 0, ignored: 0, duplicate: 0, pending: 1, failed: 0 },
  { sourceId: "4", sourceName: "Beta", raw: 2, selected: 1, ignored: 1, duplicate: 0, pending: 0, failed: 0 },
];
assert.deepEqual(sortSourceRows(sortableRows, "descending").map((row) => row.sourceName), ["Alpha", "Beta", "Zulu", "No rate"]);
assert.deepEqual(sortSourceRows(sortableRows, "ascending").map((row) => row.sourceName), ["Beta", "Zulu", "Alpha", "No rate"]);

const now = new Date("2026-10-15T01:00:00.000Z");
assert.equal(resolveAnalyticsScopes("7", undefined, undefined, now).length, 7);
assert.equal(resolveAnalyticsScopes("30", undefined, undefined, now).length, 30);
assert.deepEqual(
  resolveAnalyticsScopes("custom", "2026-10-13", "2026-10-16", now).map((scope) => scope.dailyDate),
  ["2026-10-15", "2026-10-14", "2026-10-13"],
);

const queries: Array<{ text: string; values: unknown[] }> = [];
const pool = {
  query: async (text: string, values: unknown[]) => {
    queries.push({ text, values });
    if (text.includes("count(*) over()")) return { rows: [{ id: "a", title: "Duplicate", sourceName: "Source A", url: null, ignoreType: "Duplicate", total_count: 1 }] };
    if (text.includes("group by scope.date")) return { rows: [{ date: "2026-10-14", raw: 3, selected: 1, ignored: 1, duplicate: 1, pending: 0, failed: 0 }] };
    return { rows: [{ source_id: "00000000-0000-4000-8000-000000000001", source_name: "Source A", raw: 5, selected: 2, ignored: 1, duplicate: 1, pending: 1, failed: 0 }] };
  },
} as unknown as Pool;
const scopes = resolveAnalyticsScopes("custom", "2026-10-14", "2026-10-14", now);
const summary = await loadSourceAnalytics(pool, scopes);
assert.deepEqual(summary[0], { sourceId: "00000000-0000-4000-8000-000000000001", sourceName: "Source A", raw: 5, selected: 2, ignored: 1, duplicate: 1, pending: 1, failed: 0 });
assert.equal(summary[0]!.raw, summary[0]!.selected + summary[0]!.ignored + summary[0]!.duplicate + summary[0]!.pending + summary[0]!.failed);
assert.match(queries[0]!.text, /ra\.source_id/);
assert.match(queries[0]!.text, /processing_error = 'duplicate'/);
assert.match(queries[0]!.text, /published_at >= scope\.start_at/);
assert.doesNotMatch(queries[0]!.text, /processed_contents/);
const daily = await loadSourceAnalyticsDays(pool, summary[0]!.sourceId, scopes);
assert.equal(daily[0]!.date, "2026-10-14");
const ignored = await loadIgnoredArticles(pool, summary[0]!.sourceId, scopes[0]!, 1);
assert.equal(ignored.items[0]!.ignoreType, "Duplicate");
assert.deepEqual(queries.at(-1)?.values?.slice(1, 3), [scopes[0]!.startAt, scopes[0]!.endAt]);

console.log("Dashboard analytics daily cohort, Source association, duplicate distinction, and ignored-detail tests passed");
