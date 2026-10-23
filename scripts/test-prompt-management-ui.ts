import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { buildProductionPromptSeeds } from '../src/lib/prompts/production-seeds.js';
import {
  initialPromptVersion,
  promptContentHash,
  type ManagedPromptVersion,
  type PromptManagementDetail,
  type PromptRegistryItem,
} from '../src/lib/prompts/registry.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,nextLoad){if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};return nextLoad(url,context);}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/prompts' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { PromptManagement } = await import('../src/app/(admin)/prompts/prompt-management-client.js');
const seeds = await buildProductionPromptSeeds('a'.repeat(40));
const details = new Map<string, PromptManagementDetail>();
const versions: ManagedPromptVersion[] = seeds.map((s) => ({
  ...s,
  registryId: randomUUID(),
  version: initialPromptVersion(s.source.legacyVersion),
  status: 'published',
  contentHash: promptContentHash(s.body),
  sourceCommit: s.source.sourceCommit ?? null,
  legacyVersion: s.source.legacyVersion ?? null,
  createdAt: '2026-10-24T00:00:00Z',
  changeNote: null,
}));
const fragments = versions.filter((v) => v.kind === 'fragment');
const items: PromptRegistryItem[] = seeds.map((s) => {
  const v = versions.find((v) => v.key === s.key)!;
  return {
    ...s,
    id: v.registryId,
    activeVersionId: v.id,
    activeVersion: v.version,
    updatedAt: v.createdAt,
  };
});
for (const item of items)
  details.set(item.key, {
    registry: item,
    versions: [versions.find((v) => v.key === item.key)!],
    fragments,
  });
