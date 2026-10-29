/** Safe Mock-only regression. Never loads .env or connects to PostgreSQL. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import { withPromptBindings } from '../src/lib/prompts/runtime.js';
import {
  deduplicateStage4Events,
  pendingStage4Selection,
  readStage4Selection,
  resolveStage4Selection,
  selectedStage4Candidates,
} from '../src/processing/stage4-selection.js';
import { getDailyBriefForDailyDate } from '../src/lib/daily-brief.js';

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const candidates = Array.from({ length: 20 }, (_, i) => ({
  reviewRunId: uid(100),
  reviewItemId: uid(i + 101),
  eventGroupId: uid(i + 1),
  eventHint: i === 19 ? 'New official decision and material development' : `Event ${i + 1}`,
  aiRank: i + 1,
  displayRank: 20 - i,
  processedContentIds: [uid(i + 201)],
}));
// Simulate the actual loader's human-ranked order rather than AI order.
candidates.sort((a, b) => a.displayRank - b.displayRank);
const original = structuredClone(candidates);
const history = [{ title: 'Previous event', summary: 'Already published facts' }];
const prompts = new PromptMemory();
const key = 'daily.stage4.event_dedup';
let modelCalls = 0;
const run = async (answers: unknown[], recent = history) => {
  let n = 0;
  return withPromptBindings(
    prompts.db,
    async () => prompts.active.get(key)!,
    () =>
      deduplicateStage4Events(pendingStage4Selection(candidates), recent, {
        request: async (request) => {
          modelCalls++;
          const input = JSON.parse(String(request.input));
          assert.deepEqual(input, {
            candidates: candidates.map((c) => ({ id: c.eventGroupId, event_hint: c.eventHint })),
            recent_events: recent,
          });
          assert.deepEqual(Object.keys(input.candidates[0]), ['id', 'event_hint']);
          assert.equal(request.text?.format?.name, 'stage4_event_dedup');
          const answer = answers[n++];
          if (answer instanceof Error) throw answer;
          return {
            id: 'mock',
            output: [],
            output_text: typeof answer === 'string' ? answer : JSON.stringify(answer),
            api_mode: 'chat_completions',
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              total_tokens: 110,
              cached_input_tokens: 0,
            },
          };
        },
      }),
  );
};
for (const count of [5, 8, 20]) {
  // Keep the explicit important development; classification itself belongs to the LLM.
  const duplicates = candidates.slice(1, count + 1).map((c) => c.eventGroupId);
  const result = await run([{ duplicate_ids: duplicates }]);
  assert.equal(result.snapshot.status, 'success');
  assert.deepEqual(
    result.snapshot.selected_ids,
    candidates
      .filter((c) => !duplicates.includes(c.eventGroupId))
      .slice(0, 15)
      .map((c) => c.eventGroupId),
  );
  assert.equal(result.snapshot.selected_ids.length, Math.min(15, 20 - duplicates.length));
  assert.equal(
    result.snapshot.selected_ids[0],
    candidates[0]!.eventGroupId,
    'Model-kept important progress survives selection',
  );
  assert.equal(result.usage.inputTokens, 100);
}
const beforeSkip = modelCalls;
const allDuplicates = await run([{ duplicate_ids: candidates.map((c) => c.eventGroupId) }]);
assert.equal(
  allDuplicates.snapshot.selected_ids.length,
  0,
  'All duplicates means an empty selected set, not replenishment',
);
const callsBeforeEmptyHistory = modelCalls;
const skipped = await run([], []);
assert.equal(modelCalls, callsBeforeEmptyHistory);
assert.equal(callsBeforeEmptyHistory, beforeSkip + 1);
assert.equal(skipped.snapshot.status, 'skipped');
assert.equal(skipped.snapshot.reason, 'no_recent_events');
assert.equal(skipped.snapshot.calls, 0);
assert.equal(skipped.snapshot.selected_ids.length, 15);
const retry = await run([new Error('mock API error'), { duplicate_ids: [] }]);
assert.equal(retry.snapshot.calls, 2);
assert.equal(retry.snapshot.status, 'success');
for (const invalid of [
  { duplicate_ids: ['unknown'] },
  { duplicate_ids: [uid(1), uid(1)] },
  { duplicate_ids: null },
  'invalid JSON',
  { duplicate_ids: [], extra: true },
]) {
  const result = await run([invalid, invalid, invalid]);
  assert.equal(result.snapshot.status, 'fallback');
  assert.equal(result.snapshot.reason, 'dedup_fallback');
  assert.equal(result.snapshot.calls, 3);
  assert.equal(result.snapshot.errors.length, 3);
  assert.deepEqual(
    result.snapshot.selected_ids,
    candidates.slice(0, 15).map((c) => c.eventGroupId),
  );
}
assert.deepEqual(candidates, original, 'No rank, hint or membership mutation');
assert.throws(() => readStage4Selection({ ...skipped.snapshot, selected_ids: [uid(999)] }));
assert.throws(() => selectedStage4Candidates(pendingStage4Selection(candidates)));

// Exercise the REAL session-lock/cache persistence path with an empty history.
let stored: unknown = pendingStage4Selection(candidates),
  released = 0,
  unlocks = 0,
  historyReads = 0,
  busy = false;
let writeFails = false;
const lockClient = Object.assign(new EventEmitter(), {
  query: async (sql: string, values: unknown[] = []) => {
    assert.doesNotMatch(sql, /^begin/i, 'No long transaction during Dedup');
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: !busy }] };
    if (sql.includes('pg_advisory_unlock')) {
      unlocks++;
      return { rows: [{ unlocked: true }] };
    }
    if (sql.startsWith('select selection_snapshot'))
      return { rows: [{ selection_snapshot: structuredClone(stored), daily_date: '2026-10-29' }] };
    if (sql.startsWith('select e.title')) {
      historyReads++;
      return { rows: [] };
    }
    if (sql.startsWith('update stage4_runs')) {
      if (sql.includes("set status='failed'")) return { rows: [], rowCount: 1 };
      if (writeFails) throw new Error('snapshot write failed');
      stored = JSON.parse(String(values[1]));
      assert.equal(values[2], 15);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  },
  release: () => {
    released++;
  },
});
const pool = { connect: async () => lockClient } as unknown as Pool;
assert.equal(
  (await resolveStage4Selection(pool, uid(500), '2026-10-29'))!.snapshot.status,
  'skipped',
);
const fixed = structuredClone(stored);
assert.equal((await resolveStage4Selection(pool, uid(500), '2026-10-29'))!.calls, 0);
assert.equal(historyReads, 1, 'Resume reuses final snapshot without querying history');
assert.deepEqual(stored, fixed);
busy = true;
await assert.rejects(resolveStage4Selection(pool, uid(500), '2026-10-29'), /already executing/);
busy = false;
stored = pendingStage4Selection(candidates);
writeFails = true;
await assert.rejects(resolveStage4Selection(pool, uid(500), '2026-10-29'), /snapshot write failed/);
assert.equal((stored as { status: string }).status, 'pending');
writeFails = false;
await resolveStage4Selection(pool, uid(500), '2026-10-29');
assert.equal(released, 5);
assert.equal(unlocks, 4);
await assert.rejects(resolveStage4Selection(pool, uid(500), '2026-10-30'), /date mismatch/);
stored = null;
assert.equal(
  await resolveStage4Selection(pool, uid(500), '2026-10-29'),
  null,
  'Legacy Run never deduplicates',
);

// Execute the real API data reader with deterministic Published / Draft query responses.
const event = {
  id: uid(700),
  rank: 17,
  event_date: '2026-10-29',
  created_at: new Date().toISOString(),
  title: 'Published outside original Top 15',
  title_zh: '人工晋级',
  summary: 'Stored',
  summary_zh: '存储',
  tags: [],
  tags_zh: [],
  entities: [],
  entities_zh: [],
  source_perspectives: [],
  external_context: null,
};
for (const published of [true, false]) {
  let sawDraft = false;
  const db = {
    query: async (sql: string) => {
      if (sql.includes('join stage4_runs on')) {
        assert.ok(sql.includes("events.publication_status = 'published'"));
        assert.doesNotMatch(sql, /limit 15|selection_snapshot|display_rank\s*<=/i);
        return { rows: published ? [event] : [] };
      }
      if (sql.startsWith('select id from stage4_runs')) return { rows: [{ id: uid(500) }] };
      if (sql.includes("events.publication_status = 'draft'")) {
        sawDraft = true;
        assert.ok(sql.includes('r.selection_snapshot is null'));
        assert.ok(sql.includes("r.selection_snapshot->'selected_ids' ? eri.event_group_id::text"));
        assert.ok(sql.includes("'success', 'fallback', 'skipped'"));
        return { rows: [event] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const brief = await getDailyBriefForDailyDate(db, '2026-10-29');
  assert.equal(brief.events.length, 1);
  assert.equal(brief.events_status, published ? 'published' : 'partial');
  assert.equal(sawDraft, !published);
}
console.log(
  'PASS Stage4 Dedup: Top20 selection, no replenishment, 3-attempt fallback, strict IDs/schema, real input, fixed snapshot Resume, session lock lifecycle, legacy compatibility and Published/Draft API boundaries (Mock only).',
);
