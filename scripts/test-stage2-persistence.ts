import { strict as assert } from "node:assert";
import { replaceEventGroups } from "../src/processing/event-group-persistence.js";
import { stage2WarningMetrics, summarizeStage2Result } from "../src/processing/stage2-job.js";
import { validateStage2Assignments } from "../src/processing/stage2-contract.js";
import { loadEventGroupsForRanking } from "../src/processing/event-group-persistence.js";
import { loadLatestStage4Selection } from "../src/processing/stage4-persistence.js";
import type { Stage2EventGroup, Stage2JobSuccess } from "../src/processing/stage2-job.js";

const DAILY_DATE = "2026-09-15";
const group = (event_hint: string, contentIds: string[]): Stage2EventGroup => ({
  event_hint,
  sources: contentIds.map((processed_content_id, index) => ({
    temp_id: `E${String(index + 1).padStart(3, "0")}`,
    processed_content_id,
  })),
});
const input = { event_candidates: [{ temp_id: "E001" }, { temp_id: "E002" }, { temp_id: "E003" }] } as never;

const crossGroup = validateStage2Assignments({
  events: [{ event_hint: "A", sources: ["E001"] }, { event_hint: "B", sources: ["E001", "E002", "E003"] }],
}, input);
assert.equal(crossGroup.passed, true);
assert.deepEqual(crossGroup.crossGroupMemberships, [{ tempId: "E001", eventGroups: [1, 2] }]);
const crossPool = createFakePool();
await replaceEventGroups(crossPool.pool, DAILY_DATE, [group("A", ["content-a"]), group("B", ["content-a", "content-b"])]);
assert.equal(crossPool.countMembership("content-a"), 2);

// Downstream loaders retain the same shared source under both independent groups.
const stage3Rows = await loadEventGroupsForRanking({ query: async () => ({ rows: [
  { eventGroupId: "group-a", eventHint: "A", processedContentId: "content-a", source: "S", title: "A", summary: null },
  { eventGroupId: "group-b", eventHint: "B", processedContentId: "content-a", source: "S", title: "A", summary: null },
] }) } as never, DAILY_DATE);
assert.equal(stage3Rows.length, 2);
assert.deepEqual(new Set(stage3Rows.map((row) => row.eventGroupId)), new Set(["group-a", "group-b"]));
let stage4Query = 0;
const stage4Selection = await loadLatestStage4Selection({ query: async () => {
  stage4Query += 1;
  return stage4Query === 1
    ? { rows: [{ review_run_id: "review-run" }] }
    : { rows: [
      { reviewRunId: "review-run", reviewItemId: "review-a", eventGroupId: "group-a", eventHint: "A", aiRank: 1, displayRank: 1, processedContentIds: ["content-a"] },
      { reviewRunId: "review-run", reviewItemId: "review-b", eventGroupId: "group-b", eventHint: "B", aiRank: 2, displayRank: 2, processedContentIds: ["content-a"] },
    ] };
} } as never, DAILY_DATE, 15);
assert.equal(stage4Selection.length, 2);
assert.equal(stage4Selection[0]?.processedContentIds[0], stage4Selection[1]?.processedContentIds[0]);

const sameGroup = validateStage2Assignments({ events: [{ event_hint: "A", sources: ["E001", "E001", "E002", "E003"] }] }, input);
assert.equal(sameGroup.passed, true);
assert.deepEqual(sameGroup.sameGroupDuplicates, [{ tempId: "E001", eventGroup: 1 }]);
const dedupePool = createFakePool();
await replaceEventGroups(dedupePool.pool, DAILY_DATE, [group("A", ["content-a", "content-a", "content-b"])]);
assert.equal(dedupePool.countMembership("content-a"), 1);

const missing = validateStage2Assignments({ events: [{ event_hint: "A", sources: ["E001", "E002"] }] }, input);
assert.equal(missing.passed, true);
assert.deepEqual(missing.missingTempIds, ["E003"]);

const invented = validateStage2Assignments({ events: [{ event_hint: "A", sources: ["fake_id"] }] }, input);
assert.equal(invented.passed, false);
assert.deepEqual(invented.inventedTempIds, ["fake_id"]);

const rollback = createFakePool();
const beforeFailure = rollback.snapshot();
rollback.failNextItemInsert();
await assert.rejects(() => replaceEventGroups(rollback.pool, DAILY_DATE, [group("failure", ["content-new"])]), /injected item insert failure/);
assert.deepEqual(rollback.snapshot(), beforeFailure);

const summary = summarizeStage2Result({
  success: true, input: { event_candidates: [] }, idMap: {}, candidateRows: [], output: { events: [] }, eventGroups: [],
  assignment: validateStage2Assignments({ events: [] }, { event_candidates: [] }), model: "test", promptVersion: "test",
  llmCallCount: 0, retryCount: 0, llmDurationMs: 0, elapsedMs: 0, tokenUsage: null, finishReason: null, error: null,
} satisfies Stage2JobSuccess);
assert.deepEqual(stage2WarningMetrics(summary), {
  warning_count: 0, cross_group_membership_count: 0, same_group_duplicate_count: 0, missing_assignment_count: 0,
});

console.log("Stage 2 membership warnings, many-to-many persistence, replacement rollback, and metrics tests passed");

function createFakePool() {
  type Group = { dailyDate: string; members: string[] };
  let state = new Map<string, Group>([["old-group", { dailyDate: DAILY_DATE, members: ["content-old"] }]]);
  let transactionSnapshot: Map<string, Group> | null = null;
  let nextId = 0;
  let shouldFailNextItemInsert = false;
  const clone = (value: Map<string, Group>) => new Map([...value.entries()].map(([id, value]) => [id, { ...value, members: [...value.members] }]));
  const client = { query: async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (sql === "begin") { transactionSnapshot = clone(state); return { rows: [] }; }
    if (sql === "commit") { transactionSnapshot = null; return { rows: [] }; }
    if (sql === "rollback") { state = transactionSnapshot ?? state; transactionSnapshot = null; return { rows: [] }; }
    if (sql.startsWith("delete from event_groups")) { state = new Map([...state].filter(([, value]) => value.dailyDate !== values[0])); return { rows: [] }; }
    if (sql.startsWith("insert into event_groups")) { const id = `new-group-${++nextId}`; state.set(id, { dailyDate: values[0] as string, members: [] }); return { rows: [{ id }] }; }
    if (sql.startsWith("insert into event_group_items")) {
      if (shouldFailNextItemInsert) { shouldFailNextItemInsert = false; throw new Error("injected item insert failure"); }
      const target = state.get(values[0] as string); if (!target) throw new Error("missing group");
      target.members.push(...values[1] as string[]); return { rows: [] };
    }
    throw new Error(`Unexpected query: ${text}`);
  }, release: () => undefined };
  return {
    pool: { connect: async () => client } as never,
    failNextItemInsert: () => { shouldFailNextItemInsert = true; },
    countMembership: (contentId: string) => [...state.values()].flatMap((value) => value.members).filter((id) => id === contentId).length,
    snapshot: () => [...state.entries()].map(([id, value]) => ({ id, dailyDate: value.dailyDate, members: [...value.members] })),
  };
}
