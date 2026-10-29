/** State-sequence regression: real job body, persistence and Review service; no DB or paid client. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Pool } from 'pg';
import * as persistence from '../src/processing/stage4-persistence.js';
import {
  prepareStage4Event,
  Stage4EnrichmentError,
} from '../src/processing/stage4-event-processing.js';
import { emptyLlmTokenUsage, mergeLlmTokenUsage } from '../src/processing/llm-token-usage.js';
import {
  getEventReviewEnrichmentRequests,
  saveEventReviewRanking,
} from '../src/lib/ranking-review.js';
import { DEFAULT_STAGE4_EVENT_LIMIT } from '../src/processing/stage4-config.js';
import type { Stage4JobResult } from '../src/processing/stage4-job.js';

type Item = { id: string; snapshot: string; rank: number; ai: number };
type Run = {
  id: string;
  review_run_id: string;
  daily_date: string;
  expected_count: number;
  status: string;
  success_count: number;
};
type Event = {
  id: string;
  item: string;
  run: string;
  date: string;
  status: string;
  rank: number;
  ai: number;
  title: string;
};
const date = '2026-10-26';
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
class Memory {
  items: Item[] = [];
  runs: Run[] = [];
  events: Event[] = [];
  links: Record<string, string | null> = {};
  snapshot = uid(100);
  failPublish = false;
  released = 0;
  queries: string[] = [];
  backup?: string;
  constructor() {
    this.addSnapshot(this.snapshot);
  }
  addSnapshot(id: string) {
    this.snapshot = id;
    this.items.push(
      ...Array.from({ length: DEFAULT_STAGE4_EVENT_LIMIT + 1 }, (_, i) => ({
        id: uid(this.items.length + i + 1),
        snapshot: id,
        rank: i + 1,
        ai: i + 1,
      })),
    );
  }
  selected(snapshot: string, limit = DEFAULT_STAGE4_EVENT_LIMIT) {
    return this.items
      .filter((i) => i.snapshot === snapshot)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit);
  }
  valid(e: Event) {
    const r = this.runs.find((r) => r.id === e.run);
    const i = this.items.find((i) => i.id === e.item);
    return r && i && r.review_run_id === i.snapshot && e.date === r.daily_date;
  }
  db() {
    return {
      query: this.query.bind(this),
      connect: async () => ({
        query: this.query.bind(this),
        release: () => {
          this.released++;
        },
      }),
    } as unknown as Pool;
  }
  async query(text: string, p: unknown[] = []) {
    const q = text.trim().replace(/\s+/g, ' ').toLowerCase();
    this.queries.push(q);
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
    if (q.startsWith('select r.key, v.id from prompt_registry'))
      return result((p[0] as string[]).map((key) => ({ key, id: '11111111-1111-4111-8111-111111111111' })));
    if (q === 'begin') {
      this.backup = JSON.stringify({
        items: this.items,
        runs: this.runs,
        events: this.events,
        links: this.links,
      });
      return result();
    }
    if (q === 'commit') {
      this.backup = undefined;
      return result();
    }
    if (q === 'rollback') {
      Object.assign(this, JSON.parse(this.backup!));
      this.backup = undefined;
      return result();
    }
    if (q.startsWith('select review_run_id from event_review_items'))
      return result([{ review_run_id: this.snapshot }]);
    if (q.startsWith('select eri.review_run_id'))
      return result(
        this.selected(String(p[0]), Number(p[2])).map((i) => ({
          reviewRunId: i.snapshot,
          reviewItemId: i.id,
          eventGroupId: i.id,
          eventHint: i.id,
          aiRank: i.ai,
          displayRank: i.rank,
          processedContentIds: [i.id],
        })),
      );
    if (q.startsWith('select id, success_count, status from stage4_runs'))
      return result(this.runs.filter((r) => r.review_run_id === p[0]));
    if (q.startsWith('insert into stage4_runs')) {
      const r = {
        id: uid(1000 + this.runs.length),
        daily_date: String(p[0]),
        review_run_id: String(p[1]),
        expected_count: Number(p[2]),
        status: 'running',
        success_count: 0,
      };
      this.runs.push(r);
      return result([r]);
    }
    if (q.startsWith('select prompt_versions')) return result([{ prompt_versions: {} }]);
    if (q.startsWith('select e.event_review_item_id')) {
      assert.ok(
        q.includes('eri.review_run_id = r.review_run_id') &&
          q.includes('e.event_date = r.daily_date'),
      );
      assert.ok(q.includes("'archived'"));
      return result(
        this.events
          .filter((e) => e.run === p[0] && this.valid(e))
          .map((e) => ({ event_review_item_id: e.item })),
      );
    }
    if (q.startsWith('insert into events')) {
      const existing = this.events.find((e) => e.run === p[12] && e.item === p[11]);
      if (existing) {
        assert.ok(q.includes('on conflict (stage4_run_id, event_review_item_id) do nothing'));
        return result([], 0);
      }
      this.events.push({
        id: uid(2000 + this.events.length),
        date: String(p[0]),
        title: String(p[1]),
        item: String(p[11]),
        run: String(p[12]),
        status: 'draft',
        ai: Number(p[13]),
        rank: Number(p[14]),
      });
      return result([], 1);
    }
    if (q.startsWith('select daily_date::text, review_run_id, expected_count'))
      return result(this.runs.filter((r) => r.id === p[0]));
    if (q.startsWith('select eri.id from event_review_items')) {
      assert.ok(q.includes('for update of eri'));
      return result(this.selected(String(p[0]), Number(p[2])).map((i) => ({ id: i.id })));
    }
    if (q.startsWith('select id from stage4_runs'))
      return result(this.runs.filter((r) => r.id === p[0]));
    if (q.startsWith('select e.id from events e join stage4_runs'))
      return result(
        this.events
          .filter((e) => e.date === p[0] && e.status === 'published')
          .map((e) => ({ id: e.id })),
      );
    if (q.startsWith('select expected_count from stage4_runs'))
      return result(this.runs.filter((r) => r.id === p[0]));
    if (q.startsWith('select event_review_item_id from events')) {
      assert.ok(q.includes("'archived'"));
      assert.ok(q.includes('r.review_run_id = eri.review_run_id'));
      return result(
        this.events
          .filter((e) => e.run === p[0] && (p[1] as string[]).includes(e.item) && this.valid(e))
          .map((e) => ({ event_review_item_id: e.item })),
      );
    }
    if (q.startsWith('select id from events'))
      return result(
        this.events
          .filter(
            (e) =>
              e.run === p[0] && e.status === 'published' && !(p[1] as string[]).includes(e.item),
          )
          .map((e) => ({ id: e.id })),
      );
    if (q.startsWith('update events set publication_status')) {
      const byIds = q.includes('where id=any');
      const archive =
        q.includes("publication_status='archived'") ||
        q.includes("publication_status = 'archived'");
      const chosen = this.events.filter((e) =>
        byIds
          ? (p[0] as string[]).includes(e.id)
          : e.run === p[0] &&
            (archive ? !(p[1] as string[]).includes(e.item) : (p[1] as string[]).includes(e.item)),
      );
      for (const e of chosen) e.status = archive ? 'archived' : 'published';
      if (this.failPublish && !archive) throw new Error('Injected publication failure');
      return result([], chosen.length);
    }
    if (q.startsWith('update events e set display_rank')) {
      for (const e of this.events.filter(
        (e) => e.run === p[0] && (p[1] as string[]).includes(e.item),
      ))
        e.rank = this.items.find((i) => i.id === e.item)!.rank;
      return result();
    }
    if (q.startsWith('with memberships as')) {
      for (const e of this.events.filter((e) => e.run === p[0] && e.status === 'published'))
        this.links[e.item] = e.id;
      return result([], Object.keys(this.links).length);
    }
    if (q.startsWith('update processed_contents set event_id')) {
      for (const [key, id] of Object.entries(this.links))
        if ((p[0] as string[]).includes(id!)) this.links[key] = null;
      return result();
    }
    if (q.startsWith('update stage4_runs')) {
      const r = this.runs.find((r) => r.id === p[0])!;
      r.status = q.includes("'success'") ? 'success' : String(p[1]);
      r.success_count = Number(q.includes("'success'") ? p[1] : p[2]);
      return result();
    }
    if (q.startsWith('select count(*)'))
      return result([
        { count: String(this.events.filter((e) => e.run === p[0] && e.status === 'draft').length) },
      ]);
    if (q.startsWith('select id, ai_rank, display_rank'))
      return result(
        this.items
          .filter((i) => i.snapshot === p[0])
          .sort((a, b) => a.rank - b.rank)
          .map((i) => ({
            id: i.id,
            ai_rank: i.ai,
            display_rank: i.rank,
            event_hint: i.id,
            member_content_ids: [i.id],
          })),
      );
    if (q.startsWith('select e.id, e.event_review_item_id')) {
      assert.ok(q.includes('eri.review_run_id = r.review_run_id') && q.includes("'archived'"));
      return result(
        this.events
          .filter((e) => (p[0] as string[]).includes(e.item) && this.valid(e))
          .map((e) => ({ id: e.id, event_review_item_id: e.item })),
      );
    }
    if (q.startsWith('select e.id from events e join processed_contents')) return result();
    if (q.startsWith('update event_review_items')) {
      if (q.includes('-display_rank'))
        for (const i of this.items.filter((i) => i.snapshot === p[0])) i.rank = -i.rank;
      else this.items.find((i) => i.id === p[0])!.rank = Number(p[1]);
      return result([], 1);
    }
    if (q.startsWith('update events set display_rank')) {
      this.events.find((e) => e.id === p[0])!.rank = Number(p[1]);
      return result([], 1);
    }
    if (q.startsWith('insert into feedback')) return result([], 1);
    throw new Error(`Unexpected SQL: ${q}`);
  }
}

// Execute the unchanged production job function with only network/Prompt infrastructure mocked.
const source = await readFile(new URL('../src/processing/stage4-job.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('job.ts', source, ts.ScriptTarget.Latest, true);
const names = [
  'processStage4FromDb',
  'stage4RuntimeArtifact',
  'addStage4TokenUsage',
  'toEventToPersist',
  'toRunTimestamp',
];
const body = parsed.statements
  .filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name!.text))
  .map((n) => n.getText(parsed))
  .join('\n');
let calls = 0,
  failItem: string | undefined;
const output = {
  event_title: 'Generated Event',
  event_title_zh: '事件',
  event_tags: [],
  event_tags_zh: [],
  event_entities: [],
  event_entities_zh: [],
  event_summary: 'Summary',
  event_summary_zh: '摘要',
  source_perspectives: [],
  external_context: { performed: false, sources: [], sources_summary: '' },
};
const invoke = runInNewContext(
  ts.transpileModule(`${body}\nprocessStage4FromDb;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
  {
    ...persistence,
    join,
    resolveDailyScope: () => ({ dailyDate: date }),
    resolveStageLlmModel: () => 'mock',
    mkdir: async () => {},
    writeRunJson: async () => {},
    writeJson: async () => {},
    observeRunPrompts: () => async () => {},
    databasePromptBinder: () => () => {},
    withPromptBindings: async (_db: unknown, _binder: unknown, execute: () => Promise<unknown>) =>
      execute(),
    emptyLlmTokenUsage,
    mergeLlmTokenUsage,
    STAGE4_EVENT_ENRICHMENT_PROMPT_VERSION: 'test',
    DEFAULT_STAGE4_EVENT_LIMIT,
    Stage4EnrichmentError,
    classifyStage4LlmError: () => 'ordinary',
    prepareStage4Event,
    loadStage4RecentEvents: async (_db: unknown, targetDate: string) => {
      assert.equal(targetDate, date, 'Retry uses the original business date');
      return [{ title: 'Historical event', summary: 'Stored history' }];
    },
    loadStage4SourceCandidates: async (_db: unknown, ids: string[]) =>
      new Map(
        ids.map((id) => [
          id,
          {
            processedContentId: id,
            title: 'Source',
            summary: 'Actual evidence',
            entities: [],
            source: 'Source',
            url: 'https://example.com',
            publishedAt: null,
          },
        ]),
      ),
    enrichStage4Event: async (prepared: { group: { eventReviewItemId: string } }) => {
      calls++;
      if (prepared.group.eventReviewItemId === failItem) throw new Error('Mock LLM failure');
      return {
        ...prepared,
        output,
        llm: { llmCallCount: 1, attempts: 1, llmDurationMs: 1, tokenUsage: null },
        toolUsage: { webSearchPerformed: false, webSearchCallCount: 0 },
      };
    },
  },
) as (db: Pool, options: { dailyDate: string; rootDir: string }) => Promise<Stage4JobResult>;
const run = (m: Memory) => invoke(m.db(), { dailyDate: date, rootDir: '/mock-stage4' });

const m = new Memory();
const initialRun = await run(m);
assert.equal(initialRun.success, true, initialRun.error ?? 'Stage4 initial Run failed');
assert.equal(calls, DEFAULT_STAGE4_EVENT_LIMIT);
const firstIds = m.events.map((e) => e.id);
assert.equal((await run(m)).success, true);
assert.equal(calls, DEFAULT_STAGE4_EVENT_LIMIT, 'Published Run retry must not invoke the model.');
assert.deepEqual(
  m.events.map((e) => e.id),
  firstIds,
);
const order = m.items.map((i) => i.id);
const outgoing = order[DEFAULT_STAGE4_EVENT_LIMIT - 1]!;
const incoming = order.at(-1)!;
const moved = [incoming, ...order.filter((id) => id !== incoming)];
const input = {
  dailyDate: date,
  reviewRunId: m.snapshot,
  orderedIds: moved,
  touchedIds: [incoming],
};
const requests = await getEventReviewEnrichmentRequests(m.db(), input);
assert.equal(requests.length, 1);
const prepared = prepareStage4Event(
  requests[0]!,
  new Map([
    [
      incoming,
      {
        processedContentId: incoming,
        title: 'Source',
        summary: 'Evidence',
        entities: [],
        source: 'Source',
        url: null,
        publishedAt: null,
      },
    ],
  ]),
  new Date(),
  date,
);
await saveEventReviewRanking(m.db(), {
  ...input,
  enrichedEvents: [{ ...prepared, output, llm: {} as never, toolUsage: {} as never }],
});
const archived = m.events.find((e) => e.item === outgoing)!;
assert.equal(archived.status, 'archived');
const restore = { ...input, orderedIds: order, touchedIds: [outgoing] };
assert.equal(
  (await getEventReviewEnrichmentRequests(m.db(), restore)).length,
  0,
  'Archived promotion reuses the saved Event.',
);
const before = calls;
await saveEventReviewRanking(m.db(), restore);
assert.equal(archived.status, 'published');
assert.equal(archived.rank, DEFAULT_STAGE4_EVENT_LIMIT);
assert.equal(m.links[outgoing], archived.id);
assert.equal((await run(m)).success, true);
assert.equal(calls, before);
assert.equal(m.events.length, DEFAULT_STAGE4_EVENT_LIMIT + 1);
// Manual order is authoritative even on a later Production retry.
const swap = [order[1]!, order[0]!, ...order.slice(2)];
await saveEventReviewRanking(m.db(), { ...restore, orderedIds: swap, touchedIds: [order[1]!] });
await run(m);
assert.equal(m.events.find((e) => e.item === order[1])!.rank, 1);
assert.equal(m.events.find((e) => e.item === order[1])!.ai, 2);

const partial = new Memory();
failItem = partial.items[1]!.id;
assert.equal((await run(partial)).success, false);
assert.ok(partial.events.every((e) => e.status === 'draft'));
assert.equal(partial.runs[0]!.status, 'partial');
const partialCalls = calls;
failItem = undefined;
assert.equal((await run(partial)).success, true);
assert.equal(calls, partialCalls + 1, 'Partial retry generates only the missing Event.');
const oldEvents = partial.events.map((e) => e.id);
partial.addSnapshot(uid(101));
const snapshotCalls = calls;
assert.equal((await run(partial)).success, true);
assert.equal(calls, snapshotCalls + DEFAULT_STAGE4_EVENT_LIMIT);
assert.ok(
  partial.events.filter((e) => oldEvents.includes(e.id)).every((e) => e.status === 'archived'),
);
// A published row with the wrong Run/Review context must never suppress generation.
const corrupt = new Memory();
await run(corrupt);
corrupt.events[0]!.date = '2026-10-25';
assert.ok(
  !(await persistence.loadGeneratedReviewItemIds(corrupt.db(), corrupt.runs[0]!.id)).has(
    corrupt.events[0]!.item,
  ),
);
assert.equal(
  (await run(corrupt)).success,
  false,
  'A conflicting row with invalid context fails instead of reusing it.',
);

// Failure after changing publication rows must roll back all publication/backlink effects.
const broken = new Memory();
broken.failPublish = true;
const failure = await run(broken);
assert.equal(failure.success, false);
assert.ok(broken.events.every((e) => e.status === 'draft'));
assert.deepEqual(broken.links, {});
assert.equal(broken.runs[0]!.status, 'running');
console.log(
  'Stage4 repeated publish, archived restoration, partial Resume, snapshot isolation, uniqueness, manual ranks and publication rollback passed (Mock LLM/DB).',
);

const replacement = new Memory();
await run(replacement);
const liveIds = replacement.events.map((e) => e.id);
const liveLinks = { ...replacement.links };
replacement.addSnapshot(uid(102));
replacement.failPublish = true;
assert.equal((await run(replacement)).success, false);
assert.ok(
  replacement.events.filter((e) => liveIds.includes(e.id)).every((e) => e.status === 'published'),
);
assert.ok(
  replacement.events.filter((e) => !liveIds.includes(e.id)).every((e) => e.status === 'draft'),
);
assert.deepEqual(
  replacement.links,
  liveLinks,
  'A failed replacement retains the entire previous published set and backlinks.',
);
console.log('Failed complete-set replacement preserves the previous published generation.');
