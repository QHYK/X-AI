import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import {
  completeRawArticleContent,
  resolveContentCompletionLimits,
  splitCompletionCandidates,
  extractFirecrawlContent,
} from '../src/processing/content-completion.js';
for (const [count, a, b, c] of [
  [0, 0, 0, 0],
  [1, 1, 0, 0],
  [29, 29, 0, 0],
  [31, 30, 1, 0],
  [61, 30, 30, 1],
  [89, 30, 30, 29],
  [90, 30, 30, 30],
  [120, 30, 30, 30],
]) {
  const x = splitCompletionCandidates(Array.from({ length: count }, (_, i) => i));
  assert.deepEqual([x.A.length, x.B.length, x.C.length], [a, b, c]);
  assert.deepEqual(
    [...x.A, ...x.B, ...x.C],
    Array.from({ length: Math.min(count, 90) }, (_, i) => i),
  );
}
assert.equal(resolveContentCompletionLimits({ limit: 120 }).limit, 90);
const savedFetch = globalThis.fetch,
  savedTimer = globalThis.setTimeout;
const names = ['FIRECRAWL_API_KEY', 'FIRECRAWL_API_KEY_2', 'FIRECRAWL_API_KEY_3'] as const;
const savedKeys = names.map((n) => process.env[n]);
const candidate = (id: string) => ({
  id,
  sourceName: 'Fixture',
  title: id,
  url: `https://example.test/${id}`,
  contentText: null,
});
const text = (n: number) =>
  'Article reporting contains meaningful facts and independent analysis. '.repeat(n);
function db(candidates: ReturnType<typeof candidate>[]) {
  return {
    query: async (sql: string, args: unknown[] = []) => {
      if (sql.includes('select count(*)::int')) return { rows: [{ count: candidates.length }] };
      if (sql.includes('with ranked as')) return { rows: candidates };
      if (sql.includes('update raw_articles')) {
        if (args[3] === 'writefail')
          throw Object.assign(new Error('Mock SQL failure'), { code: '08006' });
        return { rows: [], rowCount: args[3] === 'missingrow' ? 0 : 1 };
      }
      throw new Error('Unexpected SQL');
    },
  } as unknown as Pool;
}
try {
  names.forEach((n, i) => {
    process.env[n] = `test-key-${i}`;
  });
  // Exercise the real limiter and retry paths without waiting minutes or making HTTP requests.
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) =>
    savedTimer(fn, (ms ?? 0) >= 1000 ? 1 : ms, ...args)) as typeof setTimeout;
  const assigned = new Map<string, number>();
  let active = 0,
    maxActive = 0;
  globalThis.fetch = (async (_url, init) => {
    const key = new Headers(init?.headers).get('Authorization')!;
    assigned.set(key, (assigned.get(key) ?? 0) + 1);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => savedTimer(r, 2));
    active--;
    return Response.json(
      key === 'Bearer test-key-0'
        ? { success: false, error: 'fixture denial' }
        : { success: true, markdown: text(4) },
      { status: key === 'Bearer test-key-0' ? 403 : 200 },
    );
  }) as typeof fetch;
  const progress: unknown[] = [];
  const summary = await completeRawArticleContent(
    db(Array.from({ length: 90 }, (_, i) => candidate(String(i)))),
    { limit: 90, concurrency: 2 },
    (m) => progress.push(m),
  );
  assert.deepEqual([...assigned.values()], [30, 30, 30]);
  assert.ok(maxActive >= 3);
  assert.equal(summary.successCount, 60);
  assert.equal(summary.failedCount, 30);
  assert.equal(summary.firecrawlRequestCount, 90);
  assert.deepEqual(
    summary.results.map((r) => r.pool),
    [...Array(30).fill('A'), ...Array(30).fill('B'), ...Array(30).fill('C')],
  );
  assert.equal(summary.poolMetrics.C.successCount, 30);
  assert.ok(progress.length > 90);
  const attempts = new Map<string, number>();
  globalThis.fetch = (async (_url, init) => {
    const id = new URL(JSON.parse(String(init?.body)).url).pathname.slice(1);
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    if (id === 'retry' && attempt === 1) return Response.json({ success: false }, { status: 500 });
    return Response.json({
      success: true,
      markdown: id === 'invalid' ? '# Brief\n\nSubscribe now' : text(id === 'long' ? 100 : 4),
    });
  }) as typeof fetch;
  const mixed = await completeRawArticleContent(
    db(['normal', 'invalid', 'retry', 'writefail', 'long', 'missingrow'].map(candidate)),
    { limit: 6 },
  );
  assert.equal(mixed.successCount, 3);
  assert.equal(mixed.unusableCount, 1);
  assert.equal(mixed.failedCount, 2);
  assert.equal(mixed.attemptedCount, 6);
  assert.equal(mixed.firecrawlRequestCount, 7);
  assert.equal(mixed.retryCount, 1);
  assert.equal(mixed.results.filter((r) => r.processingFailed).length, 2);
  const expected = [text(4), text(4), text(100)].map(
    (t) => extractFirecrawlContent(t, 'Fixture').contentText!.length,
  );
  assert.equal(mixed.averageContentLength, expected.reduce((a, b) => a + b, 0) / 3);
  assert.equal(
    mixed.contentTextLength,
    expected.reduce((a, b) => a + b, 0),
  );
  assert.equal(mixed.results.find((r) => r.rawArticleId === 'long')!.contentLength, 4000);
  globalThis.fetch = async () => Response.json({ success: true, markdown: 'Too short' });
  const empty = await completeRawArticleContent(db([candidate('invalid')]), { limit: 1 });
  assert.equal(empty.averageContentLength, null);
  assert.equal(empty.successCount, 0);
  assert.equal(empty.unusableCount, 1);
  for (const key of names) {
    delete process.env[key];
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw new Error('Unexpected request');
    };
    await assert.rejects(() => completeRawArticleContent(db([])), new RegExp(`${key} is required`));
    assert.equal(requests, 0);
    names.forEach((n, i) => {
      process.env[n] = `test-key-${i}`;
    });
  }
  console.log(
    'PASS fixed A/B/C 30-item slices, 90 cap, parallel execution and failed-pool isolation, strict keys, HTTP-vs-content validity, retry article counting, write failures, zero-row writes and successful persisted content_text average. All calls mocked.',
  );
} finally {
  globalThis.fetch = savedFetch;
  globalThis.setTimeout = savedTimer;
  names.forEach((n, i) => {
    if (savedKeys[i] === undefined) delete process.env[n];
    else process.env[n] = savedKeys[i];
  });
}
