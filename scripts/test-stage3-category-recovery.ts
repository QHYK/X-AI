import type { Stage3Step } from '../src/processing/stage3-progress.js';
import assert from 'node:assert/strict';
import { formatMemories } from '../src/lib/memories.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import { processStage3, Stage3RankingFailureError } from '../src/processing/stage3-job.js';
import {
  stableDigestHash,
  strictDigestOutput,
  reusableDigestArtifact,
  type DigestCheckpoint,
} from '../src/processing/stage3-digest-recovery.js';
import { nextDisplayRankForAiRankUpdate } from '../src/processing/stage3-persistence.js';
import {
  ConsolidationCallError,
  type ConsolidationInput,
} from '../src/processing/stage3-consolidation-llm.js';
import { loadLatestStage4Selection } from '../src/processing/stage4-persistence.js';
import { finishPipelineRun } from '../src/processing/pipeline-run-log.js';

const date = '2026-10-29';
const categories = ['Company', 'Finance & Economy', 'General', 'Policy', 'Science', 'Technology'];
type Row = {
  processedContentId: string;
  category: string;
  routing: string;
  daily: string;
  title: string;
  summary: string;
  source: string;
  sourcePriority: string;
  url: string;
  ai: number | null;
  display: number | null;
};
class Store {
  prompts = new PromptMemory();
  rows: Row[] = categories.flatMap((category) =>
    [0, 1].map((i) => ({
      processedContentId: randomUUID(),
      category,
      routing: 'digest',
      daily: date,
      title: `${category} ${i}`,
      summary: 'Original summary',
      source: 'Source',
      sourcePriority: 'tier_1',
      url: `https://example.com/${category}/${i}`,
      ai: null,
      display: null,
    })),
  );
  checkpoints: Record<string, Record<string, DigestCheckpoint>> = {};
  review = new Map<string, number>();
  details: Record<string, Record<string, Stage3Step | Record<string, Stage3Step>>> = {};
  reviewRows: Record<
    string,
    { event_group_id: unknown; ai_rank: unknown; member_content_ids: unknown }[]
  > = {};
  memberships: string[] = [];
  feedbackRows: unknown[] = [];
  consolidationCalls: string[] = [];
  consolidateMatches = false;
  consolidationFails: string | null = null;
  consolidationCommitFails = false;
  calls: string[] = [];
  eventCalls = 0;
  longCalls = 0;
  generalFails = false;
  correctionFails = false;
  persistFails = false;
  checkpointFails = false;
  groupId = randomUUID();
  eventId = randomUUID();
  snapshot: unknown = null;
  released = 0;
  memoryReads = 0;
  memoryContent: string | null = 'content preference';
  memoryReadFails = false;
  memoryContexts: (string | undefined)[] = [];
  constructor() {
    this.rows.push({
      processedContentId: randomUUID(),
      category: 'Long-form',
      routing: 'long_form',
      daily: date,
      title: 'Long',
      summary: 'Body',
      source: 'Source',
      sourcePriority: 'tier_1',
      url: 'https://example.com/long',
      ai: null,
      display: null,
    });
  }
  query = async (sql: string, args: unknown[] = []) => {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.includes('from memories')) {
      this.memoryReads++;
      assert.deepEqual(args, [['content']]);
      assert.ok(text.includes('enabled = true'));
      assert.ok(text.includes('order by priority desc, created_at desc, id desc'));
      if (this.memoryReadFails) throw new Error('Mock Memory read failure');
      return {
        rows:
          this.memoryContent === null
            ? []
            : [
                {
                  id: 'memory',
                  content: this.memoryContent,
                  type: 'content',
                  enabled: true,
                  priority: 0,
                  createdAt: '2026-10-20',
                  updatedAt: '2026-10-20',
                },
              ],
      };
    }
    if (text === 'begin') {
      this.snapshot = structuredClone({
        rows: this.rows,
        checkpoints: this.checkpoints,
        details: this.details,
        reviewRows: this.reviewRows,
        memberships: this.memberships,
        feedbackRows: this.feedbackRows,
        review: [...this.review],
      });
      return { rows: [] };
    }
    if (text === 'rollback') {
      if (this.snapshot) {
        const s = this.snapshot as {
          rows: Row[];
          checkpoints: Record<string, Record<string, DigestCheckpoint>>;
          review: [string, number][];
          details: Store['details'];
          reviewRows: Store['reviewRows'];
          memberships: string[];
          feedbackRows: unknown[];
        };
        this.rows = s.rows;
        this.checkpoints = s.checkpoints;
        this.review = new Map(s.review);
        Object.assign(this, {
          details: s.details,
          reviewRows: s.reviewRows,
          memberships: s.memberships,
          feedbackRows: s.feedbackRows,
        });
      }
      return { rows: [] };
    }
    if (text === 'commit') {
      this.snapshot = null;
      return { rows: [] };
    }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    const prompt = this.prompts.handle(sql, args);
    if (prompt) return prompt;
    if (text.startsWith('with invalid')) {
      if (this.correctionFails) throw new Error('Mock category correction database failure');
      const result = [];
      for (const row of this.rows)
        if (
          row.routing === 'digest' &&
          row.daily === args[0] &&
          !(args[1] as string[]).includes(row.category)
        ) {
          result.push({ id: row.processedContentId, original_category: row.category });
          row.category = 'General';
        }
      return { rows: result };
    }
    if (text.startsWith('select id, case when'))
      return {
        rows: Object.entries(this.details)
          .reverse()
          .map(([id, d]) => ({
            id,
            detail:
              args[2] === null
                ? d[String(args[1])]
                : (d[String(args[1])] as Record<string, Stage3Step> | undefined)?.[String(args[2])],
          })),
      };
    if (text.startsWith('update pipeline_runs set details')) {
      const state = JSON.parse(String(args[3]));
      if (
        this.checkpointFails &&
        args[1] === 'digest_ranking' &&
        ['success', 'skipped'].includes(state.status)
      )
        throw new Error('Mock checkpoint database failure');
      if (
        this.consolidationCommitFails &&
        args[1] === 'consolidation' &&
        state.status === 'success'
      )
        throw new Error('Mock consolidation commit failure');
      const d = (this.details[String(args[0])] ??= {});
      if (args[2] === null) d[String(args[1])] = state;
      else ((d[String(args[1])] ??= {}) as Record<string, Stage3Step>)[String(args[2])] = state;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('select event_group_id,ai_rank,member_content_ids'))
      return { rows: this.reviewRows[String(args[0])] ?? [] };
    if (text.startsWith('select review_run_id from event_review_items'))
      return { rows: [{ review_run_id: Object.keys(this.reviewRows).at(-1) }] };
    if (text.includes('from event_review_items eri') && text.includes('join event_group_items')) {
      return {
        rows: [
          {
            reviewRunId: args[0],
            reviewItemId: randomUUID(),
            eventGroupId: this.groupId,
            eventHint: 'Event',
            aiRank: 1,
            displayRank: 1,
            processedContentIds: [this.eventId, ...this.memberships],
          },
        ],
      };
    }
    if (text.startsWith('select id,event_hint from event_groups'))
      return { rows: [{ id: this.groupId, event_hint: 'Event' }] };
    if (text.startsWith('select pc.id, egi.event_group_id'))
      return {
        rows: this.rows
          .filter(
            (r) =>
              r.routing === 'event' &&
              (args[1] as string[]).includes(r.processedContentId) &&
              this.memberships.includes(r.processedContentId),
          )
          .map((r) => ({ id: r.processedContentId, event_group_id: this.groupId })),
      };
    if (text.startsWith("update processed_contents set routing='event'")) {
      const r = this.rows.find(
        (r) => r.processedContentId === args[0] && r.daily === args[1] && r.routing === 'digest',
      );
      if (r) r.routing = 'event';
      return { rows: [], rowCount: r ? 1 : 0 };
    }
    if (text.startsWith('insert into event_group_items')) {
      const id = String(args[1]);
      const found = this.memberships.includes(id);
      if (!found) this.memberships.push(id);
      return { rows: [], rowCount: found ? 0 : 1 };
    }
    if (text.startsWith('insert into feedback')) {
      this.feedbackRows.push({
        target_id: args[0],
        before: JSON.parse(String(args[1])),
        after: JSON.parse(String(args[2])),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('select id from processed_contents where daily_date'))
      return {
        rows: this.rows
          .filter(
            (r) =>
              r.daily === args[0] &&
              r.category === args[1] &&
              r.routing === 'digest' &&
              (args[2] as string[]).includes(r.processedContentId),
          )
          .map((r) => ({ id: r.processedContentId })),
      };
    if (text.includes('from event_groups eg')) {
      assert.ok(
        text.includes("membership_added'='true'"),
        'Ranking hash excludes only explicitly added Consolidation membership',
      );
      return {
        rows: [
          {
            eventGroupId: this.groupId,
            eventHint: 'Event',
            processedContentId: this.eventId,
            source: 'Source',
            title: 'Event',
            summary: 'Event summary',
          },
        ],
      };
    }
    if (text.includes('insert into event_review_items')) {
      this.review.set(String(args[0]), (this.review.get(String(args[0])) ?? 0) + 1);
      (this.reviewRows[String(args[0])] ??= []).push({
        event_group_id: args[3],
        ai_rank: args[5],
        member_content_ids: args[7],
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('count(*)::text as count from event_review_items'))
      return { rows: [{ count: String(this.review.get(String(args[0])) ?? 0) }] };
    if (text.includes('pc.id as "processedContentId"') && text.includes('pc.category,'))
      return {
        rows: this.rows
          .filter((r) => r.routing === args[0] && r.daily === args[1])
          .sort(
            (a, b) =>
              a.category.localeCompare(b.category) ||
              a.processedContentId.localeCompare(b.processedContentId),
          ),
      };
    if (text.includes('pc.id as "processedContentId"') && text.includes('ra.url'))
      return { rows: [{ processedContentId: this.eventId, url: 'https://example.com/event' }] };
    if (text.startsWith('select id as source_run_id, coalesce('))
      return {
        rows: Object.entries(this.details)
          .reverse()
          .filter(
            ([, d]) =>
              (d.digest_ranking as Record<string, Stage3Step> | undefined)?.[String(args[1])],
          )
          .map(([id, d]) => ({
            source_run_id: id,
            checkpoint: (d.digest_ranking as Record<string, Stage3Step>)[String(args[1])],
          })),
      };
    if (text.startsWith('select metrics->'))
      return {
        rows: Object.values(this.checkpoints)
          .reverse()
          .filter((c) => c[String(args[1])])
          .map((c) => ({ checkpoint: c[String(args[1])] })),
      };
    if (
      text.startsWith('select id,ai_rank from processed_contents') &&
      text.includes("routing='long_form'")
    )
      return {
        rows: this.rows
          .filter(
            (r) =>
              r.daily === args[0] &&
              r.routing === 'long_form' &&
              (args[1] as string[]).includes(r.processedContentId),
          )
          .map((r) => ({ id: r.processedContentId, ai_rank: r.ai })),
      };
    if (text.startsWith('select id,ai_rank from processed_contents'))
      return {
        rows: this.rows
          .filter(
            (r) =>
              r.daily === args[0] &&
              r.category === args[1] &&
              (args[2] as string[]).includes(r.processedContentId),
          )
          .map((r) => ({ id: r.processedContentId, ai_rank: r.ai })),
      };
    if (text.startsWith('select id from processed_contents'))
      return {
        rows: this.rows
          .filter(
            (r) =>
              (args[0] as string[]).includes(r.processedContentId) &&
              r.daily === args[1] &&
              r.category === args[2] &&
              r.routing === 'digest',
          )
          .map((r) => ({ id: r.processedContentId })),
      };
    if (text.startsWith('update processed_contents')) {
      if (this.persistFails) throw new Error('Mock rank database failure');
      if (Array.isArray(args[0])) {
        const rows = this.rows.filter((r) => (args[0] as string[]).includes(r.processedContentId));
        for (const row of rows) {
          const oldAi = row.ai;
          row.ai = null;
          if (row.display === null || (oldAi !== null && row.display === oldAi)) row.display = null;
        }
        return { rows: [], rowCount: rows.length };
      }
      const row = this.rows.find((r) => r.processedContentId === args[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.display = nextDisplayRankForAiRankUpdate(row.ai, row.display, args[1] as number);
      row.ai = args[1] as number;
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('update pipeline_runs set metrics=jsonb_set')) {
      if (this.checkpointFails) throw new Error('Mock checkpoint database failure');
      const record = (this.checkpoints[String(args[0])] ??= {});
      record[String(args[1])] = JSON.parse(String(args[2]));
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected Mock SQL: ${text}`);
  };
  pool = {
    query: this.query,
    connect: async () => ({
      query: this.query,
      release: () => {
        this.released++;
      },
    }),
  } as unknown as Pool;
  warnings = {
    duplicateIds: [],
    missingIds: [],
    inventedIds: [],
    modelValidIdCount: 1,
    fallbackIdCount: 0,
    rankNormalizationCount: 0,
  };
  metrics = {
    calls: 1,
    retries: 0,
    durationMs: 1,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedInputTokens: 0,
      usageComplete: true,
    },
  };
  rankers = {
    consolidation: async (input: ConsolidationInput) => {
      this.consolidationCalls.push(input.category);
      if (this.consolidationFails === input.category)
        throw new ConsolidationCallError('Mock consolidation API failure', this.metrics);
      return {
        ...this.metrics,
        output: {
          matches:
            this.consolidateMatches && input.category === 'Company'
              ? [
                  {
                    event_group_id: this.groupId,
                    digest_content_ids: input.candidates.map((c) => c.id),
                  },
                ]
              : [],
        },
      };
    },
    events: async (input: { events: { id: string }[] }, options: { memoryContext?: string }) => {
      this.memoryContexts.push(options.memoryContext);
      this.eventCalls++;
      return {
        ...this.metrics,
        warnings: this.warnings,
        diagnostics: {
          input_event_count: input.events.length,
          returned_ranking_count: input.events.length,
        },
        output: {
          rankings: input.events.map((e, i) => ({ id: e.id, rank: i + 1, reason: 'Event' })),
        },
      };
    },
    digest: async (
      input: { category: string; candidates: { id: string }[] },
      options: { memoryContext?: string },
    ) => {
      this.memoryContexts.push(options.memoryContext);
      this.calls.push(input.category);
      assert.ok(categories.includes(input.category), 'Correction before model');
      if (input.category === 'General' && this.generalFails)
        throw new Stage3RankingFailureError('General', {
          success: false,
          input,
          attempts: 1,
          elapsedMs: 2,
          error: 'Mock API failure',
          assignment: null,
          diagnostics: {
            initial: {
              input_tokens: 10,
              output_tokens: 0,
              total_tokens: 10,
              cached_input_tokens: 0,
            },
            repair: null,
          },
        } as never);
      return {
        ...this.metrics,
        warnings: this.warnings,
        diagnostics: { category: input.category, input_count: input.candidates.length },
        output: {
          rankings: input.candidates.map((c, i) => ({ id: c.id, rank: i + 1, reason: 'Digest' })),
        },
      };
    },
    longForm: async (
      input: { candidates: { id: string }[] },
      options: { memoryContext?: string },
    ) => {
      this.memoryContexts.push(options.memoryContext);
      this.longCalls++;
      return {
        ...this.metrics,
        warnings: this.warnings,
        output: {
          rankings: input.candidates.map((c, i) => ({
            id: c.id,
            rank: i + 1,
            reason: 'Long-form',
          })),
        },
      };
    },
  } as unknown as NonNullable<Parameters<typeof processStage3>[1]>['rankers'];
  async run(root: string, onRuntimeCreated?: (directory: string) => Promise<void>) {
    return processStage3(this.pool, {
      dailyDate: date,
      rootDir: root,
      onRuntimeCreated,
      pipelineRunId: randomUUID(),
      rankers: this.rankers,
    });
  }
}
const root = await mkdtemp(join(tmpdir(), 'stage3-category-'));
try {
  const store = new Store();
  const invalid = {
    ...store.rows[0],
    processedContentId: randomUUID(),
    category: 'Long-form',
    title: 'Bad Digest',
    url: 'https://example.com/invalid-digest',
  };
  store.rows.push(invalid);
  store.rows.push({ ...invalid, processedContentId: randomUUID(), daily: '2026-10-28' });
  const manual = store.rows.find((r) => r.category === 'Policy')!;
  manual.ai = 9;
  manual.display = 1;
  store.generalFails = true;
  const observationErrors: unknown[][] = [];
  const logError = console.error;
  console.error = (...args) => {
    observationErrors.push(args);
  };
  let first: Awaited<ReturnType<Store['run']>>;
  try {
    first = await store.run(root, async (directory) => {
      assert.match(directory, /runtime\/stage3\//);
      throw new Error('Mock Runtime observation failure');
    });
  } finally {
    console.error = logError;
  }
  assert.equal(
    observationErrors.length,
    1,
    'Runtime observation failure is logged, not propagated',
  );
  assert.equal(store.memoryReads, 1);
  assert.equal(store.memoryContexts.length, 8, 'Event, six Digest categories and Long-form');
  assert.ok(
    store.memoryContexts.every(
      (m) => m === formatMemories([{ type: 'content', content: 'content preference' }]),
    ),
  );
  assert.equal(first.status, 'partial');
  assert.equal(first.categoryCorrections.length, 1);
  assert.equal(invalid.category, 'General');
  assert.equal(store.rows.at(-1)!.category, 'Long-form', 'Other Daily untouched');
  assert.equal(store.rows.find((r) => r.routing === 'long_form')!.category, 'Long-form');
  assert.equal(first.categoryCorrections[0].original_category, 'Long-form');
  assert.equal(first.categoryCorrections[0].corrected_category, 'General');
  for (const category of categories.filter((c) => c !== 'General'))
    assert.ok(
      store.rows
        .filter((r) => r.daily === date && r.routing === 'digest' && r.category === category)
        .every((r) => r.ai !== null),
    );
  assert.equal(manual.display, 1);
  assert.equal(store.longCalls, 1);
  assert.equal(store.eventCalls, 1);
  // Simulate loss of category files after a successful database commit. The marker is sufficient.
  await rm(join(first.runDir, 'digest/company-ranking-output.json'));
  await rm(join(first.runDir, 'digest/company-status.json'));
  const oldPromptId = store.prompts.active.get('daily.stage3.digest_ranking')!;
  const oldPrompt = store.prompts.versions.get(oldPromptId)!;
  const activated = { ...oldPrompt, id: randomUUID(), version: oldPrompt.version + 1 };
  store.prompts.versions.set(activated.id, activated);
  store.prompts.active.set(activated.key, activated.id);
  const before = store.calls.length;
  store.generalFails = false;
  store.memoryContent = 'updated content preference';
  const beforeContexts = store.memoryContexts.length;
  const second = await store.run(root);
  assert.equal(store.memoryReads, 2);
  assert.deepEqual(
    store.memoryContexts.slice(beforeContexts),
    [formatMemories([{ type: 'content', content: 'updated content preference' }])],
    'Only failed General reexecutes, with fresh Memory',
  );
  assert.equal(second.status, 'success');
  const secondFile = JSON.parse(await readFile(join(second.runDir, 'run.json'), 'utf8'));
  assert.equal(
    secondFile.promptVersionIds['daily.stage3.digest_ranking'],
    oldPromptId,
    'Changed category shares the original Request version, not new Active',
  );
  assert.deepEqual(store.calls.slice(before), ['General']);
  assert.equal(second.digestCategories.Company.reused, 'database');
  assert.equal(second.categoryCorrections.length, 0);
  assert.equal(second.llmCallCount, 1);
  assert.equal(store.longCalls, 1);
  assert.equal(store.eventCalls, 1, 'Event snapshot reused');
  assert.equal(second.rankingStatuses.long_form, 'skipped');
  for (const category of categories) {
    const ranks = store.rows
      .filter((r) => r.daily === date && r.routing === 'digest' && r.category === category)
      .map((r) => r.ai!)
      .sort((a, b) => a - b);
    assert.deepEqual(
      ranks,
      ranks.map((_, i) => i + 1),
    );
  }
  // Only a changed category is invalidated; other inputs remain independent.
  store.rows.find((r) => r.category === 'Company' && r.daily === date)!.summary = 'Changed summary';
  const beforeChange = store.calls.length;
  const third = await store.run(root);
  assert.equal(third.status, 'success');
  assert.deepEqual(store.calls.slice(beforeChange), ['Company']);
  // A corrupt committed business rank cannot be trusted solely because a marker exists.
  store.rows.find((r) => r.category === 'Technology' && r.daily === date)!.ai = 99;
  const repaired = await store.run(root);
  assert.equal(
    repaired.digestCategories.Technology.reused,
    'artifact',
    'Verified artifact is re-committed instead of claiming database success',
  );
  assert.ok(
    store.rows
      .filter((r) => r.category === 'Technology' && r.daily === date)
      .every((r) => r.ai !== 99),
  );
  // Stage3 exact dedup is removed: a new same-URL candidate remains in category ranking.
  const winner = store.rows.find((r) => r.category === 'Company' && r.daily === date)!;
  const duplicate = {
    ...winner,
    processedContentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    sourcePriority: 'tier_2',
    ai: 99,
    display: 99,
  };
  store.rows.push(duplicate);
  const deduped = await store.run(root);
  assert.equal(deduped.digestCategories.Company.reused, null);
  assert.ok(
    duplicate.ai !== null && duplicate.ai !== 99,
    'Same URL does not remove a Stage3 candidate',
  );
  const emptyStore = new Store();
  for (const r of emptyStore.rows.filter((r) => r.category === 'Technology')) {
    r.url = 'https://example.com/event';
    r.ai = 99;
    r.display = 99;
  }
  const emptyResult = await emptyStore.run(await mkdtemp(join(root, 'empty-')));
  assert.equal(emptyResult.status, 'success');
  assert.ok(
    emptyStore.calls.includes('Technology'),
    'Same Event URL no longer removes a Digest category',
  );
  assert.ok(
    emptyStore.rows
      .filter((r) => r.category === 'Technology')
      .every((r) => r.ai !== null && r.ai !== 99),
  );
  // Business commit and marker are one transaction: marker failure rolls ranks back.
  const broken = new Store();
  broken.checkpointFails = true;
  const failed = await broken.run(await mkdtemp(join(root, 'failure-')));
  assert.equal(failed.status, 'failed');
  assert.ok(broken.rows.filter((r) => r.routing === 'digest').every((r) => r.ai === null));
  assert.equal(Object.keys(broken.checkpoints).length, 0);
  assert.ok(broken.released > 0);
  broken.checkpointFails = false;
  const retryCommit = await broken.run(join(root, 'commit-retry'));
  // Different directory cannot accidentally find old artifacts; committed success is not fabricated.
  assert.equal(retryCommit.status, 'success');
  const badCorrection = new Store();
  badCorrection.correctionFails = true;
  const stopped = await badCorrection.run(await mkdtemp(join(root, 'correction-')));
  assert.equal(stopped.status, 'failed');
  assert.equal(badCorrection.calls.length, 0);
  assert.equal(badCorrection.eventCalls, 0);
  // A correction alone is a warning, never PARTIAL.
  const clean = new Store();
  clean.rows[0].category = 'Long-form';
  const cleanResult = await clean.run(await mkdtemp(join(root, 'clean-')));
  assert.equal(cleanResult.status, 'success');
  assert.equal(cleanResult.warningCount, 1);
  // Legacy PARTIAL category files may be promoted only after exact input/UUID validation.
  const legacyRoot = await mkdtemp(join(root, 'legacy-'));
  const legacy = new Store();
  legacy.generalFails = true;
  const legacyFirst = await legacy.run(legacyRoot);
  legacy.checkpoints = {};
  legacy.details = {}; // Simulate old Runs that predate durable category markers.
  for (const row of legacy.rows) row.ai = null;
  legacy.generalFails = false;
  const legacyBefore = legacy.calls.length;
  const legacyRetry = await legacy.run(legacyRoot);
  assert.equal(legacyRetry.status, 'success');
  assert.deepEqual(legacy.calls.slice(legacyBefore), ['General']);
  assert.equal(legacyRetry.digestCategories.Company.reused, 'artifact');
  assert.equal(
    legacyRetry.digestCategories.Company.source_run_id,
    legacyFirst.runDir.split('/').at(-1),
  );
  for (const category of categories.filter((c) => c !== 'General')) {
    assert.equal(legacyRetry.digestCategories[category].llm_calls, 0);
    assert.equal(
      legacyRetry.digestCategories[category].input_tokens,
      0,
      'No historical tokens charged to this attempt',
    );
    assert.equal(legacyRetry.digestCategories[category].output_tokens, 0);
  }
  // One isolated old Run: verify each rejection independently without fallback to another valid Run.
  const auditRoot = await mkdtemp(join(root, 'artifact-audit-'));
  const auditDir = join(auditRoot, 'runtime/stage3', legacyFirst.runDir.split('/').at(-1)!);
  await mkdir(join(auditRoot, 'runtime/stage3'), { recursive: true });
  await cp(legacyFirst.runDir, auditDir, { recursive: true });
  const auditRead = async (name: string) =>
    JSON.parse(await readFile(join(auditDir, name), 'utf8'));
  const source = await auditRead('run.json');
  const categoryInput = await auditRead('digest/company-input.json');
  const sourceMap = (await auditRead('id-map.json')).digest.Company;
  const categoryHash = stableDigestHash(categoryInput, sourceMap);
  const sourcePrompt = source.promptVersionIds['daily.stage3.digest_ranking'];
  const sourceSnapshot = source.systemFragmentVersions;
  const probe = (
    hash = categoryHash,
    prompt = sourcePrompt,
    snapshot = sourceSnapshot,
    map = sourceMap,
  ) =>
    reusableDigestArtifact(
      auditRoot,
      join(auditRoot, 'runtime/stage3/not-created'),
      date,
      categoryInput,
      map,
      hash,
      prompt,
      snapshot,
    );
  assert.ok(await probe());
  assert.equal(await probe('incorrect-hash'), null);
  assert.equal(await probe(categoryHash, randomUUID()), null, 'Different Request UUID rejected');
  assert.equal(
    await probe(categoryHash, sourcePrompt, { ...sourceSnapshot, 'xfield.identity': randomUUID() }),
    null,
    'Different Fragment UUID rejected',
  );
  const changedMap = { ...sourceMap, D001: randomUUID() };
  assert.equal(
    await probe(
      stableDigestHash(categoryInput, changedMap),
      sourcePrompt,
      sourceSnapshot,
      changedMap,
    ),
    null,
    'Different content UUID rejected',
  );
  await writeFile(join(auditDir, 'run.json'), JSON.stringify({ ...source, run_id: 'another-run' }));
  assert.equal(await probe(), null, 'Directory and Run identity must agree');
  await writeFile(
    join(auditDir, 'run.json'),
    JSON.stringify({ ...source, daily_date: '2026-10-28' }),
  );
  assert.equal(await probe(), null, 'Different Daily rejected');
  await writeFile(join(auditDir, 'run.json'), JSON.stringify(source));
  const outputFile = join(auditDir, 'digest/company-ranking-output.json');
  const serialized = await readFile(outputFile, 'utf8');
  await rm(outputFile);
  assert.equal(await probe(), null, 'Missing output safely falls back');
  await writeFile(outputFile, '{');
  assert.equal(await probe(), null, 'Corrupt JSON safely falls back');
  const incomplete = JSON.parse(serialized);
  incomplete.rankings.pop();
  await writeFile(outputFile, JSON.stringify(incomplete));
  assert.equal(await probe(), null, 'Incomplete ranks rejected');
  const duplicated = JSON.parse(serialized);
  duplicated.rankings[1].id = duplicated.rankings[0].id;
  await writeFile(outputFile, JSON.stringify(duplicated));
  assert.equal(await probe(), null, 'Duplicate IDs rejected');
  const unknown = JSON.parse(serialized);
  unknown.rankings[0].id = 'unknown';
  await writeFile(outputFile, JSON.stringify(unknown));
  assert.equal(await probe(), null, 'Unknown IDs rejected');
  const wrongRank = JSON.parse(serialized);
  wrongRank.rankings[0].rank = 99;
  await writeFile(outputFile, JSON.stringify(wrongRank));
  assert.equal(await probe(), null, 'Non-contiguous ranks rejected');
  await writeFile(outputFile, serialized);
  // Incomplete paid artifacts are never normalized again and trusted as complete.
  const oldOutputPath = join(legacyFirst.runDir, 'digest/company-ranking-output.json');
  const oldOutput = JSON.parse(await readFile(oldOutputPath, 'utf8'));
  oldOutput.rankings.pop();
  await writeFile(oldOutputPath, JSON.stringify(oldOutput));
  assert.equal(
    strictDigestOutput(oldOutput, {
      category: 'Company',
      candidates: [
        { id: 'D001', title: 'x', summary: 'x', source: 'x' },
        { id: 'D002', title: 'x', summary: 'x', source: 'x' },
      ],
    }),
    null,
  );
  // Prove deterministic effective input hashing, including identity and input order.
  const input = {
    category: 'General',
    candidates: [{ id: 'D001', title: 'Title', summary: 'Summary', source: 'Source' }],
  };
  const map = { D001: randomUUID() };
  assert.equal(
    stableDigestHash(input, map),
    stableDigestHash({ candidates: input.candidates, category: input.category }, map),
  );
  assert.notEqual(stableDigestHash(input, map), stableDigestHash(input, { D001: randomUUID() }));
  assert.equal(
    strictDigestOutput({ rankings: [{ id: 'unknown', rank: 1, reason: 'x' }] }, input),
    null,
  );
  assert.equal(
    strictDigestOutput({ rankings: [{ id: 'D001', rank: 2, reason: 'x' }] }, input),
    null,
  );
  // Finishing a Stage3 summary must preserve atomically committed markers, even on failure.
  let finishSql = '';
  await finishPipelineRun(
    {
      query: async (sql: string) => {
        finishSql = sql;
        return { rows: [] };
      },
    } as unknown as Pool,
    randomUUID(),
    { status: 'partial', mergeMetrics: true },
  );
  assert.match(finishSql, /metrics=metrics \|\| \$6/);
  // Consolidation commits routing, membership, feedback and a marker together; snapshot members stay immutable.
  const consolidationRoot = await mkdtemp(join(root, 'consolidation-'));
  const consolidated = new Store();
  consolidated.consolidateMatches = true;
  consolidated.consolidationFails = 'Finance & Economy';
  const partialConsolidation = await consolidated.run(consolidationRoot);
  assert.equal(partialConsolidation.status, 'partial');
  assert.equal(consolidated.feedbackRows.length, 2);
  assert.ok(
    consolidated.rows.filter((r) => r.category === 'Company').every((r) => r.routing === 'event'),
  );
  assert.equal(consolidated.consolidationCalls.includes('Science'), false);
  const oldReview = partialConsolidation.eventReviewRunId!;
  assert.deepEqual(consolidated.reviewRows[oldReview][0].member_content_ids, [
    consolidated.eventId,
  ]);
  const selection = await loadLatestStage4Selection(consolidated.pool, date, 15);
  assert.equal(
    selection[0].processedContentIds.length,
    3,
    'Stage4 reads current Group membership, including both routed Digest members',
  );
  const beforeConsolRetry = consolidated.consolidationCalls.length;
  consolidated.consolidationFails = null;
  // Remove ALL diagnostic artifacts: the successful Event, Consolidation and Long-form states are in PostgreSQL.
  await rm(join(consolidationRoot, 'runtime'), { recursive: true, force: true });
  const consolidatedRetry = await consolidated.run(consolidationRoot);
  assert.equal(consolidatedRetry.status, 'success');
  assert.equal(consolidatedRetry.eventReviewRunId, oldReview);
  assert.equal(consolidated.eventCalls, 1);
  assert.equal(consolidated.longCalls, 1);
  assert.deepEqual(consolidated.consolidationCalls.slice(beforeConsolRetry), ['Finance & Economy']);
  assert.equal(
    consolidated.feedbackRows.length,
    2,
    'Retry does not duplicate feedback or membership',
  );
  const lastDetails = Object.values(consolidated.details).at(-1)!;
  assert.equal((lastDetails.consolidation as Record<string, Stage3Step>).Company.status, 'skipped');
  assert.equal(
    (lastDetails.consolidation as Record<string, Stage3Step>).Science.reason,
    'science_excluded',
  );
  assert.ok((lastDetails.consolidation as Record<string, Stage3Step>).Company.source_run_id);
  const rollbackConsol = new Store();
  rollbackConsol.consolidateMatches = true;
  rollbackConsol.consolidationCommitFails = true;
  const rollbackRoot = await mkdtemp(join(root, 'consol-rollback-'));
  const rolledBack = await rollbackConsol.run(rollbackRoot);
  assert.equal(rolledBack.status, 'failed');
  assert.equal(rolledBack.llmCallCount, 2);
  assert.equal(rollbackConsol.feedbackRows.length, 0);
  assert.equal(rollbackConsol.memberships.length, 0);
  assert.ok(rollbackConsol.rows.every((r) => r.category !== 'Company' || r.routing === 'digest'));
  const failedState = (
    Object.values(rollbackConsol.details).at(-1)!.consolidation as Record<string, Stage3Step>
  ).Company;
  assert.equal(failedState.status, 'failed');
  assert.equal(failedState.failure_phase, 'persistence');
  rollbackConsol.consolidationCommitFails = false;
  assert.equal((await rollbackConsol.run(rollbackRoot)).status, 'success');
  assert.equal(
    rollbackConsol.consolidationCalls.filter((c) => c === 'Company').length,
    2,
    'LLM reruns after a rolled-back consolidation',
  );
  const downstream = new Store();
  downstream.consolidateMatches = true;
  downstream.generalFails = true;
  const downstreamRoot = await mkdtemp(join(root, 'downstream-'));
  assert.equal((await downstream.run(downstreamRoot)).status, 'partial');
  const callsBefore = downstream.consolidationCalls.length;
  downstream.generalFails = false;
  assert.equal((await downstream.run(downstreamRoot)).status, 'success');
  assert.equal(
    downstream.consolidationCalls.length,
    callsBefore,
    'Digest ranking failure does not invalidate committed consolidation',
  );
  const emptyMemory = new Store();
  emptyMemory.memoryContent = null;
  assert.equal((await emptyMemory.run(join(root, 'empty-memory'))).status, 'success');
  assert.ok(emptyMemory.memoryContexts.every((context) => context === ''));
  const failedMemory = new Store();
  failedMemory.memoryReadFails = true;
  const memoryFailure = await failedMemory.run(join(root, 'failed-memory'));
  assert.equal(memoryFailure.status, 'failed');
  assert.match(memoryFailure.error!, /Mock Memory read failure/);
  assert.equal(failedMemory.memoryContexts.length, 0, 'No ranking on Memory DB failure');
  console.log(
    'PASS Stage3 category recovery: scoped correction, partial independent commits, precise Retry/hash invalidation, durable atomic markers, strict ranks, Event/Long-form reuse and human rank protection',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
