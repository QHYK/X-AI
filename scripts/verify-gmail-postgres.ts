/** Explicit acceptance diagnostic: inspection is readonly; rollback mode never commits. No model/Gmail calls. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { Pool, type PoolClient } from 'pg';
import { GMAIL_BASELINE } from './fixtures/gmail-baseline.js';
import { newsletterRawArticles } from '../src/collectors/gmail/adapter.js';
import type { NewsletterMail } from '../src/collectors/gmail/newsletter-source.js';
import { loadNewsletterSources } from '../src/collectors/gmail/sources.js';
import { persistNewsletterArticlesInTransaction } from '../src/collectors/newsletter.js';
import { loadPendingStage1Articles } from '../src/processing/stage1-job.js';
import { countCompletionCandidates } from '../src/processing/content-completion.js';
import { buildStage1BatchInput } from '../src/processing/stage1-contract.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';

export async function loadGmailBaseline() {
  return Promise.all(
    GMAIL_BASELINE.map(async ([source, id, count]) => {
      const mail = JSON.parse(
        await readFile(`runtime/spikes/gmail/parsed/${id}.json`, 'utf8'),
      ) as NewsletterMail;
      const articles = newsletterRawArticles(mail);
      assert.equal(articles.length, count);
      return { source, id, articles };
    }),
  );
}
export async function inspectGmailDatabase(pool: Pool) {
  const c = await pool.connect();
  try {
    await c.query('begin read only');
    await c.query("set local statement_timeout='10s'");
    const identity = (
      await c.query(
        'select current_database() as database,current_user as role,pg_is_in_recovery() as replica',
      )
    ).rows[0];
    const sources = await loadNewsletterSources(c);
    const counts = (
      await c.query(
        `select s.id,s.name,count(ra.id)::int as raw_count from sources s left join raw_articles ra on ra.source_id=s.id where s.id=any($1::uuid[]) group by s.id order by s.name`,
        [[...new Set([...sources.values()].map((s) => s.id))]],
      )
    ).rows;
    const running = (
      await c.query(
        "select id,daily_date,step,started_at from pipeline_runs where status='running' and step in ('daily','stage1','content_completion','exact_duplicate_filter') order by started_at desc",
      )
    ).rows;
    const result = {
      identity,
      sources: [...sources].map(([template, s]) => ({ template, source: s.name, id: s.id })),
      counts,
      running,
    };
    await c.query('rollback');
    return result;
  } finally {
    try {
      await c.query('rollback');
    } finally {
      c.release();
    }
  }
}
export async function verifyGmailRollback(pool: Pool) {
  const samples = await loadGmailBaseline(),
    sources = await loadNewsletterSources(pool);
  const origins = samples.flatMap((s) => s.articles.map((a) => a.sourceItemOriginId!));
  const sourceIds = [...new Set([...sources.values()].map((s) => s.id))];
  const scope = {
    startAt: new Date(
      Math.min(...samples.flatMap((s) => s.articles.map((a) => a.publishedAt!.getTime()))),
    ).toISOString(),
    endAt: new Date(
      Math.max(...samples.flatMap((s) => s.articles.map((a) => a.publishedAt!.getTime()))) + 1,
    ).toISOString(),
  };
  const c = await pool.connect();
  let observer: PoolClient;
  try {
    observer = await pool.connect();
  } catch (error) {
    c.release();
    throw error;
  }
  const ownRows = (db: PoolClient) =>
    db.query<{
      id: string;
      url: string | null;
      metadata: { newsletter: { content_type: string } };
    }>(
      `select id,url,metadata from raw_articles where source_id=any($1::uuid[]) and source_item_origin_id=any($2::text[])`,
      [sourceIds, origins],
    );
  try {
    const before = await ownRows(observer);
    // Refuse to mingle the acceptance transaction with already-persisted baseline content.
    assert.equal(
      before.rows.length,
      0,
      'Baseline already exists; use readonly inspection, do not mutate historical rows',
    );
    await c.query('begin');
    await c.query("set local lock_timeout='2s'");
    await c.query("set local statement_timeout='10s'");
    let inserted = 0,
      repeatedSkipped = 0;
    const bySource = [];
    for (const s of samples) {
      const id = sources.get(s.source)!.id;
      const first = await persistNewsletterArticlesInTransaction(c, id, s.articles);
      inserted += first.inserted;
      repeatedSkipped += (await persistNewsletterArticlesInTransaction(c, id, s.articles)).skipped;
      bySource.push({ source: s.source, message_id: s.id, inserted: first.inserted });
    }
    assert.equal(inserted, 39);
    assert.equal(repeatedSkipped, 39);
    const rows = (await ownRows(c)).rows;
    assert.equal(rows.length, 39);
    assert.deepEqual(
      ['standalone_content', 'external_reference', 'non_content'].map(
        (k) => rows.filter((r) => r.metadata.newsletter.content_type === k).length,
      ),
      [28, 10, 1],
    );
    assert.equal(rows.filter((r) => r.url === null).length, 10);
    // Restrict the existing builders' SQL to this transaction's exact raw UUID set.
    const ids = rows.map((r) => r.id);
    const scoped = {
      query: (sql: string, args: unknown[] = []) =>
        c.query(sql.replace(/\bwhere\b/i, `where ra.id=any($${args.length + 1}::uuid[]) and`), [
          ...args,
          ids,
        ]),
    } as Pick<PoolClient, 'query'>;
    const stage1 = await loadPendingStage1Articles(scoped, { publishedAtScope: scope });
    assert.equal(stage1.length, 38);
    assert.equal(stage1.filter((r) => r.url === null).length, 9);
    assert.equal(buildStage1BatchInput(stage1).articles.length, 38);
    assert.equal(
      await countCompletionCandidates(scoped, {
        scopeStartAt: scope.startAt,
        scopeEndAt: scope.endAt,
      }),
      0,
    );
    assert.equal(
      (await ownRows(observer)).rows.length,
      0,
      'Other connections must never see uncommitted test content',
    );
    await observer.query('begin');
    await observer.query("set local lock_timeout='150ms'");
    await assert.rejects(
      persistNewsletterArticlesInTransaction(observer, sourceIds[0], []),
      (e: unknown) => (e as { code: string }).code === '55P03',
    );
    await observer.query('rollback');
    await c.query('rollback');
    // Same source lock is reusable after rollback, and no cross-connection commit is used.
    await observer.query('begin');
    await observer.query("set local lock_timeout='500ms'");
    await persistNewsletterArticlesInTransaction(observer, sourceIds[0], []);
    await observer.query('rollback');
    assert.equal((await ownRows(observer)).rows.length, 0);
    return {
      bySource,
      inserted_in_rolled_back_transaction: inserted,
      repeated_inserted: 0,
      repeated_skipped: repeatedSkipped,
      type_counts: [28, 10, 1],
      null_url_raw: 10,
      null_url_stage1: 9,
      stage1_inputs: 38,
      completion_candidates: 0,
      cross_connection_visible: 0,
      source_lock_timeout: '55P03',
      source_lock_released: true,
      committed_rows: 0,
    };
  } finally {
    try {
      await c.query('rollback');
      await observer.query('rollback');
    } finally {
      c.release();
      observer.release();
    }
  }
}
async function main() {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'inspect' } } });
  if (!['inspect', 'rollback'].includes(values.mode!))
    throw new Error('Only inspect or rollback is supported; no committed write mode');
  loadPipelineEnvironment();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const url = new URL(process.env.DATABASE_URL);
  console.log({
    target_host_fingerprint: createHash('sha256').update(url.hostname).digest('hex').slice(0, 12),
    mode: values.mode,
  });
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    console.log(
      JSON.stringify(
        values.mode === 'rollback'
          ? await verifyGmailRollback(pool)
          : await inspectGmailDatabase(pool),
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error('Gmail PostgreSQL verification failed', {
      code: e.code ?? 'unknown',
      reason:
        e instanceof assert.AssertionError
          ? e.message
          : 'Verification failed; no credentials or database error payload printed',
    });
    process.exitCode = 1;
  });
