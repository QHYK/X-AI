import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ReadMoreWaitTimeoutError } from '../src/lib/read-more-singleflight.js';
import type { Pool } from 'pg';
import { generateReadMoreSummary } from '../src/lib/read-more.js';
import {
  canFetchReadMoreArticle,
  readMoreFetchWhitelistSql,
} from '../src/lib/read-more-whitelist.js';
import type { ArticleDocument } from '../src/lib/article-fetch-cache.js';
import {
  READ_MORE_CONTENT_TEXT_MIN_LENGTH,
  readMoreTextLength,
  selectReadMoreSourceText,
  type ReadMoreContent,
} from '../src/lib/read-more-eligibility.js';

// Independent mock Pools share only this PostgreSQL-like lock server, not request Promises.
const locks = new Map<string, EventEmitter>();
function lockable(db: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
  const sessions = new Set<EventEmitter>();
  const pool = {
    query: db.query,
    sessions,
    connect: async () => {
      const client = new EventEmitter() as EventEmitter & {
        query: (
          query: string | { text: string; values?: unknown[] },
          values?: unknown[],
        ) => Promise<unknown>;
        release: (error?: Error) => void;
      };
      sessions.add(client);
      client.query = async (query, values) => {
        const text = typeof query === 'string' ? query : query.text;
        values = typeof query === 'string' ? values : query.values;
        const key = String(values?.[0]);
        if (text.includes('pg_try_advisory_lock')) {
          if (locks.has(key)) return { rows: [{ locked: false }] };
          locks.set(key, client);
          return { rows: [{ locked: true }] };
        }
        if (text.includes('pg_advisory_unlock')) {
          assert.equal(locks.get(key), client);
          locks.delete(key);
          return { rows: [{ unlocked: true }] };
        }
        return db.query(text, values);
      };
      client.release = () => {
        for (const [key, owner] of locks) if (owner === client) locks.delete(key);
        sessions.delete(client);
      };
      return client;
    },
  };
  return pool as unknown as Pool & { sessions: Set<EventEmitter> };
}

assert.equal(READ_MORE_CONTENT_TEXT_MIN_LENGTH, 3000, 'Formal Spec boundary must not drift');
assert.equal(
  canFetchReadMoreArticle('The Guardian 卫报', 'https://www.theguardian.com/world/article'),
  true,
);
assert.equal(
  canFetchReadMoreArticle('The Guardian 卫报', 'https://eviltheguardian.com/article'),
  false,
);
assert.equal(canFetchReadMoreArticle('The Guardian 卫报', 'https://-bad.theguardian.com/a'), false);
assert.equal(canFetchReadMoreArticle('Other', 'https://www.theguardian.com/world/article'), false);
assert.equal(
  canFetchReadMoreArticle('The Guardian 卫报', 'https://theguardian.com.evil.test/a'),
  false,
);
assert.equal(canFetchReadMoreArticle('The Guardian 卫报', 'https://user@theguardian.com/a'), false);
assert.ok(readMoreFetchWhitelistSql('s.name', 'ra.url').includes("s.name = 'The Guardian 卫报'"));
assert.equal(readMoreTextLength('😀'), 1, 'Count code points, not UTF-16 code units');
const whitespace =
  '\t\n\r\v\f \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const cases: Array<{ name: string; row: ReadMoreContent; expected: string | null }> = [
  { name: 'No text', row: { fullContentText: null, contentText: null }, expected: null },
  {
    name: 'Whitespace only',
    row: { fullContentText: whitespace, contentText: whitespace },
    expected: null,
  },
  {
    name: 'Full text has priority without a length floor',
    row: { fullContentText: `${whitespace}full${whitespace}`, contentText: '甲'.repeat(3001) },
    expected: 'full',
  },
  {
    name: '2999 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(2999) },
    expected: null,
  },
  {
    name: '3000 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(3000) },
    expected: '甲'.repeat(3000),
  },
  {
    name: '3001 partial characters',
    row: { fullContentText: '', contentText: '甲'.repeat(3001) },
    expected: '甲'.repeat(3001),
  },
  {
    name: 'Previously rejected 3999 partial characters',
    row: { fullContentText: null, contentText: '甲'.repeat(3999) },
    expected: '甲'.repeat(3999),
  },
  {
    name: 'Trim before measuring, not after',
    row: {
      fullContentText: whitespace,
      contentText: `${whitespace}${'甲'.repeat(2999)}${whitespace}`,
    },
    expected: null,
  },
  {
    name: 'Whitespace full text falls back to usable partial text',
    row: {
      fullContentText: whitespace,
      contentText: `${whitespace}${'甲'.repeat(3000)}${whitespace}`,
    },
    expected: '甲'.repeat(3000),
  },
  {
    name: '2999 astral Unicode code points',
    row: { fullContentText: null, contentText: '😀'.repeat(2999) },
    expected: null,
  },
  {
    name: '3000 astral Unicode code points',
    row: { fullContentText: null, contentText: '😀'.repeat(3000) },
    expected: '😀'.repeat(3000),
  },
];
for (const { name, row, expected } of cases) {
  assert.equal(selectReadMoreSourceText(row), expected, name);
  let generationCalls = 0;
  const queries: string[] = [];
  const db = lockable({
    query: async (text: string, values?: unknown[]) => {
      queries.push(text);
      if (text.includes('select summary_zh')) return { rows: [{ summaryZh: whitespace }] };
      if (text.includes('from processed_contents')) return { rows: [row] };
      assert.ok(text.includes('on conflict (content_id) do update'));
      assert.equal(values?.[1], 'Generated guide');
      return { rows: [{ summaryZh: 'Generated guide' }] };
    },
  });
  const result = await generateReadMoreSummary(db, '00000000-0000-4000-8000-000000000001', {
    generate: async (source) => {
      generationCalls++;
      assert.equal(source, expected, name);
      return 'Generated guide';
    },
  });
  assert.deepEqual(
    result,
    expected === null
      ? { status: 'not_available' }
      : { status: 'success', summary_zh: 'Generated guide' },
    name,
  );
  assert.equal(generationCalls, expected === null ? 0 : 1, name);
  assert.equal(queries.length, expected === null ? 3 : 4, name);
}
// Persisted output stays readable even if the current source is missing/shortened.
const cachedDb = {
  query: async (text: string) => {
    assert.ok(text.includes('select summary_zh'), 'Cache hit must not query source or write');
    return { rows: [{ summaryZh: ' cached ' }] };
  },
} as unknown as Pool;
assert.deepEqual(
  await generateReadMoreSummary(cachedDb, '00000000-0000-4000-8000-000000000001', {
    generate: async () => {
      throw new Error('Cache hit must not call LLM');
    },
  }),
  { status: 'success', summary_zh: 'cached' },
);
const missingDb = lockable({ query: async () => ({ rows: [] }) });
assert.deepEqual(await generateReadMoreSummary(missingDb, '00000000-0000-4000-8000-000000000001'), {
  status: 'not_available',
});
console.log(
  'Read More: Spec 3000 boundary, Unicode, whitespace, source priority, partial text, cache and unavailable paths passed.',
);

