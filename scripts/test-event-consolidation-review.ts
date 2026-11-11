import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
import { Pool } from 'pg';
import { JSDOM } from 'jsdom';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  latestEventConsolidationDate,
  loadEventConsolidationReview,
} from '../src/lib/event-consolidation-review.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
    if (url.endsWith('.module.css')) return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};
    return nextLoad(url,context);
  }`)}`,
  import.meta.url,
);
const sessionDir = await mkdtemp(join(tmpdir(), 'x-field-consolidation-'));
process.env.ADMIN_SESSION_DIR = sessionDir;
process.env.ADMIN_COOKIE_SECURE = 'false';
process.env.DATABASE_URL = 'postgresql://localhost/never_connect_consolidation';
process.env.DATABASE_SSL = 'false';
const originalQuery = Pool.prototype.query;
const originalConnect = Pool.prototype.connect;
const day = '2026-10-29';
const records = [
  {
    id: 'article-a',
    group: 'obsolete-group',
    category: 'Technology',
    date: day,
    time: 1,
    automatic: true,
  },
  {
    id: 'article-a',
    group: 'group-a',
    category: 'Technology',
    date: day,
    time: 2,
    automatic: true,
  },
  { id: 'article-b', group: 'group-a', category: 'Company', date: day, time: 3, automatic: true },
  { id: 'article-c', group: 'group-b', category: 'Policy', date: day, time: 4, automatic: true },
  {
    id: 'article-d',
    group: 'deleted-group',
    category: 'General',
    date: day,
    time: 5,
    automatic: true,
  },
  { id: 'manual', group: 'group-a', category: 'Company', date: day, time: 6, automatic: false },
  {
    id: 'other-date',
    group: 'group-a',
    category: 'Company',
    date: '2026-10-28',
    time: 7,
    automatic: true,
  },
];
const queries: string[] = [];
let fail = false;
let latest: string | null = day;
Object.defineProperty(Pool.prototype, 'connect', {
  configurable: true,
  value() {
    throw new Error('Tests must not connect to PostgreSQL');
  },
});
Object.defineProperty(Pool.prototype, 'query', {
  configurable: true,
  value: async (sql: string, args: unknown[] = []) => {
    queries.push(sql);
    assert.match(sql.trim(), /^(select|with)\b/i);
    assert.doesNotMatch(sql, /\b(insert|update|delete|alter|create|drop|truncate)\b/i);
    if (fail) throw new Error('mock read failure');
    if (sql.includes('recorded_dates')) {
      assert.match(sql, /max\(daily_date\)::text/);
      assert.match(sql, /union all/);
      return { rows: [{ daily_date: latest }] };
    }
    if (sql.includes('with corrections')) {
      // Query-contract assertions guard the SQL-only provenance/dedup/date boundaries.
      assert.match(sql, /distinct on \(f.target_id\)/);
      assert.match(sql, /order by f.target_id, f.created_at desc, f.id desc/);
      assert.match(sql, /pc.daily_date = \$1::date/);
      assert.doesNotMatch(sql, /created_at\s*(::date|>=|<=|between)/);
      assert.match(sql, /f.target_type = 'processed_content'/);
      assert.match(sql, /f.feedback_type = 'routing_error'/);
      assert.match(sql, /f.before_value->>'routing' = 'digest'/);
      assert.match(sql, /f.after_value->>'routing' = 'event'/);
      assert.match(sql, /f.after_value->>'source' = 'stage3_consolidation'/);
      assert.match(sql, /f.before_value->>'category' as category/);
      assert.match(sql, /left join event_groups/);
      assert.match(sql, /eg.daily_date = pc.daily_date/);
      assert.doesNotMatch(sql, /join event_group_items|pc.routing\s*=/);
      const rows = new Map<string, (typeof records)[number]>();
      for (const row of [...records].sort((a, b) => b.time - a.time)) {
        if (row.automatic && row.date === args[0] && !rows.has(row.id)) rows.set(row.id, row);
      }
      return {
        rows: [...rows.values()].map((row) => ({
          id: row.id,
          group_id: row.group,
          category: row.category,
          event_hint: row.group === 'deleted-group' ? null : `Hint ${row.group}`,
          title: `Title ${row.id}`,
          source: 'Test Source',
          url: row.id === 'article-d' ? 'javascript:alert(1)' : 'https://example.org/article',
        })),
      };
    }
    assert.match(sql, /from pipeline_runs/);
    assert.match(sql, /daily_date = \$1::date/);
    assert.match(sql, /step = 'stage3'/);
    assert.match(sql, /jsonb_typeof\(details->'consolidation'\) = 'object'/);
    assert.match(sql, /details->'consolidation' <> '\{\}'::jsonb/);
    assert.match(sql, /order by started_at desc, id desc limit 1/);
    return {
      rows:
        args[0] === day || args[0] === '2026-10-30'
          ? [{ id: 'run-latest', status: 'partial' }]
          : [],
    };
  },
});
const auth = await import('../src/lib/admin-auth.js');
const route = await import('../src/app/api/admin/review/event_consolidation/route.js');
const { getDatabasePool } = await import('../src/db/index.js');
const { ConsolidationResults } =
  await import('../src/app/(admin)/review/event_consolidation/consolidation-results.js');
