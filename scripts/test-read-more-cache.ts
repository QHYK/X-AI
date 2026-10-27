import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ReadMoreWaitTimeoutError } from '../src/lib/read-more-singleflight.js';
import type { Pool } from 'pg';
import { generateReadMoreSummary } from '../src/lib/read-more.js';
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
