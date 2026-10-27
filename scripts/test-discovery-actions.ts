import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(name, context, next) {
  if (name === 'next/navigation.js') return {url:'data:text/javascript,export const useRouter = () => ({ refresh() {} });',shortCircuit:true};
  return next(name,context);
}
export async function load(url, context, next) {
  if(url.endsWith('.module.css')) return {format:'module',source:'export default {}',shortCircuit:true};
  return next(url,context);
}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost:3000/ai/dashboard?date=2026-10-19',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { DiscoveryActions } = await import('../src/app/(admin)/dashboard/discovery-actions.js');
let allow = false,
  confirmation = '';
dom.window.confirm = (message) => {
  confirmation = String(message);
  return allow;
};
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let respond!: (response: Response) => void;
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
  return new Promise((resolve) => {
    respond = resolve;
  });
};
const root = createRoot(document.getElementById('root')!);
for (const mode of ['regular', 'open', 'd2'] as const) {
  await act(async () =>
    root.render(
      createElement(DiscoveryActions, {
        key: mode,
        date: '2026-10-19',
        mode,
        ...(mode === 'd2' ? { runId: 'original-run' } : {}),
      }),
    ),
  );
  const button = () => document.querySelector('button')!;
  const before = requests.length;
  await act(async () => button().click());
  assert.equal(requests.length, before);
  assert.match(confirmation, /2026-10-18 至 2026-10-19/);
  assert.match(confirmation, /付费/);
  allow = true;
  await act(async () => {
    button().click();
    button().click();
  });
  assert.equal(requests.length, before + 1);
  assert.equal(button().disabled, true);
  assert.equal(requests.at(-1)!.url, './api/admin/discovery');
  const body = requests.at(-1)!.body;
  assert.equal(body.mode, mode);
  if (mode === 'd2') {
    assert.equal(body.runId, 'original-run');
    assert.equal('date' in body, false);
    assert.match(confirmation, /复用原 Run/);
  } else assert.equal(body.date, '2026-10-19');
  assert.equal(body.confirmPaid, true);
  assert.match(String(body.requestId), /^[a-f0-9]{32}$/);
  await act(async () =>
    respond(Response.json({ error: 'Temporary network error' }, { status: 500 })),
  );
  await act(async () => button().click());
  assert.equal(
    requests.at(-1)!.body.requestId,
    body.requestId,
    'Network retry reuses durable request ID',
  );
  await act(async () =>
    respond(Response.json({ id: 'queued', status: 'pending' }, { status: 202 })),
  );
  assert.equal(button().disabled, true);
  assert.match(document.body.textContent!, /pending/);
  allow = false;
}
await act(async () =>
  root.render(
    createElement(DiscoveryActions, {
      key: 'unavailable',
      date: '2026-10-19',
      mode: 'd2',
      runId: 'historical',
      available: false,
    }),
  ),
);
assert.equal(document.querySelector('button')!.disabled, true);
await act(async () => root.unmount());
dom.window.close();
console.log(
  'Discovery buttons: paid/window confirmation, correct mode/date/relative URL, duplicate guard, durable retry ID and pending state passed.',
);
