import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { memories } from '../src/db/schema.js';
import {
  MemoryCreateSchema,
  MemoryUpdateSchema,
  type Memory,
} from '../src/lib/memory-contracts.js';

const defaults = MemoryCreateSchema.parse({ content: '  阅读原始研究  ' });
assert.deepEqual(defaults, {
  content: '阅读原始研究',
  type: 'general',
  priority: 0,
  enabled: true,
});
for (const invalid of [
  { content: ' \n ' },
  { content: 'ok', type: 'unknown' },
  { content: 'ok', priority: 1.5 },
  { content: 'ok', priority: 2147483648 },
  { content: 'ok', priority: '2' },
  { content: 'ok', enabled: 'false' },
  { content: 'ok', expires_at: 'tomorrow' },
])
  assert.equal(MemoryCreateSchema.safeParse(invalid).success, false);
assert.equal(MemoryCreateSchema.safeParse({ content: 'ok', priority: -1 }).success, true);
const id = randomUUID();
assert.equal(MemoryUpdateSchema.safeParse({ id, enabled: false }).success, true);
assert.equal(
  MemoryUpdateSchema.safeParse({ id, enabled: false, content: 'overlap' }).success,
  false,
);
assert.equal(
  MemoryUpdateSchema.safeParse({ id, content: 'ok', type: 'topic', priority: 1, enabled: true })
    .success,
  true,
);
assert.equal(MemoryUpdateSchema.safeParse({ id: 'invalid', enabled: true }).success, false);
const config = getTableConfig(memories);
assert.deepEqual(
  config.columns.map((c) => c.name),
  ['id', 'content', 'type', 'priority', 'enabled', 'created_at', 'updated_at'],
);
assert.ok(config.columns.every((c) => c.notNull));
assert.deepEqual(
  config.checks.map((c) => c.name),
  ['memories_type_check', 'memories_content_check'],
);
const sql = await readFile(new URL('../drizzle/0023_memories.sql', import.meta.url), 'utf8');
assert.match(sql, /CREATE TABLE "memories"/);
assert.match(sql, /"priority" integer DEFAULT 0 NOT NULL/);
assert.match(sql, /"enabled" boolean DEFAULT true NOT NULL/);
const journal = JSON.parse(
  await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
);
assert.equal(journal.entries.at(-1).tag, '0023_memories');
assert.equal(journal.entries.at(-1).idx, 23);