// Fetch is available only after a click. The current Singleflight client also performs
// URL cache reads/writes, so a one-connection Pool never waits for itself.
const guardianUrl = 'https://www.theguardian.com/world/2026/nov/19/example';
const fullArticle = `# Guardian article\n\n${'Complete reporting with context. '.repeat(125)}`;
const guideCache = new Map<string, string>();
let fetchedCache: {
  original_url: string;
  final_url: string;
  fetched_at: string;
  markdown: string;
  is_complete: boolean;
  metadata: Record<string, unknown>;
} | null = null;
let sourceRow = {
  rawId: '00000000-0000-4000-8000-0000000000d1',
  fullContentText: null as string | null,
  contentText: 'Short feed excerpt',
  sourceName: 'The Guardian 卫报',
  url: guardianUrl,
};
const fetchDb = lockable({
  query: async (text: string, values?: unknown[]) => {
    if (text.includes('select summary_zh')) {
      const summaryZh = guideCache.get(String(values?.[0]));
      return { rows: summaryZh ? [{ summaryZh }] : [] };
    }
    if (text.includes('from raw_articles ra join sources')) return { rows: [] };
    if (text.includes('from processed_contents')) return { rows: [sourceRow] };
    if (text.includes('from discovery_fetch_cache'))
      return { rows: fetchedCache?.is_complete ? [fetchedCache] : [] };
    if (
      text === 'begin' ||
      text === 'commit' ||
      text === 'rollback' ||
      text.startsWith('set local')
    )
      return { rows: [] };
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('insert into discovery_fetch_cache')) {
      fetchedCache = {
        original_url: String(values?.[2]),
        final_url: String(values?.[3]),
        fetched_at: String(values?.[4]),
        markdown: String(values?.[5]),
        is_complete: values?.[6] === true,
        metadata: JSON.parse(String(values?.[7])),
      };
      return { rows: [] };
    }
    if (text.includes('insert into content_read_more')) {
      guideCache.set(String(values?.[0]), String(values?.[1]));
      return { rows: [{ summaryZh: values?.[1] }] };
    }
    throw new Error(`Unexpected Read More fetch SQL: ${text}`);
  },
});
const fetchedDocument = (complete = true): ArticleDocument => ({
  url: guardianUrl,
  finalUrl: guardianUrl,
  fetchedAt: new Date().toISOString(),
  status: 'success',
  markdown: fullArticle,
  isComplete: complete,
  metadata: {},
  coverImage: null,
  error: null,
  origin: 'fetch',
});
let fetchCalls = 0;
let generatedCalls = 0;
const newId = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
const fetched = await generateReadMoreSummary(fetchDb, newId('d2'), {
  fetchDocument: async () => {
    fetchCalls++;
    assert.equal(fetchDb.sessions.size, 1, 'Fetch must reuse the Singleflight session');
    return fetchedDocument();
  },
  generate: async (text) => {
    generatedCalls++;
    assert.ok(text.includes('Complete reporting with context.'));
    return 'Guardian detailed guide';
  },
});
assert.deepEqual(fetched, { status: 'success', summary_zh: 'Guardian detailed guide' });
assert.equal(fetchCalls, 1);
assert.equal(generatedCalls, 1);
assert.deepEqual(
  await generateReadMoreSummary(fetchDb, newId('d2'), {
    fetchDocument: async () => {
      throw new Error('Cached guide must not fetch');
    },
    generate: async () => {
      throw new Error('Cached guide must not generate');
    },
  }),
  fetched,
);
assert.equal(fetchCalls, 1);
assert.equal(generatedCalls, 1);
assert.equal(
  (
    await generateReadMoreSummary(fetchDb, newId('d3'), {
      fetchDocument: async () => {
        throw new Error('The URL cache must prevent another fetch');
      },
      generate: async () => 'Second guide',
    })
  ).status,
  'success',
);
sourceRow = { ...sourceRow, fullContentText: 'Already stored full text' };
assert.equal(
  (
    await generateReadMoreSummary(fetchDb, newId('d4'), {
      fetchDocument: async () => {
        throw new Error('Stored body must prevent fetch');
      },
      generate: async (text) => {
        assert.equal(text, 'Already stored full text');
        return 'Stored guide';
      },
    })
  ).status,
  'success',
);
sourceRow = { ...sourceRow, fullContentText: null };
fetchedCache = null;
assert.deepEqual(
  await generateReadMoreSummary(fetchDb, newId('d5'), {
    fetchDocument: async () => {
      fetchCalls++;
      return fetchedDocument(false);
    },
    generate: async () => {
      throw new Error('Incomplete body must not generate');
    },
  }),
  { status: 'not_available' },
);
fetchedCache = null;
assert.deepEqual(
  await generateReadMoreSummary(fetchDb, newId('d8'), {
    fetchDocument: async () => ({
      ...fetchedDocument(),
      finalUrl: 'https://other.example/article',
    }),
    generate: async () => {
      throw new Error('Off-host redirect must not generate');
    },
  }),
  { status: 'not_available' },
);
fetchedCache = null;
assert.deepEqual(
  await generateReadMoreSummary(fetchDb, newId('d9'), {
    fetchDocument: async () => ({
      ...fetchedDocument(),
      markdown: `# Summary\n\n${'Excerpt. '.repeat(500)}`,
    }),
    generate: async () => {
      throw new Error('Summary section must not become a full article');
    },
  }),
  { status: 'not_available' },
);
fetchedCache = null;
await assert.rejects(
  generateReadMoreSummary(fetchDb, newId('d6'), {
    fetchDocument: async () => {
      fetchCalls++;
      return { ...fetchedDocument(), status: 'error', error: 'HTTP 503' };
    },
    generate: async () => {
      throw new Error('Failed fetch must not generate');
    },
  }),
  /Read More article fetch failed: HTTP 503/,
);
sourceRow = { ...sourceRow, sourceName: 'Other source' };
assert.deepEqual(
  await generateReadMoreSummary(fetchDb, newId('d7'), {
    fetchDocument: async () => {
      throw new Error('Non-whitelisted source must not fetch');
    },
    generate: async () => {
      throw new Error('No sufficient body');
    },
  }),
  { status: 'not_available' },
);
assert.equal(fetchDb.sessions.size, 0);
console.log(
  'Read More allowlist: cache, stored body, on-demand fetch, incomplete/error and source isolation passed.',
);