const { default: Page } = await import('../src/app/(admin)/review/event_consolidation/page.js');
try {
  process.env.ADMIN_PASSWORD_HASH = await auth.createAdminPasswordHash('consolidation-test');
  const cookie = auth.sessionCookie(await auth.createAdminSession()).split(';')[0]!;
  const request = (date: string, authenticated = true) =>
    new Request(
      `http://localhost:3000/ai/api/admin/review/event_consolidation${date ? `?date=${date}` : ''}`,
      { headers: authenticated ? { cookie } : {} },
    );
  assert.equal((await route.GET(request(day, false))).status, 401);
  assert.equal(queries.length, 0);
  for (const date of ['', '2026-02-30', 'yesterday', '2026-10-29%27'])
    assert.equal((await route.GET(request(date))).status, 400);
  assert.equal(queries.length, 0);
  assert.deepEqual(Object.keys(route).sort(), ['GET', 'dynamic', 'runtime']);
  const db = getDatabasePool();
  await assert.rejects(loadEventConsolidationReview(db, '2026-02-30'), RangeError);
  assert.equal(await latestEventConsolidationDate(db), day);
  const data = await loadEventConsolidationReview(db, day);
  assert.equal(data.correctionCount, 4, 'Repeated attempts count the article once');
  assert.equal(data.eventGroupCount, 3);
  const groupA = data.groups.find((g) => g.id === 'group-a')!;
  assert.equal(groupA.articles.length, 2);
  assert.deepEqual(groupA.articles.map((a) => a.category).sort(), ['Company', 'Technology']);
  assert.equal(data.groups.find((g) => g.id === 'group-b')?.articles[0]?.category, 'Policy');
  const missing = data.groups.find((g) => g.id === 'deleted-group')!;
  assert.equal(missing.hint, null);
  assert.equal(missing.articles[0]?.url, null);
  const html = renderToStaticMarkup(createElement(ConsolidationResults, { data }));
  for (const value of [
    'Hint group-a',
    'Hint group-b',
    '原 Event Group 不再可用',
    'Title article-d',
    'Technology',
    'Company',
    'Policy',
    'Routing Corrections',
  ])
    assert.ok(html.includes(value), value);
  assert.doesNotMatch(html, /javascript:|<button|<input|Title manual|other-date/);
  assert.match(html, /rel="noopener noreferrer"/);
  const document = new JSDOM(html).window.document;
  const groupSections = document.querySelectorAll('section[aria-labelledby]');
  assert.equal(groupSections.length, 3);
  const eventA = document.querySelector('[aria-labelledby="event-group-group-a"]')!;
  assert.equal(eventA.querySelector('h2')?.textContent, 'Hint group-a');
  assert.match(eventA.querySelector('header')!.textContent!, /2 articles/);
  assert.equal(eventA.querySelectorAll('ul > li').length, 2);
  assert.equal(eventA.querySelectorAll('li h3').length, 2);
  assert.equal(eventA.querySelectorAll('li > article > .itemMeta').length, 2);
  assert.ok(document.querySelector('section.reviewSection.consolidationReview'));
  const reviewRoot = new URL('../src/app/(admin)/review/', import.meta.url);
  const css = await readFile(new URL('review.module.css', reviewRoot), 'utf8');
  assert.match(css, /\.reviewSection\s*\{\s*max-width: 1180px;\s*margin: 16px auto;/);
  assert.match(css, /\.header\s*\{[^}]*max-width: 100%;[^}]*margin: 16px auto;/);
  assert.doesNotMatch(css, /\.inDepthSection/);
  for (const file of [
    'ranking-review-client.tsx',
    'in-depth/review-client.tsx',
    'ignored/page.tsx',
    'model-evaluation-review-client.tsx',
  ]) {
    assert.match(await readFile(new URL(file, reviewRoot), 'utf8'), /styles.reviewSection/, file);
  }
  assert.ok(
    [...eventA.querySelectorAll('article > .itemMeta')].some(
      (p) => p.textContent === 'Test SourceCompany',
    ),
  );
  assert.equal(
    eventA.querySelectorAll('details:not([open])').length,
    2,
    'IDs are secondary, collapsed diagnostics',
  );
  assert.match(
    document.querySelector('[aria-labelledby="event-group-group-b"] header')!.textContent!,
    /1 article/,
  );
  assert.ok(document.querySelector('header dl')?.textContent?.includes('Routing Corrections'));
  assert.ok(html.includes('Read-only'));

  const empty = await loadEventConsolidationReview(db, '2026-10-31');
  assert.equal(empty.hasRecord, false);
  assert.equal(empty.correctionCount, null);
  assert.equal(empty.eventGroupCount, null);
  assert.match(
    renderToStaticMarkup(createElement(ConsolidationResults, { data: empty })),
    /没有 Consolidation 记录/,
  );
  const zero = await loadEventConsolidationReview(db, '2026-10-30');
  assert.equal(zero.hasRecord, true);
  assert.equal(zero.correctionCount, 0);
  assert.match(
    renderToStaticMarkup(createElement(ConsolidationResults, { data: zero })),
    /尚无已保存/,
  );
  assert.equal((await route.GET(request(day))).status, 200);
  assert.equal((await route.GET(request(day))).headers.get('cache-control'), 'no-store');
  const selected = renderToStaticMarkup(
    await Page({ searchParams: Promise.resolve({ date: '2026-10-31' }) }),
  );
  assert.match(selected, /没有 Consolidation 记录/);
  const defaultPage = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
  assert.match(defaultPage, /value="2026-10-29"/);
  const beforeInvalid = queries.length;
  assert.match(
    renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ date: 'bad' }) })),
    /日期无效/,
  );
  assert.equal(queries.length, beforeInvalid);
  latest = null;
  assert.equal(await latestEventConsolidationDate(db), null);
  fail = true;
  const oldError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args) => {
    errors.push(args);
  };
  try {
    const failed = await route.GET(request(day));
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /mock read failure|postgresql/);
    assert.equal(errors.length, 1);
  } finally {
    console.error = oldError;
  }
  console.log(
    'Consolidation Review query contracts, grouping, dates, empty/history UI and authenticated API passed (Mock SQL; no database connection).',
  );
} finally {
  Object.defineProperty(Pool.prototype, 'query', {
    configurable: true,
    writable: true,
    value: originalQuery,
  });
  Object.defineProperty(Pool.prototype, 'connect', {
    configurable: true,
    writable: true,
    value: originalConnect,
  });
  await getDatabasePool().end();
  await rm(sessionDir, { recursive: true, force: true });
}
