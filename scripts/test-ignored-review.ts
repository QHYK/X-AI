/** Mock-only Review regression: no database, Pipeline or model calls. */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import * as React from 'react';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Pool } from 'pg';
import { loadAiIgnoredArticles, type AiIgnoredArticle } from '../src/lib/dashboard-analytics.js';
import { resolveDailyScope, isDailyScopeCompleted } from '../src/lib/daily-scope.js';
import { parseBriefDate } from '../src/lib/brief-date.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,nextLoad){
 if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k})',shortCircuit:true};
 return nextLoad(url,context);
}`)}`,
  import.meta.url,
);
const article: AiIgnoredArticle = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Ignored title',
  sourceName: 'Source A',
  url: 'https://example.test/article',
  contentText: '完整正文 <script>unsafe()</script>\n' + '正文'.repeat(6000),
  ignoreReason: null,
};
const queries: Array<{ sql: string; values: unknown[] }> = [];
let rows: AiIgnoredArticle[] = [article];
const db = {
  query: async (sql: string, values: unknown[]) => {
    queries.push({ sql, values });
    assert.match(sql, /ra.stage1_status = 'ignored' and ra.processing_error is null/);
    assert.match(sql, /ra.stage1_processed_at is not null/);
    assert.match(sql, /ra.published_at >= \$1::timestamptz and ra.published_at < \$2::timestamptz/);
    assert.match(sql, /ra.content_text as "contentText"/);
    assert.match(sql, /null::text as "ignoreReason"/);
    assert.match(sql, /not exists[\s\S]*pc.routing = 'digest'/);
    assert.doesNotMatch(
      sql,
      /substring|left\(|coalesce\(ra.processing_error|ra.stage1_status = 'failed'/i,
    );
    return { rows };
  },
} as unknown as Pool;
for (const date of ['2026-10-29', '2027-01-01', '2026-11-01']) {
  const scope = resolveDailyScope(date);
  assert.deepEqual(await loadAiIgnoredArticles(db, scope), [article]);
  assert.deepEqual(queries.at(-1)!.values, [scope.startAt, scope.endAt]);
}
assert.deepEqual(queries[0]!.values, ['2026-10-28T00:30:00.000Z', '2026-10-29T00:30:00.000Z']);
rows = [];
assert.deepEqual(await loadAiIgnoredArticles(db, resolveDailyScope('2026-10-29')), []);
await assert.rejects(
  loadAiIgnoredArticles(
    {
      query: async () => {
        throw new Error('DB unavailable');
      },
    } as unknown as Pool,
    resolveDailyScope('2026-10-29'),
  ),
  /DB unavailable/,
);

// Execute the actual Server Component with its existing imports replaced by safe fixtures.
const { ReviewHeader } = await import('../src/app/(admin)/review/review-header.js');
const source = await readFile('src/app/(admin)/review/ignored/page.tsx', 'utf8');
const parsed = ts.createSourceFile(
  'page.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const body = parsed.statements
  .filter((s) => !ts.isImportDeclaration(s))
  .map((s) => s.getText(parsed))
  .join('\n');
const exports: {
  default?: (props: {
    searchParams: Promise<Record<string, unknown>>;
  }) => Promise<React.ReactElement>;
} = {};
runInNewContext(
  ts.transpileModule(body, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText,
  {
    exports,
    React,
    getDatabasePool: () => db,
    parseBriefDate,
    loadAiIgnoredArticles,
    resolveDailyScope: (date?: string) => resolveDailyScope(date, new Date('2026-10-29T05:00:00Z')),
    isDailyScopeCompleted: (scope: ReturnType<typeof resolveDailyScope>) =>
      isDailyScopeCompleted(scope, new Date('2026-10-29T05:00:00Z')),
    ReviewHeader,
    IgnoredArticlesList: () => null,
    styles: {},
  },
);
for (const [date, expected] of [
  ['2026-10-22', '2026-10-22'],
  ['invalid', '2026-10-29'],
]) {
  const html = renderToStaticMarkup(
    await exports.default!({ searchParams: Promise.resolve({ date }) }),
  );
  assert.ok(html.includes(`value="${expected}"`));
  assert.ok(html.includes('action="./ignored"'));
  assert.deepEqual(queries.at(-1)!.values, [
    resolveDailyScope(expected).startAt,
    resolveDailyScope(expected).endAt,
  ]);
}
const beforeFuture = queries.length;
assert.match(
  renderToStaticMarkup(
    await exports.default!({ searchParams: Promise.resolve({ date: '2099-01-01' }) }),
  ),
  /尚未结束/,
);
assert.equal(queries.length, beforeFuture);

const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost:3000/ai/review/ignored?date=2026-10-22',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { IgnoredArticlesList } =
  await import('../src/app/(admin)/review/ignored/ignored-articles-list.js');
const root = createRoot(document.getElementById('root')!);
const requests: Array<{ url: string; body: unknown }> = [];
let respond!: (response: Response) => void;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Promise<Response>((resolve) => {
    respond = resolve;
  });
};
const render = async (date: string, items = [article]) => {
  await act(async () => {
    root.render(createElement(IgnoredArticlesList, { key: date, date, items }));
  });
};
const click = async () => {
  await act(async () => {
    document.querySelector('button')!.click();
  });
};
await render('2026-10-22');
assert.match(document.body.textContent!, /Source A|Ignored title/);
assert.equal(document.querySelector('details')!.open, false);
document.querySelector('details')!.open = true;
assert.equal(
  document.querySelector('pre')!.textContent,
  article.contentText,
  'Full content_text is never truncated',
);
assert.equal(document.querySelectorAll('script').length, 0, 'Article text is escaped');
assert.doesNotMatch(document.body.textContent!, /Ignore reason|未保存判断理由|Original article/);
assert.deepEqual(
  [...document.querySelectorAll('thead th')].map((cell) => cell.textContent),
  ['Source', 'Title / Content', '操作'],
);
assert.equal(document.querySelector('h2 a')!.textContent, '↗');
assert.equal(document.querySelector('h2 a')!.getAttribute('aria-label'), '打开原文：Ignored title');
assert.ok(document.querySelector('summary')!.textContent!.length < 200);
await click();
await click();
assert.equal(requests.length, 1);
assert.deepEqual(requests[0]!.body, { id: article.id, date: '2026-10-22' });
assert.equal(
  new URL(requests[0]!.url, dom.window.location.href).pathname,
  '/ai/api/admin/dashboard/analytics/ignored-articles/put-back',
);
await act(async () => {
  respond(Response.json({ message: 'Mock restore failure' }, { status: 503 }));
});
assert.match(document.querySelector('[role="alert"]')!.textContent!, /Mock restore failure/);
assert.equal(document.querySelectorAll('tbody tr').length, 1);
assert.equal(document.querySelector('button')!.disabled, false);
await click();
assert.equal(requests.length, 2);
await act(async () => {
  respond(Response.json({ restored: { dailyDate: '2026-10-22', alreadyInDigest: true } }));
});
assert.equal(document.querySelectorAll('tbody tr').length, 0);
assert.match(document.body.textContent!, /恢复到 Daily 2026-10-22/);
await render('2026-10-23', [{ ...article, contentText: null, ignoreReason: null, url: null }]);
assert.equal(
  document.querySelectorAll('tbody tr').length,
  1,
  'Date navigation resets the previous date list',
);
assert.match(document.body.textContent!, /没有保存 content_text/);
await click();
assert.deepEqual(requests.at(-1)!.body, { id: article.id, date: '2026-10-23' });
await render('2026-10-24', []);
await act(async () => {
  respond(Response.json({ restored: { dailyDate: '2026-10-23' } }));
});
assert.doesNotMatch(
  document.body.textContent!,
  /恢复到 Daily 2026-10-23/,
  'Late responses do not alter a different date',
);
assert.match(document.body.textContent!, /No AI ignored articles/);
await act(async () => root.unmount());
dom.window.close();
console.log(
  'PASS Ignored Review: Daily date boundaries, AI-only query contract, conservative legacy filtering, full collapsed content, escaped text, Put Back failure/retry/idempotency, relative basePath URL and date-change isolation (Mock only).',
);
