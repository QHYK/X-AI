import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) {
  if (url.endsWith('.module.css')) return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};
  return nextLoad(url,context);
}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/dashboard' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
const { createRoot } = await import('react-dom/client');
const { RuntimeFiles } = await import('../src/app/(admin)/dashboard/runtime-files.js');
const root = createRoot(document.getElementById('root')!);
const requests: URL[] = [];
let copied: string | null = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    clipboard: {
      writeText: async (text: string) => {
        copied = text;
      },
    },
  },
});
globalThis.fetch = async (input) => {
  const url = new URL(String(input), dom.window.location.href);
  requests.push(url);
  if (url.searchParams.get('file')) return Response.json({ content: '{"attempt":"original"}' });
  return Response.json({
    directory: 'runtime/stage3/original',
    entries: url.searchParams.get('path')
      ? [{ name: 'run.json', path: 'events/run.json', directory: false }]
      : [{ name: 'events', path: 'events', directory: true }],
  });
};
const click = async (text: string) => {
  const button = [...document.querySelectorAll('button')].find(
    (node) => node.textContent?.includes(text) || node.getAttribute('aria-label') === text,
  );
  assert(button, text);
  await act(async () => button.click());
};
try {
  await act(async () =>
    root.render(createElement(RuntimeFiles, { runId: 'original', description: 'retry info' })),
  );
  assert.equal(requests.length, 0);
  await click('View Runtime files');
  assert.equal(requests.length, 1);
  assert.equal(document.querySelector('dialog')?.hasAttribute('open'), true);
  await act(async () =>
    root.render(createElement(RuntimeFiles, { runId: 'retry', description: 'retry info' })),
  );
  await click('events');
  assert.equal(requests.length, 2, 'Directory loads only on expansion');
  await click('run.json');
  assert.equal(requests.length, 3, 'File contents are lazy');
  assert(
    requests.every((url) => url.searchParams.get('runId') === 'original'),
    'An open drawer never switches to a newer attempt',
  );
  assert.match(document.querySelector('pre')!.textContent!, /original/);
  await click('Copy content');
  assert.equal(copied, '{"attempt":"original"}');
  await click('run.json');
  assert.equal(document.querySelector('pre'), null);
  await click('run.json');
  assert.equal(requests.length, 3, 'Reopening uses loaded content');
  await click('Close Runtime files');
  assert.equal(document.querySelector('dialog'), null);
  await click('View Runtime files');
  assert.equal(requests.at(-1)!.searchParams.get('runId'), 'retry');
  await click('Close Runtime files');
  await act(async () => root.render(createElement(RuntimeFiles, { description: 'no mapping' })));
  const before = requests.length;
  await click('View Runtime files');
  assert.match(document.body.textContent!, /No reliable Runtime mapping/);
  assert.equal(requests.length, before);
  await click('Close Runtime files');
  globalThis.fetch = async () => Response.json({ message: 'File unavailable.' }, { status: 404 });
  await act(async () =>
    root.render(createElement(RuntimeFiles, { runId: 'missing', description: 'missing' })),
  );
  await click('View Runtime files');
  assert.match(document.body.textContent!, /File unavailable/);
  console.log(
    'PASS: Drawer, inline directory/file expansion, lazy reads, exact attempt frozen across retry, missing mapping and error feedback.',
  );
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
