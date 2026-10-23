import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
 if (url.endsWith('.module.css')) return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true}; return nextLoad(url,context);
}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost:3000/ai/dashboard/analytics',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { PutBackButton } = await import('../src/app/(admin)/dashboard/analytics/put-back-button.js');
const root = createRoot(document.getElementById('root')!);
const requests: { url: string; body: unknown }[] = [];
let respond!: (value: Response) => void;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Promise((resolve) => {
    respond = resolve;
  });
};
let saved = 0;
const render = async (id: string, inDigest = false) => {
  await act(async () => {
    root.render(
      createElement(PutBackButton, {
        key: id,
        id,
        date: '2026-10-22',
        inDigest,
        onRestored: () => {
          saved++;
        },
      }),
    );
  });
};
const click = async () => {
  await act(async () => {
    document.querySelector('button')!.click();
  });
};
await render('raw-1');
await click();
await click();
assert.equal(requests.length, 1);
assert.match(document.body.textContent!, /Restoring/);
assert.deepEqual(requests[0]?.body, { id: 'raw-1', date: '2026-10-22' });
assert.equal(
  new URL(requests[0]!.url, dom.window.location.href).pathname,
  '/ai/api/admin/dashboard/analytics/ignored-articles/put-back',
);
const fields = { summary_zh: '已生成的可靠摘要' };
await act(async () => {
  respond(
    Response.json(
      { message: '准备缓存保存失败，请保留文本', generatedFields: fields },
      { status: 503 },
    ),
  );
});
assert.match(document.body.textContent!, /准备缓存保存失败/);
assert.match(document.body.textContent!, /已生成的可靠摘要/);
assert.equal(saved, 0);
await click();
await act(async () => {
  respond(Response.json({ restored: { id: 'processed-1', dailyDate: '2026-10-22', rank: 4 } }));
});
assert.equal(saved, 1);
assert.match(document.body.textContent!, /已进入 Daily 2026-10-22/);
assert.equal(document.querySelector('button')!.disabled, true);
await click();
assert.equal(requests.length, 2);
await render('already-restored', true);
await click();
assert.equal(requests.length, 2);
await render('old-article');
await click();
await render('new-article');
await act(async () => {
  respond(Response.json({ restored: { id: 'old-result' } }));
});
assert.equal(saved, 1);
assert.equal(document.querySelector('button')!.textContent, 'Put Back');
await act(async () => {
  root.unmount();
});
console.log(
  'Put Back UI loading, duplicate guard, failures/text recovery, success, restored state, stale response and relative basePath URL passed.',
);
