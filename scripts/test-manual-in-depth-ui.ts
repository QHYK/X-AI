import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { InDepthReviewItem } from '../src/lib/in-depth-reads.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.module.css')) return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};
  return nextLoad(url,context);
}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/review/in-depth' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { ManualCandidateForm } =
  await import('../src/app/(admin)/review/in-depth/manual-candidate-form.js');
const { IntroductionEditor } =
  await import('../src/app/(admin)/review/in-depth/introduction-editor.js');
const root = createRoot(document.getElementById('root')!);
const requests: { url: string; body: Record<string, unknown> }[] = [];
let respond!: (response: Response) => void;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Promise<Response>((resolve) => {
    respond = resolve;
  });
};
const endpoint = () =>
  window.location.pathname.replace(/\/review\/in-depth\/?$/, '/api/admin/review/in-depth');
let selected: InDepthReviewItem | null = null;
await act(async () => {
  root.render(
    createElement(ManualCandidateForm, {
      apiUrl: endpoint,
      disabled: false,
      onCreated: (item) => {
        selected = item;
      },
    }),
  );
});
async function input(index: number, value: string) {
  const node = document.querySelectorAll('input')[index]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(
      node,
      value,
    );
    node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  });
}
await input(0, 'https://example.test/work');
await input(1, '科学方法');
await submit();
assert.equal(requests.length, 0, 'Incomplete bilingual tag must fail before Fetch');
await input(2, 'Scientific Method');
await submit();
await submit();
assert.equal(requests.length, 1);
assert.equal(
  new URL(requests[0]!.url, dom.window.location.href).pathname,
  '/ai/api/admin/review/in-depth/manual',
);
assert.deepEqual(requests[0]!.body.tags, [{ zh: '科学方法', en: 'Scientific Method' }]);
const item = {
  id: 'candidate',
  discoveryPath: 'manual',
  reviewStatus: 'approved',
  titleZh: '已有完整标题',
} as InDepthReviewItem;
await act(async () => {
  respond(Response.json({ item, existing: true }));
});
assert.deepEqual(selected, item);
assert.equal((selected as InDepthReviewItem | null)?.titleZh, '已有完整标题');
assert.match(document.body.textContent!, /没有重新生成/);
assert.equal(requests.length, 1, 'Step 1 never triggers Generate');
await submit();
await act(async () => {
  respond(Response.json({ error: '抓取失败' }, { status: 422 }));
});
assert.match(document.body.textContent!, /抓取失败/);

const intro = {
  summary: '已保存介绍',
  whyWorthReading: '已保存价值',
  extra_info: '已保存具体评估',
};
let updated = false;
await act(async () => {
  root.render(
    createElement(IntroductionEditor, {
      id: item.id,
      overrides: intro,
      apiUrl: endpoint,
      manual: true,
      onGenerated: () => {
        updated = true;
      },
    }),
  );
});
await act(async () => {
  [...document.querySelectorAll('button')].find((b) => b.textContent === 'Regenerate')!.click();
});
assert.equal(requests.at(-1)!.body.regenerate, true);
await act(async () => {
  respond(Response.json({ introduction: intro, saved: true, item }));
});
assert.equal(
  updated,
  true,
  'Manual Generate refreshes title and metadata in the existing detail card',
);
await act(async () => {
  root.unmount();
});
console.log(
  'Manual URL/tags form, duplicate submit, existing candidate, errors, basePath URL and explicit Regenerate UI passed.',
);