const id = '00000000-0000-4000-8000-00000000000a';
const otherId = '00000000-0000-4000-8000-00000000000b';
const summaries = new Map<string, string>();
let failWrite = false;
const database = {
  query: async (text: string, values?: unknown[]) => {
    const key = String(values?.[0]);
    if (text.includes('select summary_zh')) {
      return { rows: summaries.has(key) ? [{ summaryZh: summaries.get(key) }] : [] };
    }
    if (text.includes('from processed_contents')) {
      return { rows: [{ fullContentText: 'article', contentText: null }] };
    }
    assert.ok(text.includes('insert into content_read_more'));
    if (failWrite) throw new Error('cache write failed');
    summaries.set(key, String(values?.[1]));
    return { rows: [{ summaryZh: summaries.get(key) }] };
  },
};
const poolA = lockable(database);
const poolB = lockable(database);
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let calls = 0;
let started = gate();
let finish = gate();
const generate = async () => {
  calls++;
  started.resolve();
  await finish.promise;
  return 'shared summary';
};
const first = generateReadMoreSummary(poolA, id.toUpperCase(), { generate });
await started.promise;
const second = generateReadMoreSummary(poolB, id, { generate });
// A different content ID must complete while the first generator is blocked.
assert.deepEqual(
  await generateReadMoreSummary(poolB, otherId, {
    generate: async () => 'independent',
  }),
  { status: 'success', summary_zh: 'independent' },
);
finish.resolve();
assert.deepEqual(await first, await second);
assert.equal(calls, 1, 'Separate Pools must share the database lock, including UUID spelling');
assert.equal(locks.size, 0);
assert.equal(poolA.sessions.size + poolB.sessions.size, 0);

