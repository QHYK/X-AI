import assert from 'node:assert/strict';
import { register } from 'node:module';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { Memory } from '../src/lib/memory-contracts.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,nextLoad){if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};return nextLoad(url,context);}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/memories' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { MemoryManagement } = await import('../src/app/(admin)/memories/memory-management.js');
const base = {
  id: randomUUID(),
  content: 'Disabled high',
  type: 'general' as const,
  priority: 5,
  enabled: false,
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
};
const records: Memory[] = [
  base,
  {
    ...base,
    id: randomUUID(),
    content: 'Newer topic',
    type: 'topic',
    priority: 2,
    enabled: true,
    createdAt: '2026-10-24T00:00:00Z',
  },
  {
    ...base,
    id: randomUUID(),
    content: 'Older source',
    type: 'source',
    priority: 2,
    createdAt: '2026-10-23T00:00:00Z',
  },
];
const writes: { method: string; body: Record<string, unknown> }[] = [];
let failWrite = false;
let failNextRead = false;
let holdRead = false;
let heldRead: (() => void) | undefined;
let holdWrite = false;
let heldWrite: (() => void) | undefined;
globalThis.fetch = async (url, init) => {
  const target = new URL(String(url), window.location.href);
  assert.equal(target.pathname, '/ai/api/admin/memories');
  assert.ok(String(url).startsWith('./'), 'Browser URL must remain relative');
  const method = init?.method ?? 'GET';
  if (method === 'GET') {
    if (failNextRead) {
      failNextRead = false;
      return Response.json({ error: 'Read failed' }, { status: 503 });
    }
    const type = target.searchParams.get('type');
    const items = records
      .filter((r) => !type || r.type === type)
      .sort((a, b) => b.priority - a.priority || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    if (holdRead) {
      holdRead = false;
      await new Promise<void>((resolve) => {
        heldRead = resolve;
      });
    }
    return Response.json({ items });
  }
  const body = JSON.parse(String(init?.body));
  writes.push({ method, body });
  if (failWrite) return Response.json({ error: 'Save failed' }, { status: 503 });
  if (holdWrite) {
    holdWrite = false;
    await new Promise<void>((resolve) => {
      heldWrite = resolve;
    });
  }
  let item: Memory;
  if (method === 'POST') {
    item = {
      ...body,
      id: randomUUID(),
      createdAt: '2026-10-27T00:00:00Z',
      updatedAt: '2026-10-27T00:00:00Z',
    };
    records.push(item);
  } else {
    item = records.find((r) => r.id === body.id)!;
    Object.assign(item, body);
  }
  return Response.json({ item }, { status: method === 'POST' ? 201 : 200 });
};
let root = createRoot(document.getElementById('root')!);
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-memory-id]')];
const row = (id: string) => {
  const node = document.querySelector<HTMLElement>(`[data-memory-id="${id}"]`);
  assert.ok(node, id);
  return node;
};
async function click(text: string, scope: ParentNode = document) {
  const node = [...scope.querySelectorAll('button')].find((n) => n.textContent?.trim() === text);
  assert.ok(node, text);
  await act(async () => node.click());
}
async function change(label: string, value: string, scope: ParentNode = document) {
  const node = scope.querySelector(`[aria-label="${label}"]`) as
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  assert.ok(node, label);
  const prototype =
    node.tagName === 'TEXTAREA'
      ? dom.window.HTMLTextAreaElement.prototype
      : node.tagName === 'SELECT'
        ? dom.window.HTMLSelectElement.prototype
        : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(
      new dom.window.Event(node.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }),
    );
  });
}
const checkbox = (scope: ParentNode) =>
  scope.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
