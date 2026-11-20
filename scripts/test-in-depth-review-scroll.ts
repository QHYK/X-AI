import assert from 'node:assert/strict';
import { register } from 'node:module';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import type { InDepthReviewItem } from '../src/lib/in-depth-reads.js';
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,next){if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,key)=>key});',shortCircuit:true};return next(url,context);}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/review/in-depth' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { InDepthReviewClient } = await import('../src/app/(admin)/review/in-depth/review-client.js');
const { AppRouterContext } =
  await import('next/dist/shared/lib/app-router-context.shared-runtime.js');
const item = (id: string) =>
  ({
    id,
    candidateId: id,
    runId: null,
    reviewStatus: 'pending',
    editorialNotes: null,
    editorialOverrides: null,
    reviewedAt: null,
    createdAt: '2026-11-20T00:00:00Z',
    candidateCreatedAt: '2026-11-20T00:00:00Z',
    discoveryPath: 'open',
    url: 'https://example.test/work',
    originalTitle: id,
    titleZh: null,
    author: null,
    publication: 'Publisher',
    contentType: 'article',
    estimatedDurationMinutes: 5,
    summary: 'Summary',
    whyWorthReading: 'Reason',
    extraInfo: {},
    evaluation: null,
    evidence: null,
  }) as InDepthReviewItem;
let intersect = () => {};
Object.assign(globalThis, {
  IntersectionObserver: class {
    constructor(
      callback: (entries: { isIntersecting: boolean }[]) => void,
      options: { root: Element },
    ) {
      assert.equal(options.root.className, 'inDepthListPane');
      intersect = () => callback([{ isIntersecting: true }]);
    }
    observe() {}
    disconnect() {}
  },
});
let calls = 0;
let respond!: (response: Response) => void;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.equal(String(url), '/ai/api/admin/review/in-depth?status=pending&cursor=next');
  calls++;
  return new Promise<Response>((resolve) => {
    respond = resolve;
  });
};
const root = createRoot(document.getElementById('root')!);
try {
  await act(async () =>
    root.render(
      createElement(
        AppRouterContext.Provider,
        { value: {} as never },
        createElement(InDepthReviewClient, {
          initialItems: [item('first')],
          initialNextCursor: 'next',
          status: 'pending',
        }),
      ),
    ),
  );
  assert.ok(document.querySelector('.inDepthGrid > article.inDepthDetail'));
  await act(async () => {
    intersect();
    intersect();
  });
  assert.equal(calls, 1);
  assert.equal(
    (document.querySelector('.inDepthListPane .inDepthActions button') as HTMLButtonElement)
      .disabled,
    true,
  );
  await act(async () => respond(Response.json({ error: 'Retry me' }, { status: 500 })));
  assert.match(document.querySelector('.inDepthListPane')!.textContent!, /Retry me/);
  await act(async () => {
    (
      document.querySelector('.inDepthListPane .inDepthActions button') as HTMLButtonElement
    ).click();
  });
  assert.equal(calls, 2);
  await act(async () =>
    respond(
      Response.json({ items: [item('first'), item('second'), item('second')], nextCursor: null }),
    ),
  );
  assert.equal(document.querySelectorAll('.inDepthListItem').length, 2);
  assert.equal(
    document.querySelector('.inDepthListItem[aria-pressed="true"] strong')?.textContent,
    'first',
  );
  assert.match(document.querySelector('.inDepthListPane')!.textContent!, /All candidates loaded/);
  assert.equal(document.querySelector('.inDepthListPane .inDepthActions button'), null);
} finally {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  dom.window.close();
}
console.log(
  'Review scrolling: pane-root observer, one concurrent request, retry, append/dedup, selection retention and last page passed.',
);