// Put Stage1 first so the initial selection is deterministic.
items.sort(
  (a, b) =>
    Number(b.key === 'daily.stage1.content_understanding') -
    Number(a.key === 'daily.stage1.content_understanding'),
);
const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
let conflict = false;
let pending: ((r: Response) => void) | null = null;
let hold = false;
const confirmations: string[] = [];
let confirm = true;
window.confirm = (message) => {
  confirmations.push(message ?? '');
  return confirm;
};
globalThis.fetch = async (url, init) => {
  const method = init?.method ?? 'GET';
  const pathname = new URL(String(url), window.location.href).pathname;
  assert.ok(pathname.startsWith('/ai/api/admin/prompts'));
  assert.ok(!pathname.includes('/ai/ai/'));
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ url: String(url), method, body });
  if (method === 'GET')
    return pathname.endsWith('/prompts')
      ? Response.json({ items })
      : Response.json(details.get(decodeURIComponent(pathname.split('/').at(-1)!)));
  if (hold)
    return new Promise<Response>((resolve) => {
      pending = resolve;
    });
  if (conflict) return Response.json({ error: 'Draft has changed' }, { status: 409 });
  const d = details.get(pathname.split('/').at(-1)!)!;
  let version = d.versions.find((v) => v.id === (body.versionId ?? body.sourceVersionId))!;
  if (body.action === 'createDraft') {
    version = {
      ...structuredClone(version),
      id: randomUUID(),
      version: Math.max(...d.versions.map((v) => v.version)) + 1,
      status: 'draft',
    };
    d.versions.unshift(version);
  } else if (method === 'PATCH') {
    version.body = body.body;
    version.contentHash = promptContentHash(version.body);
  } else if (body.action === 'publish') version.status = 'published';
  else if (body.action === 'activate') {
    assert.equal(body.expectedActiveVersionId, d.registry.activeVersionId);
    d.registry.activeVersionId = version.id;
    d.registry.activeVersion = version.version;
  }
  return Response.json({ version });
};
const root = createRoot(document.getElementById('root')!);
async function mount() {
  await act(async () => root.render(createElement(PromptManagement)));
}
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(
    (n) => n.textContent?.trim() === text,
  );
  assert.ok(button, `Button ${text}`);
  await act(async () => button.click());
}
async function change(label: string, value: string) {
  const node = document.querySelector(`[aria-label="${label}"]`) as
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
async function selectKey(key: string) {
  const button = [...document.querySelectorAll('aside button')].find((b) =>
    b.textContent?.includes(key),
  );
  assert.ok(button, key);
  await act(async () => (button as HTMLButtonElement).click());
}
const text = () => document.body.textContent!;
const field = (label: string) =>
  document.querySelector(`[aria-label="${label}"]`) as HTMLTextAreaElement;
await mount();
assert.match(text(), /18 \/ 18 Registry/);
assert.equal(document.querySelectorAll('aside li').length, 18);
await change('Prompt 类型', 'fragment');
assert.equal(document.querySelectorAll('aside li').length, 3);
await change('Prompt 类型', 'all');
await change('搜索 Prompt Key', 'daily.stage1');
assert.equal(document.querySelectorAll('aside li').length, 1);
await change('搜索 Prompt Key', '');
assert.equal(
  field('基础 System Instructions').matches(':disabled'),
  true,
  'Published is read-only',
);
await click('从此版本创建 Draft');
await change('基础 System Instructions', 'Unsaved local text');
conflict = true;
const before = requests.length;
await click('保存 Draft');
assert.equal(requests.length, before + 1, '409 must not trigger refresh');
assert.equal(field('基础 System Instructions').value, 'Unsaved local text');
assert.match(text(), /发生冲突/);
assert.equal(requests.at(-1)!.method, 'PATCH');
conflict = false;
await change('基础 User Prompt Template', '{{illegal}}');
const invalid = requests.length;
await click('保存 Draft');
assert.equal(requests.length, invalid, 'Invalid template fails before network');
await change('基础 User Prompt Template', '{{input}}');
hold = true;
await click('保存 Draft');
await click('保存 Draft');
assert.equal(requests.length, invalid + 1, 'Only one pending save');
assert.equal(
  field('基础 System Instructions').matches(':disabled'),
  true,
  'Editing disabled while committing',
);
await act(async () => pending!(Response.json({ error: 'Database unavailable' }, { status: 503 })));
hold = false;
assert.equal(field('基础 System Instructions').value, 'Unsaved local text', 'Error preserves text');
await click('保存 Draft');
const daily = details.get('daily.stage1.content_understanding')!;
const previousActive = daily.registry.activeVersionId;
await click('Publish');
assert.equal(daily.registry.activeVersionId, previousActive);
assert.match(text(), /当前 Active 未改变/);
confirm = false;
const beforeCancel = requests.length;
await click('设为 Active');
assert.equal(requests.length, beforeCancel);
assert.match(confirmations.at(-1)!, /从 v5 切换到 v6/);
confirm = true;
await click('设为 Active');
assert.equal(daily.registry.activeVersion, daily.versions[0].version);
const history = [...document.querySelectorAll('[aria-label="完整版本历史"] button')].find((b) =>
  b.textContent?.startsWith('v5'),
)!;
await act(async () => (history as HTMLButtonElement).click());
await click('回滚并设为 Active');
assert.match(confirmations.at(-1)!, /从 v6 切换到 v5/);
assert.equal(daily.registry.activeVersionId, previousActive);
await selectKey('daily.stage4.event_enrichment');
await click('从此版本创建 Draft');
const originalNoSearch = field('without_search System Instructions').value;
await change('with_search System Instructions', 'Search-only edit');
await change('without_search User Prompt Template', '{{bad}}');
const badVariant = requests.length;
await click('保存 Draft');
assert.equal(requests.length, badVariant);
await change('without_search User Prompt Template', '{{input}}');
await click('保存 Draft');
assert.equal(field('without_search System Instructions').value, originalNoSearch);
assert.equal(field('with_search System Instructions').value, 'Search-only edit');
await selectKey('discovery.d3.topic_discovery');
const pinned = details.get('discovery.d3.topic_discovery')!.versions[0].body.fragments[0].versionId;
assert.equal(
  (document.querySelector('[aria-label="Fragment version 1"]') as HTMLSelectElement).value,
  pinned,
);
assert.ok(document.querySelector('pre')?.textContent, 'Exact Fragment content visible');
await selectKey(fragments[0].key);
assert.match(text(), /不会自动升级 Request/);
assert.ok(field('Fragment 内容'));
// A fresh trailing-slash page must resolve the same basePath once.
await act(async () => root.render(null));
window.history.replaceState(null, '', '/ai/prompts/');
await mount();
assert.ok(requests.at(-1)!.url.startsWith('../api/admin/prompts'));
await act(async () => root.unmount());
dom.window.close();
console.log(
  'PASS Prompt UI: 18 registries, filtering/history, Draft/save/Publish/Activate/rollback, 409 preserves edits, duplicate guard, variants, pinned fragments, basePath',
);