await act(async () => root.render(createElement(MemoryManagement)));
assert.deepEqual(
  rows().map((r) => r.dataset.memoryId),
  records.map((r) => r.id),
);
assert.equal(checkbox(row(base.id)).checked, false);
assert.equal(checkbox(row(base.id)).disabled, true);
await act(async () => checkbox(row(base.id)).click());
assert.equal(writes.length, 0);
await change('Memory Type filter', 'topic');
assert.deepEqual(
  rows().map((r) => r.dataset.memoryId),
  [records[1].id],
);
await change('Memory Type filter', 'all');
assert.equal(rows().length, 3);
await click('Add Memory');
assert.equal((row('new').querySelector('textarea') as HTMLTextAreaElement).value, '');
assert.equal((row('new').querySelector('select') as HTMLSelectElement).value, 'general');
assert.equal((row('new').querySelector('input[type="number"]') as HTMLInputElement).value, '0');
assert.equal(checkbox(row('new')).checked, true);
await click('Submit', row('new'));
assert.equal(writes.length, 0);
assert.ok(row('new').querySelector('[role="alert"]'));
await change('Content', 'Saved content', row('new'));
await change('Priority', '20', row('new'));
await change('Type', 'content', row('new'));
await act(async () => checkbox(row('new')).click());
await click('Submit', row('new'));
const created = records.find((r) => r.content === 'Saved content')!;
assert.equal(created.enabled, false);
assert.equal(rows()[0].dataset.memoryId, created.id);
assert.equal(document.querySelector('[data-memory-id="new"]'), null);
let count = writes.length;
await click('Add Memory');
await change('Content', 'Cancel draft', row('new'));
await click('Cancel', row('new'));
assert.equal(writes.length, count);
await click('Edit', row(created.id));
await change('Content', 'Unsaved edit', row(created.id));
assert.equal(checkbox(row(created.id)).disabled, false);
await act(async () => checkbox(row(created.id)).click());
assert.equal(checkbox(row(created.id)).checked, true);
assert.equal(writes.length, count);
failWrite = true;
await click('Submit', row(created.id));
assert.equal(
  (row(created.id).querySelector('textarea') as HTMLTextAreaElement).value,
  'Unsaved edit',
);
assert.match(row(created.id).textContent ?? '', /Save failed/);
assert.equal(checkbox(row(created.id)).checked, true);
count = writes.length;
await click('Cancel', row(created.id));
assert.equal(writes.length, count);
assert.match(row(created.id).textContent ?? '', /Saved content/);
assert.equal(checkbox(row(created.id)).checked, false);
assert.equal(checkbox(row(created.id)).disabled, true);
failWrite = false;
await click('Edit', row(created.id));
await change('Content', 'Edited content', row(created.id));
await change('Priority', '1', row(created.id));
await change('Type', 'source', row(created.id));
await act(async () => checkbox(row(created.id)).click());
holdWrite = true;
count = writes.length;
await click('Submit', row(created.id));
assert.equal(writes.length, count + 1);
assert.equal((row(created.id).querySelector('button') as HTMLButtonElement).disabled, true);
await click('Submit', row(created.id));
assert.equal(writes.length, count + 1, 'Disabled Submit prevents duplicate requests');
await act(async () => heldWrite!());
assert.equal(rows().at(-1)?.dataset.memoryId, created.id);
assert.equal(row(created.id).querySelector('textarea'), null);
// Enabled remains read-only after submitting; all fields were saved in one PATCH.
assert.equal(checkbox(row(created.id)).disabled, true);
assert.equal(checkbox(row(created.id)).checked, true);
assert.deepEqual(writes.at(-1)?.body, {
  id: created.id,
  content: 'Edited content',
  type: 'source',
  priority: 1,
  enabled: true,
});
count = writes.length;
await act(async () => checkbox(row(base.id)).click());
assert.equal(writes.length, count);
assert.equal(checkbox(row(base.id)).checked, false);
assert.equal(rows().length, 4);
await change('Memory Type filter', 'source');
assert.deepEqual(
  rows().map((r) => r.dataset.memoryId),
  [records[2].id, created.id],
);
// A slow response for a previous filter cannot overwrite the newest filter's list.
holdRead = true;
await change('Memory Type filter', 'topic');
await change('Memory Type filter', 'source');
await act(async () => heldRead!());
assert.deepEqual(
  rows().map((r) => r.dataset.memoryId),
  [records[2].id, created.id],
);
await act(async () => root.unmount());
root = createRoot(document.getElementById('root')!);
await act(async () => root.render(createElement(MemoryManagement)));
assert.equal(rows().length, 4);
assert.equal(checkbox(row(base.id)).checked, false);
assert.match(row(created.id).textContent ?? '', /Edited content/);
// A successful write followed by a failed list refresh must not be reported as an unsaved edit.
await click('Edit', row(created.id));
await change('Content', 'Saved before refresh failure', row(created.id));
failNextRead = true;
await click('Submit', row(created.id));
assert.equal(row(created.id).querySelector('textarea'), null);
assert.match(row(created.id).textContent ?? '', /Saved before refresh failure/);
assert.match(document.body.textContent ?? '', /列表刷新失败/);
assert.equal(records.find((r) => r.id === created.id)?.content, 'Saved before refresh failure');
await act(async () => root.unmount());
dom.window.close();
console.log(
  'Memory UI: create/edit/cancel, validation, failed-save preservation, edit-only Enabled with atomic submit/cancel, duplicate submit, ordering/filtering, stale responses, relative URLs and fresh mount passed (Mock API).',
);