summaries.clear();
await assert.rejects(
  generateReadMoreSummary(poolA, id, {
    generate: async () => {
      throw new Error('LLM failed');
    },
  }),
  /LLM failed/,
);
assert.equal(summaries.size, 0);
assert.equal(locks.size, 0);
assert.equal(
  (await generateReadMoreSummary(poolB, id, { generate: async () => 'retry' })).status,
  'success',
);

summaries.clear();
started = gate();
finish = gate();
const owner = generateReadMoreSummary(poolA, id, { generate });
await started.promise;
await assert.rejects(
  generateReadMoreSummary(poolB, id, {
    generate: async () => {
      throw new Error('Waiter must never call LLM');
    },
    waitTimeoutMs: 10,
  }),
  ReadMoreWaitTimeoutError,
);
assert.equal(poolB.sessions.size, 0, 'Waiter must return its session before sleeping');
finish.resolve();
await owner;

summaries.clear();
failWrite = true;
await assert.rejects(
  generateReadMoreSummary(poolA, id, { generate: async () => 'paid result' }),
  /cache write failed/,
);
assert.equal(locks.size, 0);
assert.equal(poolA.sessions.size, 0);
assert.equal(summaries.size, 0, 'Failed persistence cannot be reported as success');
failWrite = false;
await generateReadMoreSummary(poolB, id, { generate: async () => 'retry saved' });

summaries.clear();
await assert.rejects(
  generateReadMoreSummary(poolA, id, {
    generate: async (_source, signal) => {
      assert.equal(signal?.aborted, false);
      [...poolA.sessions][0]!.emit('error', new Error('session disconnected'));
      assert.equal(signal?.aborted, true, 'Connection loss must abort the model request');
      return 'must not save';
    },
  }),
  /session disconnected/,
);
assert.equal(summaries.size, 0);
assert.equal(locks.size, 0);
assert.equal(poolA.sessions.size, 0);

const brokenPool = lockable(database);
brokenPool.connect = async () => {
  throw new Error('Pool wait timed out');
};
await assert.rejects(generateReadMoreSummary(brokenPool, id), /Pool wait timed out/);
const transactionPool = lockable(database);
Object.assign(transactionPool, {
  options: { connectionString: 'postgres://localhost/postgres?pgbouncer=true' },
});
await assert.rejects(generateReadMoreSummary(transactionPool, id), /Session Pooling/);
// A lost lock-query response may still have acquired the server lock. Destroy that session.
for (const phase of ['acquire', 'unlock'] as const) {
  summaries.clear();
  const failingPool = lockable(database);
  const connect = failingPool.connect.bind(failingPool);
  let destroyed = false;
  failingPool.connect = (async () => {
    const client = await connect();
    const query = client.query.bind(client);
    const release = client.release.bind(client);
    client.release = (error?: Error | boolean) => {
      destroyed = !!error;
      release(error);
    };
    client.query = (async (config: { text: string } | string, values?: unknown[]) => {
      const text = typeof config === 'string' ? config : config.text;
      if (phase === 'acquire' && text.includes('pg_try_advisory_lock')) {
        await query(config as never, values as never);
        throw new Error('lock query timed out');
      }
      if (phase === 'unlock' && text.includes('pg_advisory_unlock')) {
        throw new Error('unlock failed');
      }
      return query(config as never, values as never);
    }) as typeof client.query;
    return client;
  }) as typeof failingPool.connect;
  await assert.rejects(
    generateReadMoreSummary(failingPool, id, {
      generate: async () => 'saved before unlock',
    }),
    phase === 'acquire' ? /lock query timed out/ : /unlock failed/,
  );
  assert.equal(destroyed, true, 'Uncertain lock ownership must never return to the idle Pool');
  assert.equal(locks.size, 0);
  assert.equal(failingPool.sessions.size, 0);
}
console.log(
  'Singleflight: separate Pools, concurrency, cache, retries, wait timeout, disconnect and persistence failure passed.',
);
