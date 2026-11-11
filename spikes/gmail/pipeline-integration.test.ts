/** Offline integration against an explicit transactional Pool mock. Never loads env or connects to PostgreSQL. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newsletterRawArticles } from '../../src/collectors/gmail/adapter.js';
import type { NewsletterMail } from '../../src/collectors/gmail/newsletter-source.js';
import { createReviewStore } from './review-data.js';
import { persistNewsletterArticles } from '../../src/collectors/newsletter.js';
import type { NormalizedRawArticle } from '../../src/collectors/raw-articles.js';
import {
  NEWSLETTER_PROCESSABLE_SQL,
  NON_EMAIL_SOURCE_SQL,
} from '../../src/collectors/newsletter-content.js';
import {
  completeRawArticleContent,
  countCompletionCandidates,
  loadCompletionCandidates,
} from '../../src/processing/content-completion.js';
import { ignorePreStage1ExactDuplicates } from '../../src/processing/pre-stage1-exact-duplicates.js';
import {
  loadPendingStage1Articles,
  loadStage1EvaluationArticles,
  loadStage1EvaluationArticlesByIds,
} from '../../src/processing/stage1-job.js';
import {
  buildStage1BatchInput,
  type Stage1ArticleRow,
} from '../../src/processing/stage1-contract.js';

import { GMAIL_BASELINE as samples } from '../../scripts/fixtures/gmail-baseline.js';
const scope = { startAt: '2026-10-01T00:00:00Z', endAt: '2026-12-01T00:00:00Z' };
type Source = { id: string; name: string; method: string; enabled: boolean };
type Row = NormalizedRawArticle & { id: string; sourceId: string; status: string };
const kind = (r: NormalizedRawArticle) =>
  (r.metadata?.newsletter as { content_type?: string } | undefined)?.content_type;

/** SQL shape assertions test the real query contracts; predicates below simulate DB results, not SQL execution. */
class TestDatabase {
  sources = new Map<string, Source>();
  rows: Row[] = [];
  connected = 0;
  released = 0;
  failInsertAt = 0;
  failCommit = false;
  failLock = false;
  private tails = new Map<string, Promise<void>>();
  pool = {
    query: (sql: string, values: unknown[] = []) => this.query(sql, values),
    connect: () => this.connect(),
  } as unknown as Pool;
  addSource(name: string, method = 'Email') {
    const id = randomUUID();
    this.sources.set(id, { id, name, method, enabled: true });
    return id;
  }
  addRow(sourceId: string, value: NormalizedRawArticle) {
    const row = { ...value, sourceId, id: randomUUID(), status: 'pending' };
    this.rows.push(row);
    return row;
  }
  private async connect() {
    this.connected++;
    let staged: Row[] = [],
      releaseLock: (() => void) | undefined;
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (sql === 'begin isolation level read committed') return { rows: [] };
        if (sql === "set local lock_timeout = '5s'") return { rows: [] };
        if (sql.includes('for update')) {
          assert.match(sql, /enabled = true/);
          assert.match(sql, /lower\(btrim\(collection_method\)\) = 'email'/);
          if (this.failLock) throw new Error('55P03: simulated lock timeout');
          const id = String(values[0]);
          const previous = this.tails.get(id) ?? Promise.resolve();
          this.tails.set(
            id,
            new Promise<void>((resolve) => {
              releaseLock = resolve;
            }),
          );
          await previous;
          const source = this.sources.get(id);
          return {
            rows: source?.enabled && source.method.trim().toLowerCase() === 'email' ? [{ id }] : [],
          };
        }
        if (sql.startsWith('select id from raw_articles')) {
          return {
            rows: [...this.rows, ...staged]
              .filter((r) => r.sourceId === values[0] && r.sourceItemOriginId === values[1])
              .map((r) => ({ id: r.id })),
          };
        }
        if (sql.includes('insert into raw_articles')) {
          assert.ok(releaseLock, 'Source row lock must precede inserts');
          if (this.failInsertAt && staged.length + 1 === this.failInsertAt)
            throw new Error('simulated insert failure');
          const [sourceId, origin, title, url, author, publishedAt, body, image, tags, metadata] =
            values;
          staged.push({
            id: randomUUID(),
            sourceId: String(sourceId),
            sourceItemOriginId: origin as string,
            title: String(title),
            url: url as string | null,
            author: author as string | null,
            publishedAt: publishedAt as Date,
            contentText: body as string,
            imageUrl: image as string | null,
            sourceTags: tags as string[] | null,
            metadata: JSON.parse(String(metadata)),
            status: 'pending',
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql === 'commit') {
          if (this.failCommit) throw new Error('simulated commit failure');
          this.rows.push(...staged);
          staged = [];
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql === 'rollback') {
          staged = [];
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        throw new Error(`Unexpected transaction query: ${sql}`);
      },
      release: () => {
        assert.equal(staged.length, 0);
        assert.equal(releaseLock, undefined);
        this.released++;
      },
    };
  }
  private async query(sql: string, values: unknown[]) {
    if (sql.includes("set stage1_status = 'ignored'")) {
      const ids = values[0] as string[];
      for (const r of this.rows)
        if (ids.includes(r.id) && r.status === 'pending') r.status = 'ignored';
      return { rows: [] };
    }
    assert.ok(
      sql.includes(NEWSLETTER_PROCESSABLE_SQL),
      'All content input queries must exclude persisted non_content',
    );
    let rows = this.rows.filter((r) => kind(r) !== 'non_content');
    if (sql.includes('source_rank') || sql.includes('select count(*)')) {
      assert.ok(sql.includes(NON_EMAIL_SOURCE_SQL), 'Completion must exclude every Email Source');
      const threshold = Number(values[1]);
      rows = rows.filter(
        (r) =>
          this.sources.get(r.sourceId)!.method.trim().toLowerCase() !== 'email' &&
          r.status === 'pending' &&
          r.url !== null &&
          (r.contentText?.trim().length ?? 0) < threshold,
      );
      return sql.includes('select count(*)')
        ? { rows: [{ count: rows.length }] }
        : {
            rows: rows.map((r) => ({
              id: r.id,
              sourceName: this.sources.get(r.sourceId)!.name,
              title: r.title,
              url: r.url,
              contentText: r.contentText,
            })),
          };
    }
    if (sql.includes('as "newsletterContentType"')) {
      rows = rows.filter((r) =>
        sql.includes("interval '72 hours'")
          ? r.publishedAt! < new Date(String(values[0])) &&
            r.publishedAt! >= new Date(new Date(String(values[0])).getTime() - 72 * 3600000)
          : r.status === 'pending' &&
            r.publishedAt! >= new Date(String(values[0])) &&
            r.publishedAt! < new Date(String(values[1])),
      );
      return {
        rows: rows.map((r) => ({
          ...r,
          sourceName: this.sources.get(r.sourceId)!.name,
          newsletterContentType: kind(r),
        })),
      };
    }
    if (sql.includes('sourceCategory')) {
      if (sql.includes("in ('pending', 'failed')"))
        rows = rows.filter((r) => ['pending', 'failed'].includes(r.status));
      if (sql.includes('any($1::uuid[])'))
        rows = rows.filter((r) => (values[0] as string[]).includes(r.id));
      else
        rows = rows.filter(
          (r) =>
            r.publishedAt! >= new Date(String(values[0])) &&
            r.publishedAt! < new Date(String(values[1])),
        );
      return {
        rows: rows.map(
          (r) =>
            ({
              id: r.id,
              title: r.title,
              url: r.url,
              author: r.author,
              contentText: r.contentText,
              publishedAt: r.publishedAt,
              sourceTags: r.sourceTags,
              sourceName: this.sources.get(r.sourceId)!.name,
              sourceCategory: 'General',
              sourceType: 'Newsletter',
              sourcePriority: 'Medium',
              eventCandidate: true,
              sourceDigestCandidate: true,
              sourceAvailability: 'Free',
              sourceLanguage: 'EN',
            }) satisfies Stage1ArticleRow,
        ),
      };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Network access is forbidden in the newsletter offline test');
};
try {
  const db = new TestDatabase();
  const batches: { sourceId: string; articles: NormalizedRawArticle[] }[] = [];
  const summary = [];
  const review = createReviewStore();
  for (const [source, id, total, standalone, external, nonContent] of samples) {
    const mail: NewsletterMail = JSON.parse(
      await readFile(`runtime/spikes/gmail/parsed/${id}.json`, 'utf8'),
    );
    const articles = newsletterRawArticles(mail);
    const ui = await review.detail(id);
    assert.equal(articles.length, total);
    assert.deepEqual(
      articles.map((a) => a.title),
      ui.guidance.units.map((u) => u.title),
    );
    assert.deepEqual(
      articles.map((a) => a.contentText),
      ui.guidance.units.map((u) => u.content_text),
    );
    assert.deepEqual(
      articles.map((a) => (a.metadata!.newsletter as { links: unknown }).links),
      ui.guidance.units.map((u) => u.urls),
      'Preserve every existing link without selecting a different target',
    );
    assert.deepEqual(
      articles.map((a) => (a.metadata!.newsletter as { source_range: unknown }).source_range),
      ui.guidance.units.map((u) => u.source_range),
    );
    assert.deepEqual(
      [standalone, external, nonContent],
      ['standalone_content', 'external_reference', 'non_content'].map(
        (k) => articles.filter((a) => kind(a) === k).length,
      ),
    );
    assert.deepEqual(
      newsletterRawArticles(mail),
      articles,
      'Stable module identity on repeated parsing',
    );
    assert.ok(articles.every((a) => a.sourceItemOriginId!.includes(id)));
    assert.ok(!JSON.stringify(articles).includes('<html'));
    assert.ok(
      articles.every((a) => !('fullContentText' in a)),
      'Do not label a newsletter excerpt as linked article full text',
    );
    const sourceId = db.addSource(source);
    assert.deepEqual(await persistNewsletterArticles(db.pool, sourceId, articles), {
      inserted: total,
      skipped: 0,
    });
    batches.push({ sourceId, articles });
    summary.push({
      source,
      gmail_message_id: id,
      inserted: total,
      standalone,
      external,
      non_content: nonContent,
      null_url: articles.filter((a) => a.url === null).length,
    });
  }
  assert.equal(db.rows.length, 39);
  assert.deepEqual(
    ['standalone_content', 'external_reference', 'non_content'].map(
      (type) => db.rows.filter((row) => kind(row) === type).length,
    ),
    [28, 10, 1],
    'All three structural types survive database serialization',
  );
  for (const { sourceId, articles } of batches)
    assert.deepEqual(await persistNewsletterArticles(db.pool, sourceId, articles), {
      inserted: 0,
      skipped: articles.length,
    });
  assert.equal(db.rows.length, 39);
  const before = JSON.stringify(db.rows);
  const keys = ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_2', 'FIRECRAWL_API_KEY_3'] as const;
  const previousKeys = keys.map((k) => process.env[k]);
  keys.forEach((k, i) => {
    process.env[k] = `test-completion-${i}`;
  });
  let completion: Awaited<ReturnType<typeof completeRawArticleContent>>;
  try {
    completion = await completeRawArticleContent(db.pool);
  } finally {
    keys.forEach((k, i) => {
      if (previousKeys[i] === undefined) delete process.env[k];
      else process.env[k] = previousKeys[i];
    });
  }
  assert.equal(completion.candidateCount, 0);
  assert.equal(completion.remainingCount, 0);
  assert.equal(completion.firecrawlRequestCount, 0);
  assert.equal(JSON.stringify(db.rows), before, 'Email body and statuses remain unchanged');
  const dedup = await ignorePreStage1ExactDuplicates(db.pool, scope);
  assert.equal(dedup.inputCount, 38);
  assert.equal(dedup.duplicateCount, 0);
  const eligible = await loadPendingStage1Articles(db.pool, { publishedAtScope: scope });
  assert.equal(eligible.length, 38);
  assert.equal((await loadStage1EvaluationArticles(db.pool, scope)).length, 38);
  assert.equal(
    (
      await loadStage1EvaluationArticlesByIds(
        db.pool,
        db.rows.map((r) => r.id),
      )
    ).length,
    38,
  );
  const inputs = buildStage1BatchInput(eligible).articles;
  assert.equal(inputs.length, 38);
  assert.ok(
    inputs.some((a) => a.url === null && a.content.length > 0),
    'NULL URL standalone body reaches the real Stage 1 builder',
  );
  assert.equal(
    inputs.filter((a) => a.url === null).length,
    eligible.filter((a) => a.url === null).length,
  );
  assert.ok(!eligible.some((a) => kind(db.rows.find((r) => r.id === a.id)!) === 'non_content'));
  console.log(
    JSON.stringify(
      {
        samples: summary,
        persisted: 39,
        repeated_run_inserted: 0,
        stage1_inputs: 38,
        null_url_stage1_inputs: inputs.filter((a) => a.url === null).length,
        completion_requests: 0,
      },
      null,
      2,
    ),
  );

  // Cooperating concurrent writers hold the same existing Source row until commit.
  const concurrent = new TestDatabase();
  const concurrentSources = batches.map((_, i) => concurrent.addSource(`Concurrent Email ${i}`));
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      batches.map(({ articles }, i) =>
        persistNewsletterArticles(concurrent.pool, concurrentSources[i], articles),
      ),
    ).flat(),
  );
  assert.equal(
    results.reduce((n, r) => n + r.inserted, 0),
    39,
  );
  assert.equal(concurrent.rows.length, 39);
  assert.equal(concurrent.connected, concurrent.released);
  for (const failure of ['insert', 'commit', 'lock'] as const) {
    const failed = new TestDatabase(),
      source = failed.addSource('Failure Email');
    failed.failInsertAt = failure === 'insert' ? 2 : 0;
    failed.failCommit = failure === 'commit';
    failed.failLock = failure === 'lock';
    await assert.rejects(
      persistNewsletterArticles(failed.pool, source, batches[0].articles),
      /simulated/,
    );
    assert.equal(failed.rows.length, 0);
    assert.equal(failed.connected, failed.released);
    failed.failInsertAt = 0;
    failed.failCommit = false;
    failed.failLock = false;
    assert.equal(
      (await persistNewsletterArticles(failed.pool, source, batches[0].articles)).inserted,
      4,
    );
  }
  const wrongSource = db.addSource('Not Email', 'RSS');
  await assert.rejects(
    persistNewsletterArticles(db.pool, wrongSource, batches[0].articles),
    /Email Source/,
  );

  // Shared URL does not drop independent modules, including a standalone vs RSS title collision.
  const edges = new TestDatabase(),
    emailId = edges.addSource('Email', ' email '),
    rssId = edges.addSource('RSS', 'RSS');
  const article = (
    type: string,
    id: string,
    title: string,
    url: string | null,
    body = 'Short body',
  ): NormalizedRawArticle => ({
    ...batches[0].articles[0],
    sourceItemOriginId: `gmail:edge:${id}`,
    title,
    url,
    contentText: body,
    metadata: { newsletter: { gmail_message_id: 'edge', unit_id: id, content_type: type } },
  });
  await persistNewsletterArticles(edges.pool, emailId, [
    article('standalone_content', 'one', 'Shared title', 'https://example.test/shared'),
    article('standalone_content', 'two', 'Second module', 'https://example.test/shared'),
    article('external_reference', 'three', 'External article', 'https://example.test/external'),
    article('non_content', 'four', 'Non content', 'https://example.test/rss', 'x'.repeat(1000)),
  ]);
  for (const [title, url] of [
    ['Shared title', 'https://example.test/shared'],
    ['External article', 'https://example.test/external'],
    ['RSS short', 'https://example.test/rss'],
  ])
    edges.addRow(rssId, {
      ...article('external_reference', title, title, url, 'RSS '.repeat(50)),
      metadata: null,
    });
  const dedupEdges = await ignorePreStage1ExactDuplicates(edges.pool, scope);
  assert.equal(dedupEdges.inputCount, 6);
  assert.equal(
    dedupEdges.duplicateCount,
    1,
    'External reference reuses RSS exact dedup, standalone does not',
  );
  assert.equal(
    edges.rows.find((r) => r.sourceItemOriginId === 'gmail:edge:three')!.status,
    'ignored',
  );
  assert.ok(
    edges.rows.filter((r) => kind(r) === 'standalone_content').every((r) => r.status === 'pending'),
  );
  edges.addRow(emailId, {
    ...article(
      'external_reference',
      'legacy',
      'Legacy Email without parser metadata',
      'https://example.test/legacy',
      '',
    ),
    metadata: null,
  });
  assert.equal(
    await countCompletionCandidates(edges.pool),
    0,
    'All Email records, including legacy without parser metadata, skip completion',
  );
  const rssShort = edges.addRow(rssId, {
    ...article(
      'external_reference',
      'rssshort',
      'RSS needs completion',
      'https://example.test/short',
      '',
    ),
    metadata: null,
  });
  assert.equal(await countCompletionCandidates(edges.pool), 1);
  assert.deepEqual(
    (await loadCompletionCandidates(edges.pool, {})).map((r) => r.id),
    [rssShort.id],
  );
  assert.equal(db.connected, db.released);
  console.log(
    'PASS 39 source-guided units; all types stored; repeat/concurrent ingestion; transaction rollback; Email completion skip; persisted non_content exclusion; shared URLs; RSS dedup; NULL URL Stage 1 inputs. PostgreSQL behavior is mocked, not integration-verified.',
  );
} finally {
  globalThis.fetch = originalFetch;
}