const sessionDir = await mkdtemp(join(tmpdir(), 'x-ai-memory-test-'));
process.env.ADMIN_SESSION_DIR = sessionDir;
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.DATABASE_URL = 'postgresql://localhost/memory_mock_never_connect';
process.env.DATABASE_SSL = 'false';
const originalQuery = Pool.prototype.query;
const originalConnect = Pool.prototype.connect;
const records: Memory[] = [];
let calls = 0;
let fail = false;
Object.defineProperty(Pool.prototype, 'connect', {
  configurable: true,
  value: () => {
    throw new Error('Test must not connect to PostgreSQL');
  },
});
Object.defineProperty(Pool.prototype, 'query', {
  configurable: true,
  value: async (text: string, values: unknown[] = []) => {
    calls++;
    if (fail) throw new Error('mock database failure');
    if (text.startsWith('select')) {
      assert.match(text, /order by priority desc, created_at desc, id desc/);
      assert.doesNotMatch(text, /where enabled|and enabled/);
      return {
        rows: records
          .filter((r) => !values.length || r.type === values[0])
          .sort(
            (a, b) =>
              b.priority - a.priority ||
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          ),
      };
    }
    if (text.startsWith('insert')) {
      const now = new Date().toISOString();
      const row = {
        id: randomUUID(),
        content: values[0],
        type: values[1],
        priority: values[2],
        enabled: values[3],
        createdAt: now,
        updatedAt: now,
      } as Memory;
      records.push(row);
      return { rows: [row] };
    }
    assert.ok(text.startsWith('update memories'));
    const row = records.find((r) => r.id === values[0]);
    if (!row) return { rows: [] };
    if (text.includes('set enabled')) {
      assert.doesNotMatch(text, /set content|type =|priority =/);
      row.enabled = values[1] as boolean;
    } else {
      assert.match(text, /enabled = \$5/);
      Object.assign(row, {
        content: values[1],
        type: values[2],
        priority: values[3],
        enabled: values[4],
      });
    }
    row.updatedAt = new Date().toISOString();
    return { rows: [row] };
  },
});
const auth = await import('../src/lib/admin-auth.js');
const route = await import('../src/app/api/admin/memories/route.js');
const origin = 'http://localhost:3000';
let cookie = '';
function request(
  method: string,
  body?: unknown,
  suffix = '',
  authenticated = true,
  requestOrigin = origin,
) {
  return new Request(`${origin}/ai/api/admin/memories${suffix}`, {
    method,
    headers: {
      ...(authenticated ? { cookie } : {}),
      origin: requestOrigin,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
try {
  process.env.ADMIN_PASSWORD_HASH = await auth.createAdminPasswordHash('memory-test-password');
  cookie = auth.sessionCookie(await auth.createAdminSession()).split(';')[0]!;
  for (const method of ['GET', 'POST', 'PATCH'] as const)
    assert.equal((await route[method](request(method, undefined, '', false))).status, 401);
  assert.equal(calls, 0, 'Anonymous requests must not touch DB');
  for (const method of ['POST', 'PATCH'] as const)
    assert.equal(
      (await route[method](request(method, {}, '', true, 'http://evil.test'))).status,
      403,
    );
  assert.equal(calls, 0);
  for (const body of [
    { content: '' },
    { content: 'x', type: 'unknown' },
    { content: 'x', priority: 0.5 },
  ])
    assert.equal((await route.POST(request('POST', body))).status, 400);
  assert.equal((await route.GET(request('GET', undefined, '?type=invalid'))).status, 400);
  assert.equal(
    (
      await route.POST(
        new Request(`${origin}/ai/api/admin/memories`, {
          method: 'POST',
          headers: { cookie, origin },
          body: 'bad-json',
        }),
      )
    ).status,
    400,
  );
  let response = await route.POST(request('POST', { content: '  First  ' }));
  assert.equal(response.status, 201);
  const first = (await response.json()).item as Memory;
  assert.equal(first.content, 'First');
  assert.equal(first.enabled, true);
  response = await route.PATCH(request('PATCH', { id: first.id, enabled: false }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).item.enabled, false);
  assert.equal(records[0].content, 'First');
  response = await route.PATCH(
    request('PATCH', {
      id: first.id,
      content: 'Edited',
      type: 'topic',
      priority: 3,
      enabled: false,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).item.enabled, false);
  const timestamp = first.createdAt;
  assert.equal(records[0].createdAt, timestamp, 'Editing must not change created_at');
  records.push(
    { ...records[0], id: randomUUID(), content: 'New topic', createdAt: '2030-01-01T00:00:00Z' },
    { ...records[0], id: randomUUID(), content: 'Highest', type: 'source', priority: 9 },
  );
  response = await route.GET(request('GET'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(
    (await response.json()).items.map((r: Memory) => r.content),
    ['Highest', 'New topic', 'Edited'],
  );
  response = await route.GET(request('GET', undefined, '?type=topic'));
  const filtered = (await response.json()).items as Memory[];
  assert.deepEqual(
    filtered.map((r) => r.content),
    ['New topic', 'Edited'],
  );
  assert.ok(filtered.every((r) => !r.enabled));
  const refreshed = await route.GET(request('GET', undefined, '?type=topic'));
  assert.deepEqual(
    (await refreshed.json()).items,
    filtered,
    'A fresh GET must retain saved values including disabled records',
  );
  assert.equal(
    (await route.PATCH(request('PATCH', { id: randomUUID(), enabled: true }))).status,
    404,
  );
  assert.equal(
    (await route.PATCH(request('PATCH', { id: first.id, content: 'bad', enabled: true }))).status,
    400,
  );
  fail = true;
  for (const [method, body] of [
    ['GET', undefined],
    ['POST', { content: 'x' }],
    ['PATCH', { id: first.id, enabled: true }],
  ] as const) {
    const result = await route[method](request(method, body));
    assert.equal(result.status, 503);
    assert.ok((await result.json()).error);
  }
  console.log(
    'Memory contracts, Schema/Migration, API auth/origin, CRUD, disabled inclusion, ordering/filtering, fresh reads and failures passed (Mock DB).',
  );
} finally {
  Object.defineProperty(Pool.prototype, 'query', { configurable: true, value: originalQuery });
  Object.defineProperty(Pool.prototype, 'connect', { configurable: true, value: originalConnect });
  const { getDatabasePool } = await import('../src/db/index.js');
  await getDatabasePool().end();
  await rm(sessionDir, { recursive: true, force: true });
}
