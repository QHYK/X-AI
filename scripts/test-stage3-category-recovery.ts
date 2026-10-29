import assert from 'node:assert/strict';
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
    if (text === 'begin') {
      this.snapshot = structuredClone({
        rows: this.rows,
        checkpoints: this.checkpoints,
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
        };
        this.rows = s.rows;
        this.checkpoints = s.checkpoints;
        this.review = new Map(s.review);
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
    if (text.includes('from event_groups eg'))
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
    if (text.includes('insert into event_review_items')) {
      this.review.set(String(args[0]), (this.review.get(String(args[0])) ?? 0) + 1);
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
    if (text.startsWith('select metrics->'))
      return {
        rows: Object.values(this.checkpoints)
          .reverse()
          .filter((c) => c[String(args[1])])
          .map((c) => ({ checkpoint: c[String(args[1])] })),
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
    events: async (input: { events: { id: string }[] }) => {
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
    digest: async (input: { category: string; candidates: { id: string }[] }) => {
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
    longForm: async (input: { candidates: { id: string }[] }) => {
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
  const second = await store.run(root);
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
  // A newly deduplicated-away member must not retain an old rank when the winner's input hash is unchanged.
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
  assert.equal(deduped.digestCategories.Company.reused, 'database');
  assert.equal(duplicate.ai, null, 'Stale duplicate cleared in its own category');
  const emptyStore = new Store();
  for (const r of emptyStore.rows.filter((r) => r.category === 'Technology')) {
    r.url = 'https://example.com/event';
    r.ai = 99;
    r.display = 99;
  }
  const emptyResult = await emptyStore.run(await mkdtemp(join(root, 'empty-')));
  assert.equal(emptyResult.status, 'success');
  assert.ok(
    !emptyStore.calls.includes('Technology'),
    'Entire deduplicated-away category needs no LLM',
  );
  assert.ok(emptyStore.rows.filter((r) => r.category === 'Technology').every((r) => r.ai === null));
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
  legacy.checkpoints = {}; // Simulate old Runs that predate durable category markers.
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
  console.log(
    'PASS Stage3 category recovery: scoped correction, partial independent commits, precise Retry/hash invalidation, durable atomic markers, strict ranks, Event/Long-form reuse and human rank protection',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
