/** Daily Collection integration, entirely offline. Does not load credentials or execute any Stage LLM. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { runDailyCollection, type GmailCollectionSummary } from '../src/lib/daily-collection.js';
import type { RssCollectionSummary } from '../src/collectors/rss.js';
import { collectGmailNewsletters } from '../src/collectors/gmail/collector.js';
import { GMAIL_DEFAULT_QUERY } from '../src/collectors/gmail/runtime.js';
import { GMAIL_BASELINE } from './fixtures/gmail-baseline.js';
import { newsletterStore } from './fixtures/newsletter-store.js';
import { loadPendingStage1Articles } from '../src/processing/stage1-job.js';
import { countCompletionCandidates } from '../src/processing/content-completion.js';
const rss: RssCollectionSummary = {
  sourceCount: 2,
  successSourceCount: 2,
  failureSourceCount: 0,
  fetchedItemCount: 0,
  windowItemCount: 0,
  insertedItemCount: 0,
  skippedDuplicateCount: 0,
  skippedOutOfWindowCount: 0,
  skippedInvalidCount: 0,
  results: [],
};
const store = newsletterStore();
const messages = new Map<string, unknown>();
for (const [, id] of GMAIL_BASELINE)
  messages.set(id, JSON.parse(await readFile(`runtime/spikes/gmail/raw/${id}.json`, 'utf8')));
const now = new Date(
  Math.max(
    ...[...messages.values()].map((m) => Number((m as { internalDate: string }).internalDate)),
  ) + 1000,
);
const reader = {
  list: async () => ({ messages: [...messages.keys()].map((id) => ({ id })) }),
  get: async (id: string) => messages.get(id),
};
const collect = () =>
  collectGmailNewsletters(store.pool, reader, { query: GMAIL_DEFAULT_QUERY, limit: 20, now });
const order: string[] = [];
const healthy = await runDailyCollection({
  rss: async () => {
    order.push('rss');
    return rss;
  },
  gmail: async () => {
    order.push('gmail');
    return collect();
  },
  onResult: (name, outcome) => order.push(`${name}:${outcome.status}`),
});
assert.equal(healthy.status, 'success');
assert.deepEqual(order, ['rss', 'rss:success', 'gmail', 'gmail:success']);
assert.equal(healthy.gmail.summary!.newEmails, 7);
assert.equal(healthy.gmail.summary!.inserted, 39);
assert.equal(healthy.gmail.summary!.outcomes.success, 7);
const repeated = await runDailyCollection({ rss: async () => rss, gmail: collect });
assert.equal(repeated.gmail.summary!.newEmails, 0);
assert.equal(repeated.gmail.summary!.inserted, 0);
assert.equal(store.raws.length, 39);
const good = healthy.gmail.summary!;
for (const failure of ['gmail', 'rss'] as const) {
  const calls: string[] = [];
  const result = await runDailyCollection({
    rss: async () => {
      calls.push('rss');
      if (failure === 'rss')
        throw Object.assign(new Error('Do not log credential-bearing messages'), {
          response: { status: 503 },
        });
      return rss;
    },
    gmail: async () => {
      calls.push('gmail');
      if (failure === 'gmail') throw { response: { status: 503 } };
      return good;
    },
  });
  assert.deepEqual(calls, ['rss', 'gmail']);
  assert.equal(result.status, 'failed');
  assert.equal(result[failure].overall_failure, true);
  assert.equal(result[failure === 'rss' ? 'gmail' : 'rss'].status, 'success');
  assert.ok(!JSON.stringify(result).includes('credential-bearing'));
}
const apiFailure = await runDailyCollection({
  rss: async () => rss,
  gmail: () =>
    collectGmailNewsletters(
      store.pool,
      {
        list: async () => {
          throw { response: { status: 503 } };
        },
        get: reader.get,
      },
      { query: GMAIL_DEFAULT_QUERY, limit: 20, now },
    ),
});
assert.equal(apiFailure.status, 'failed');
assert.equal(apiFailure.gmail.overall_failure, true);
const unsupported: GmailCollectionSummary = {
  ...good,
  unsupported: 1,
  outcomes: { ...good.outcomes, unsupported: 1 },
  failures: [],
  warning_count: 1,
  warnings: [
    {
      type: 'unsupported_template',
      gmail_message_id: 'unsupported',
      stage: 'parse',
      message: 'No source-guided units: unrecognized template',
    },
  ],
};
const partial = await runDailyCollection({ rss: async () => rss, gmail: async () => unsupported });
assert.equal(partial.status, 'success');
assert.equal(partial.warning_count, 1);
assert.equal(partial.warnings[0].gmail_message_id, 'unsupported');
for (const failure of [
  {
    outcomes: { ...good.outcomes, failed: 1 },
    failures: [{ id: 'failure', stage: 'persist', error: 'operation_failed_23514' }],
  },
  { outcomes: { ...good.outcomes, conflict: 1 }, failures: [] },
  {
    outcomes: { ...good.outcomes, unsupported: 1 },
    failures: [{ id: 'badmime', stage: 'mime', error: 'MIME unavailable' }],
  },
  {
    outcomes: { ...good.outcomes, unsupported: 1 },
    failures: [
      { id: 'config', stage: 'source', error: 'Newsletter Source mapping missing or ambiguous' },
    ],
  },
  {
    outcomes: { ...good.outcomes, unsupported: 1 },
    failures: [
      { id: 'validation', stage: 'parse', error: 'Incomplete source-guided unit: missing title' },
    ],
  },
]) {
  const result = await runDailyCollection({
    rss: async () => rss,
    gmail: async () => ({ ...good, ...failure }),
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.warning_count, 0);
}
const skipped = await runDailyCollection({
  rss: async () => rss,
  gmail: async () => ({ ...good, outcomes: { ...good.outcomes, skipped: 1 } }),
});
assert.equal(skipped.status, 'success');
assert.equal(skipped.warning_count, 0);
assert.equal(partial.gmail.overall_failure, false);
assert.equal(partial.gmail.summary!.outcomes.success, 7);
const unsupportedMail = {
  id: 'unsupported_template',
  internalDate: String(now.getTime() - 1),
  payload: {
    mimeType: 'text/html',
    headers: [{ name: 'From', value: 'The Information <hello@theinformation.com>' }],
    body: { data: Buffer.from('<p>Unrecognized newsletter layout.</p>').toString('base64url') },
  },
};
const realUnsupported = await runDailyCollection({
  rss: async () => rss,
  gmail: () =>
    collectGmailNewsletters(
      store.pool,
      {
        list: async () => ({ messages: [{ id: unsupportedMail.id }] }),
        get: async () => unsupportedMail,
      },
      { query: GMAIL_DEFAULT_QUERY, limit: 20, now },
    ),
});
assert.equal(realUnsupported.status, 'success');
assert.equal(realUnsupported.warning_count, 1);
assert.equal(realUnsupported.warnings[0].gmail_message_id, 'unsupported_template');
assert.deepEqual(realUnsupported.gmail.summary!.failures, []);
assert.ok(store.emails.has('unsupported_template'));
assert.equal(store.raws.length, 39);
const rssPartial = await runDailyCollection({
  rss: async () => ({ ...rss, successSourceCount: 1, failureSourceCount: 1 }),
  gmail: async () => good,
});
assert.equal(rssPartial.status, 'partial');
const allRssFailed = await runDailyCollection({
  rss: async () => ({ ...rss, successSourceCount: 0, failureSourceCount: 2 }),
  gmail: async () => good,
});
assert.equal(allRssFailed.status, 'failed');
assert.equal(allRssFailed.gmail.status, 'success');
// The real Stage1 loader reads previously persisted Raw even when the current collectors return no new Raw.
const scope = {
  startAt: new Date(now.getTime() - 72 * 3600000).toISOString(),
  endAt: now.toISOString(),
};
const stageDb = {
  query: async (sql: string, args: unknown[]) => {
    assert.match(sql, /from raw_articles ra/);
    assert.match(sql, /stage1_status in \('pending', 'failed'\)/);
    assert.match(sql, /content_type.*non_content/);
    assert.ok(!/url is not null/.test(sql));
    return {
      rows: store.raws
        .filter(
          (r) =>
            (r.metadata.newsletter as { content_type: string }).content_type !== 'non_content' &&
            r.published_at! >= new Date(String(args[0])) &&
            r.published_at! < new Date(String(args[1])),
        )
        .map((r) => ({
          ...r,
          contentText: r.content_text,
          sourceName: 'Email',
          sourcePriority: 'Medium',
        })),
    };
  },
} as unknown as Pool;
const inputs = await loadPendingStage1Articles(stageDb, { publishedAtScope: scope });
assert.equal(inputs.length, 38);
assert.equal(inputs.filter((r) => r.url === null).length, 9);
const completionDb = {
  query: async (sql: string) => {
    assert.match(sql, /collection_method.*<> 'email'/);
    assert.match(sql, /content_type.*non_content/);
    return { rows: [{ count: 0 }] };
  },
} as unknown as Pool;
assert.equal(await countCompletionCandidates(completionDb), 0);
// Check the actual CLI connects collection status to fail-fast and final durable partial status.
const orchestrator = await readFile('scripts/run-daily-workflow.ts', 'utf8');
assert.match(orchestrator, /runDailyCollection/);
assert.match(orchestrator, /interactive: false/);
assert.match(orchestrator, /run\.collection\.status === 'failed' \? 1 : 0/);
assert.match(orchestrator, /run\.collection\?\.status === 'partial' \? 'partial' : 'success'/);
assert.match(orchestrator, /collection: collectionMetric\(run.collection\)/);
assert.match(orchestrator, /warning_count: run.warning_count/);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.scripts['collect:rss'], 'tsx scripts/collect-rss.ts');
assert.equal(pkg.scripts['collect:gmail'], 'tsx scripts/collect-gmail.ts');
assert.ok(!(await readFile('scripts/collect-rss.ts', 'utf8')).includes('gmail'));
assert.ok(!(await readFile('scripts/collect-gmail.ts', 'utf8')).includes('collectRssSources'));
assert.ok(!orchestrator.includes("runNpmScript('collect:gmail'"));
console.log(
  'PASS Daily RSS → Gmail order, independent reports/fatal isolation, partial status, API outage, repeat intake, existing DB pending Email input, NULL URLs, non_content exclusion and Email Completion skip. No external calls or production database.',
);
