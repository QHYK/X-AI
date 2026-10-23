import { attachPromptMemory, PromptMemory } from './fixtures/prompt-runtime.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import {
  putBackIgnoredArticle,
  PutBackError,
  PutBackFieldsSchema,
} from '../src/lib/digest-put-back.js';
import {
  persistStage3Ranks,
  nextDisplayRankForAiRankUpdate,
  nextDisplayRankForStaleClear,
} from '../src/processing/stage3-persistence.js';
import { getDailyBriefForDailyDate } from '../src/lib/daily-brief.js';

const date = '2026-10-22';
const now = new Date('2026-10-24T04:00:00Z');
const fields = {
  category: 'Science',
  title_zh: '原文的重要科学结论',
  summary: 'The article explains a scientific result.',
  summary_zh: '文章解释研究方法、核心证据以及结论的适用范围。',
  tags: ['科学方法'],
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Raw = {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string | null;
  stage1_status: string;
  processing_error: string | null;
  source_name: string;
  source_category: string;
  content_text: string | null;
  full_content_text: string | null;
  metadata: Record<string, unknown> | null;
};
type PC = {
  id: string;
  raw_article_id: string;
  daily_date: string;
  routing: string;
  category: string;
  title_zh: string | null;
  summary: string | null;
  summary_zh: string | null;
  tags: string[];
  ai_rank: number | null;
  display_rank: number | null;
  put_back_at: string | null;
  linked_event: boolean;
};
type Result = { rows: Record<string, unknown>[]; rowCount?: number };

class Store {
  raw = new Map<string, Raw>();
  pcs = new Map<string, PC>();
  locks = new Set<string>();
  order = Promise.resolve();
  failFinal = false;
  failPreparation = false;
  updates: string[] = [];
  seed(n: number, changes: Partial<Raw> = {}) {
    const r: Raw = {
      id: id(n),
      title: 'Scientific article',
      url: `https://example.test/article/${n}`,
      author: 'Author',
      published_at: '2026-10-21T10:00:00Z',
      stage1_status: 'ignored',
      processing_error: null,
      source_name: 'Original publisher',
      source_category: 'Science',
      content_text: '原文说明科学方法、研究证据与限定条件。'.repeat(30),
      full_content_text: null,
      metadata: {},
      ...changes,
    };
    this.raw.set(r.id, r);
    return r.id;
  }
  processed(n: number, changes: Partial<PC> = {}) {
    const pc: PC = {
      id: id(1000 + n),
      raw_article_id: id(n),
      daily_date: date,
      routing: 'digest',
      ...fields,
      tags: [...fields.tags],
      ai_rank: 1,
      display_rank: 1,
      put_back_at: null,
      linked_event: false,
      ...changes,
    };
    this.pcs.set(pc.id, pc);
    return pc;
  }
  connect = async () => {
    let rawWrites = new Map<string, Raw>();
    let pcWrites = new Map<string, PC>();
    const owned = new Set<string>();
    let orderUnlock: (() => void) | undefined;
    const rows = () => new Map([...this.pcs, ...pcWrites]);
    const rawRow = (key: string) => rawWrites.get(key) ?? this.raw.get(key);
    const release = () => {
      for (const key of owned) this.locks.delete(key);
      owned.clear();
      orderUnlock?.();
      orderUnlock = undefined;
    };
    const query = async (sql: string, v: unknown[] = []): Promise<Result> => {
      this.updates.push(sql);
      if (sql === 'begin') {
        rawWrites = new Map();
        pcWrites = new Map();
        return { rows: [] };
      }
      if (sql === 'commit') {
        for (const [k, r] of rawWrites) this.raw.set(k, r);
        for (const [k, r] of pcWrites) this.pcs.set(k, r);
        release();
        return { rows: [] };
      }
      if (sql === 'rollback') {
        rawWrites.clear();
        pcWrites.clear();
        release();
        return { rows: [] };
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        const key = String(v[0]);
        if (this.locks.has(key)) return { rows: [{ locked: false }] };
        this.locks.add(key);
        owned.add(key);
        return { rows: [{ locked: true }] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        const previous = this.order;
        this.order = new Promise<void>((resolve) => {
          orderUnlock = resolve;
        });
        await previous;
        return { rows: [] };
      }
      if (sql.includes('for update of ra')) {
        const ra = rawRow(String(v[0]));
        if (!ra) return { rows: [] };
        const pc = [...rows().values()].find((r) => r.raw_article_id === ra.id);
        return {
          rows: [
            {
              ...ra,
              processed_id: pc?.id ?? null,
              daily_date: pc?.daily_date ?? null,
              routing: pc?.routing ?? null,
              category: pc?.category ?? null,
              title_zh: pc?.title_zh ?? null,
              summary: pc?.summary ?? null,
              summary_zh: pc?.summary_zh ?? null,
              tags: pc?.tags ?? null,
              ai_rank: pc?.ai_rank ?? null,
              display_rank: pc?.display_rank ?? null,
              put_back_at: pc?.put_back_at ?? null,
              linked_event: pc?.linked_event ?? false,
            },
          ],
        };
      }
      if (sql.includes('select id, url from raw_articles')) {
        return {
          rows: [...this.raw.values()]
            .filter(
              (r) =>
                r.id !== v[0] &&
                (
                  this.prompts.owners.get(`raw_articles:${r.id}`)?.promptAttempt as
                    { status?: string } | undefined
                )?.status === 'running',
            )
            .map((r) => ({ id: r.id, url: r.url })),
        };
      }
      if (sql.includes('select pc.id, ra.url')) {
        return {
          rows: [...rows().values()]
            .filter(
              (p) =>
                p.daily_date === v[0] &&
                p.routing === 'digest' &&
                (p.display_rank ?? p.ai_rank) !== null,
            )
            .map((p) => ({
              id: p.id,
              url: rawRow(p.raw_article_id)?.url ?? null,
              category: p.category,
              rank: p.display_rank ?? p.ai_rank,
              put_back_at: p.put_back_at,
            })),
        };
      }
      if (
        sql.includes('from discovery_fetch_cache') ||
        sql.includes('from raw_articles ra join sources')
      )
        return { rows: [] };
      if (sql.includes('update raw_articles set metadata')) {
        if (this.failPreparation) throw new Error('Preparation DB write failed');
        const r = rawRow(String(v[0]))!;
        rawWrites.set(r.id, {
          ...r,
          metadata: { ...r.metadata, put_back_preparation: JSON.parse(String(v[1])) },
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('select (coalesce(max')) {
        const group = [...rows().values()].filter(
          (p) => p.daily_date === v[0] && p.category === v[1] && p.routing === 'digest',
        );
        return {
          rows: [
            { next_rank: Math.max(0, ...group.map((p) => p.display_rank ?? p.ai_rank ?? 0)) + 1 },
          ],
        };
      }
      if (sql.includes('insert into processed_contents')) {
        if (this.failFinal) throw new Error('Final DB write failed');
        const old = [...rows().values()].find((p) => p.raw_article_id === v[0]);
        const p: PC = {
          id: old?.id ?? id(1000 + Number(String(v[0]).slice(-12))),
          raw_article_id: String(v[0]),
          daily_date: String(v[1]),
          routing: 'digest',
          category: String(v[2]),
          title_zh: String(v[3]),
          summary: String(v[4]),
          summary_zh: String(v[5]),
          tags: v[6] as string[],
          ai_rank: null,
          display_rank: Number(v[7]),
          put_back_at: old?.put_back_at ?? now.toISOString(),
          linked_event: false,
        };
        pcWrites.set(p.id, p);
        return { rows: [{ id: p.id }], rowCount: 1 };
      }
      if (sql.includes("update raw_articles set stage1_status = 'selected'")) {
        const r = rawRow(String(v[0]))!;
        rawWrites.set(r.id, { ...r, stage1_status: 'selected', processing_error: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('update processed_contents')) {
        assert.doesNotMatch(sql, /and put_back_at is null/);
        assert.match(sql, /when put_back_at is not null and ai_rank is null then/);
        const targets = sql.includes('id = any') ? (v[0] as string[]) : [String(v[0])];
        let n = 0;
        for (const key of targets) {
          const p = rows().get(key);
          if (!p) continue;
          const rank = sql.includes('ai_rank = $2') ? Number(v[1]) : null;
          pcWrites.set(p.id, {
            ...p,
            ai_rank: rank,
            put_back_at: null,
            display_rank:
              p.put_back_at && p.ai_rank === null
                ? rank
                : rank === null
                  ? nextDisplayRankForStaleClear(p.ai_rank, p.display_rank)
                  : nextDisplayRankForAiRankUpdate(p.ai_rank, p.display_rank, rank),
          });
          n++;
        }
        return { rows: [], rowCount: n };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };
    return { query, release };
  };
  query = async (sql: string, values: unknown[] = []): Promise<Result> => {
    if (sql.includes("where pc.routing = 'digest'")) {
      assert.match(sql, /order by pc.category asc,/);
      return {
        rows: [...this.pcs.values()]
          .filter(
            (p) =>
              p.routing === 'digest' &&
              p.daily_date === values[0] &&
              (p.display_rank ?? p.ai_rank) !== null,
          )
          .sort((a, b) => a.category.localeCompare(b.category) || a.display_rank! - b.display_rank!)
          .map((p) => ({
            ...p,
            rank: p.display_rank ?? p.ai_rank,
            title: this.raw.get(p.raw_article_id)?.title,
            source: 'Original publisher',
            url: 'https://example.test/article',
            created_at: now,
            published_at: now,
          })),
      };
    }
    if (
      sql.startsWith('select') ||
      sql.includes('from events') ||
      sql.includes('stage4_runs') ||
      sql.includes('where pc.routing')
    )
      return { rows: [] };
    const c = await this.connect();
    await c.query('begin');
    const r = await c.query(sql, values);
    await c.query('commit');
    c.release();
    return r;
  };
  prompts = new PromptMemory();
  db = attachPromptMemory(this as unknown as Pool, this.prompts);
}

let calls = 0;
const request = async (args: { instructions?: string; input: unknown; text?: unknown }) => {
  calls++;
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(args.text)).format.schema.properties).sort(),
    ['category', 'summary', 'summary_zh', 'tags', 'title_zh'],
  );
  const input = JSON.parse(String(args.input));
  assert.match(input.originalUrl, /^https:\/\/example\.test\/article\//);
  assert.ok(input.content.length >= 200);
  assert.doesNotMatch(JSON.stringify(args.text), /\\\\p\{/);
  return {
    id: 'mock',
    output: [],
    output_text: JSON.stringify(fields),
    api_mode: 'chat_completions' as const,
  };
};
const restore = (s: Store, rawId: string, target = date) =>
  putBackIgnoredArticle(s.db, { id: rawId, date: target }, { now, request });
const store = new Store();
const a = store.seed(1);
store.seed(90, { stage1_status: 'selected' });
const ordinary = store.processed(90, { ai_rank: 1, display_rank: 4 });
const first = await restore(store, a);
assert.equal(first.rank, 5);
assert.equal(first.dailyDate, date);
assert.equal(first.alreadyInDigest, false);
assert.equal(store.raw.get(a)?.stage1_status, 'selected');
assert.equal(store.pcs.get(ordinary.id)?.display_rank, 4);
assert.equal(store.raw.get(a)?.url, 'https://example.test/article/1');
assert.equal(store.pcs.get(first.id)?.ai_rank, null);
const used = calls;
assert.equal((await restore(store, a)).alreadyInDigest, true);
assert.equal(calls, used);
const b = store.seed(2, { processing_error: 'duplicate' });
const second = await restore(store, b);
assert.equal(second.rank, 6);
assert.equal(
  (store.raw.get(b)?.metadata?.put_back_preparation as Record<string, unknown>).ignoreType,
  'Duplicate',
);

// Restored entries join the next Stage3 ranking, replacing their temporary append positions.
const client = await store.connect();
await client.query('begin');
await persistStage3Ranks(client as never, {
  ranked: [
    { processedContentId: ordinary.id, rank: 12 },
    { processedContentId: first.id, rank: 1 },
    { processedContentId: second.id, rank: 2 },
  ],
  staleProcessedContentIds: [],
});
await client.query('commit');
client.release();
assert.equal(store.pcs.get(ordinary.id)?.display_rank, 4, 'Human order remains unchanged');
assert.equal(store.pcs.get(first.id)?.display_rank, 1);
assert.equal(store.pcs.get(first.id)?.ai_rank, 1);
assert.equal(store.pcs.get(first.id)?.put_back_at, null);
assert.equal(store.pcs.get(second.id)?.display_rank, 2);
store.seed(91, { stage1_status: 'selected' });
const newer = store.processed(91, { ai_rank: 12, display_rank: 12 });
const rerun = await store.connect();
await rerun.query('begin');
await persistStage3Ranks(rerun as never, {
  ranked: [
    { processedContentId: newer.id, rank: 12 },
    { processedContentId: first.id, rank: 3 },
  ],
  staleProcessedContentIds: [],
});
await rerun.query('commit');
rerun.release();
assert.equal(store.pcs.get(first.id)?.display_rank, 3);
assert.equal(store.pcs.get(second.id)?.display_rank, 2);
assert.equal(store.pcs.get(first.id)?.summary_zh, fields.summary_zh);

const brief = await getDailyBriefForDailyDate(store.db, date);
assert.deepEqual(
  brief.digests.Science?.map((p) => p.id),
  [second.id, first.id, ordinary.id, newer.id],
);

const manualClient = await store.connect();
store.pcs.set(first.id, { ...store.pcs.get(first.id)!, display_rank: 9 });
await manualClient.query('begin');
await persistStage3Ranks(manualClient as never, {
  ranked: [{ processedContentId: first.id, rank: 5 }],
  staleProcessedContentIds: [],
});
await manualClient.query('commit');
manualClient.release();
assert.equal(store.pcs.get(first.id)?.display_rank, 9, 'Later manual order is retained');
assert.equal(store.pcs.get(first.id)?.ai_rank, 5);
const stale = new Store();
stale.seed(95);
const staleResult = await restore(stale, id(95));
const staleClient = await stale.connect();
await staleClient.query('begin');
await persistStage3Ranks(staleClient as never, {
  ranked: [],
  staleProcessedContentIds: [staleResult.id],
});
await staleClient.query('commit');
staleClient.release();
assert.equal(stale.pcs.get(staleResult.id)?.display_rank, null);

// Different RSS records for the same work must not create or pay for a second Digest entry.
const duplicateRaw = store.seed(92, {
  url: 'https://example.test/article/1/?utm_source=rss#top',
  processing_error: 'duplicate',
});
const beforeDuplicate = calls;
const duplicateResult = await restore(store, duplicateRaw);
assert.equal(duplicateResult.id, first.id);
assert.equal(duplicateResult.alreadyInDigest, true);
assert.equal(calls, beforeDuplicate);
assert.equal(store.raw.get(duplicateRaw)?.stage1_status, 'ignored');
assert.equal(
  [...store.pcs.values()].some((p) => p.raw_article_id === duplicateRaw),
  false,
);
const differentDate = new Store();
differentDate.seed(93);
differentDate.processed(93, { daily_date: '2026-10-21' });
differentDate.seed(94, { url: 'https://example.test/article/93' });
assert.equal((await restore(differentDate, id(94))).alreadyInDigest, false);

const empty = new Store();
assert.equal((await restore(empty, empty.seed(3))).rank, 1);
const reusable = new Store();
const re = reusable.seed(4, { content_text: null });
const old = reusable.processed(4, { routing: 'long_form', ai_rank: null, display_rank: null });
const beforeReuse = calls;
assert.equal((await restore(reusable, re)).id, old.id);
assert.equal(calls, beforeReuse);
const exists = new Store();
exists.seed(5);
exists.processed(5);
const beforeExists = calls;
assert.equal((await restore(exists, id(5))).alreadyInDigest, true);
assert.equal(calls, beforeExists);
const missing = new Store();
missing.seed(6, { content_text: 'Only a title' });
await assert.rejects(restore(missing, id(6)), (e) => e instanceof PutBackError && e.status === 422);
const linked = new Store();
linked.seed(7);
linked.processed(7, { routing: 'event', linked_event: true });
await assert.rejects(restore(linked, id(7)), (e) => e instanceof PutBackError && e.status === 409);
const failed = new Store();
failed.seed(8);
failed.failFinal = true;
await assert.rejects(
  restore(failed, id(8)),
  (e) => e instanceof PutBackError && e.status === 503 && /准备结果已保存/.test(e.message),
);
assert.equal(failed.pcs.size, 0);
assert.equal(failed.raw.get(id(8))?.stage1_status, 'ignored');
failed.failFinal = false;
const beforeRetry = calls;
await restore(failed, id(8));
assert.equal(calls, beforeRetry);
const preparationFailure = new Store();
preparationFailure.seed(9);
preparationFailure.failPreparation = true;
await assert.rejects(
  restore(preparationFailure, id(9)),
  (e) => e instanceof PutBackError && e.generatedFields?.summary_zh === fields.summary_zh,
);
assert.equal(preparationFailure.pcs.size, 0);
const modelFailure = new Store();
modelFailure.seed(10);
await assert.rejects(
  putBackIgnoredArticle(
    modelFailure.db,
    { id: id(10), date },
    {
      now,
      request: async () => {
        throw new Error('Model down');
      },
    },
  ),
  (e) => e instanceof PutBackError && e.status === 502,
);
assert.equal(modelFailure.pcs.size, 0);

// Validate Shanghai boundary, historical dates and existing attribution in either server TZ.
for (const tz of ['UTC', 'Asia/Shanghai']) {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    const boundary = new Store();
    boundary.seed(11, { published_at: '2026-10-22T00:30:00Z' });
    await assert.rejects(
      restore(boundary, id(11)),
      (e) => e instanceof PutBackError && e.status === 409,
    );
    assert.equal((await restore(boundary, id(11), '2026-10-23')).dailyDate, '2026-10-23');
    const history = new Store();
    history.seed(12, { published_at: '2026-08-01T00:29:59Z' });
    assert.equal((await restore(history, id(12), '2026-08-01')).dailyDate, '2026-08-01');
    const attribution = new Store();
    attribution.seed(13);
    attribution.processed(13, {
      daily_date: '2026-10-23',
      routing: 'long_form',
      display_rank: null,
    });
    await assert.rejects(
      restore(attribution, id(13)),
      (e) => e instanceof PutBackError && e.status === 409,
    );
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}
const concurrent = new Store();
concurrent.seed(14);
concurrent.seed(15);
const appended = await Promise.all([restore(concurrent, id(14)), restore(concurrent, id(15))]);
assert.deepEqual(appended.map((r) => r.rank).sort(), [1, 2]);
const busy = new Store();
busy.seed(16);
busy.seed(17, { url: 'https://example.test/article/16?utm_campaign=rss' });
let started!: () => void;
const ready = new Promise<void>((resolve) => {
  started = resolve;
});
let resolveModel!: (response: Awaited<ReturnType<typeof request>>) => void;
const running = putBackIgnoredArticle(
  busy.db,
  { id: id(16), date },
  {
    now,
    request: async () => {
      started();
      return new Promise((resolve) => {
        resolveModel = resolve;
      });
    },
  },
);
await ready;
await assert.rejects(restore(busy, id(16)), (e) => e instanceof PutBackError && e.status === 409);
await assert.rejects(restore(busy, id(17)), (e) => e instanceof PutBackError && e.status === 409);
resolveModel({
  id: 'mock',
  output: [],
  output_text: JSON.stringify(fields),
  api_mode: 'chat_completions',
});
await running;
assert.equal(busy.pcs.size, 1);
const beforeDuplicateRetry = calls;
assert.equal((await restore(busy, id(17))).alreadyInDigest, true);
assert.equal(calls, beforeDuplicateRetry);
assert.equal(PutBackFieldsSchema.safeParse({ ...fields, routing: 'Ignore' }).success, false);
assert.equal(PutBackFieldsSchema.safeParse({ ...fields, summary_zh: '' }).success, false);
const stage3 = await readFile(new URL('../src/processing/stage3-job.ts', import.meta.url), 'utf8');
assert.doesNotMatch(stage3, /and pc\.put_back_at is null/);
const migration = await readFile(
  new URL('../drizzle/0020_digest_put_back.sql', import.meta.url),
  'utf8',
);
assert.match(migration, /routing = 'digest' AND ai_rank IS NULL AND display_rank IS NOT NULL/);
console.log(
  'Put Back dates, reuse, generation, retry costs, concurrency, append order, Stage3 reranking and public Digest regression tests passed.',
);
