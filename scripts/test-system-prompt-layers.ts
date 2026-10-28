import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import { addSystemPromptLayers, SYSTEM_LAYER_NOTE } from '../src/lib/prompts/system-layers.js';
import { captureSystemFragments } from '../src/lib/prompts/system-fragments.js';
import { promptContentHash, resolvePromptFragments } from '../src/lib/prompts/registry.js';
import {
  productionPrompt,
  withPromptBindings,
  databasePromptBinder,
} from '../src/lib/prompts/runtime.js';
import {
  initializeSystemFragmentFile,
  withFilePrompts,
  writeRunFile,
} from '../src/lib/prompts/run-file.js';
import {
  renderResolvedPrompt,
  validatePromptBody,
  type PromptKey,
  type RegistryKey,
} from '../src/lib/prompts/contracts.js';
const memory = new PromptMemory();
const mutate = (key: RegistryKey, text: string) => {
  const old = memory.versions.get(memory.active.get(key)!)!;
  const body = { ...old.body, systemInstructions: text };
  const next = {
    ...old,
    id: randomUUID(),
    version: old.version + 1,
    body,
    contentHash: promptContentHash(body),
  };
  memory.versions.set(next.id, next);
  memory.active.set(key, next.id);
  return next;
};
for (const key of [
  'daily.stage1.content_understanding',
  'daily.stage4.event_enrichment',
  'discovery.d2.topic_selection',
  'discovery.d4.direct_verification',
  'discovery.d5.open_discovery',
] as const) {
  const old = memory.versions.get(memory.active.get(key)!)!;
  const body = addSystemPromptLayers(key, old.body, [...memory.versions.values()]);
  const next = {
    ...old,
    id: randomUUID(),
    version: old.version + 1,
    body,
    contentHash: promptContentHash(body),
    changeNote: SYSTEM_LAYER_NOTE + old.id,
  };
  memory.versions.set(next.id, next);
  memory.active.set(key, next.id);
  assert.deepEqual(addSystemPromptLayers(key, body), body);
}
mutate('xfield.identity', 'IDENTITY ONE');
mutate('daily_brief.editorial', 'DAILY EDITORIAL');
mutate('discover.editorial', 'DISCOVERY EDITORIAL');
const snapshot = await captureSystemFragments(memory.db);
memory.owners.set('discovery_runs:regular', { systemFragmentVersions: snapshot });
const request = (run: string, key: PromptKey) =>
  withPromptBindings(memory.db, databasePromptBinder(memory.db, 'discovery', run), () =>
    productionPrompt(key, 'MEMORY USER INPUT'),
  );
const original = await request('regular', 'discovery.d2.topic_selection');
assert.ok(original.instructions?.startsWith('IDENTITY ONE\n\nDISCOVERY EDITORIAL\n\n'));
assert.equal(original.input, 'MEMORY USER INPUT');
mutate('xfield.identity', 'IDENTITY TWO');
assert.deepEqual(await request('regular', 'discovery.d2.topic_selection'), original);
assert.ok(
  (await request('regular', 'discovery.d4.direct_verification')).instructions?.startsWith(
    'IDENTITY ONE\n\nDISCOVERY EDITORIAL',
  ),
);
memory.owners.set('discovery_runs:open', {
  systemFragmentVersions: await captureSystemFragments(memory.db),
});
assert.ok(
  (await request('open', 'discovery.d5.open_discovery')).instructions?.startsWith(
    'IDENTITY TWO\n\nDISCOVERY EDITORIAL',
  ),
);
const legacy = await request('legacy', 'discovery.d2.topic_selection');
assert.notEqual(
  legacy.versionId,
  original.versionId,
  'A historical unbound Run uses the explicitly recorded pre-upgrade Request',
);
const oldD2 = memory.versions.get(legacy.versionId)!;
memory.owners.set('discovery_runs:bound-legacy', { promptVersions: { [oldD2.key]: oldD2.id } });
assert.equal((await request('bound-legacy', 'discovery.d2.topic_selection')).versionId, oldD2.id);
const currentD2 = memory.versions.get(memory.active.get('discovery.d2.topic_selection')!)!;
memory.versions.set(currentD2.id, { ...currentD2, changeNote: null });
await assert.rejects(() => request('unprovable', 'discovery.d2.topic_selection'), /Historical Run/);
const fileRoot = await mkdtemp(join(tmpdir(), 'system-fragments-'));
const priorParent = process.env.DAILY_PROMPT_RUN_PATH;
try {
  const parent = join(fileRoot, 'daily.json');
  await initializeSystemFragmentFile(parent, memory.db);
  process.env.DAILY_PROMPT_RUN_PATH = parent;
  const child = join(fileRoot, 'stage1.json');
  const daily = await withFilePrompts(memory.db, child, () =>
    productionPrompt('daily.stage1.content_understanding', 'USER'),
  );
  assert.ok(daily.instructions?.startsWith('IDENTITY TWO\n\nDAILY EDITORIAL'));
  mutate('xfield.identity', 'IDENTITY THREE');
  assert.deepEqual(
    await withFilePrompts(memory.db, child, () =>
      productionPrompt('daily.stage1.content_understanding', 'USER'),
    ),
    daily,
  );
  await writeRunFile(parent, { status: 'completed' });
  assert.deepEqual(
    JSON.parse(await readFile(parent, 'utf8')).systemFragmentVersions,
    JSON.parse(await readFile(child, 'utf8')).systemFragmentVersions,
  );
  const stage4 = memory.versions.get(memory.active.get('daily.stage4.event_enrichment')!)!;
  for (const variant of ['with_search', 'without_search']) {
    const rendered = renderResolvedPrompt(
      stage4,
      await resolvePromptFragments(memory.db, stage4, snapshot),
      { input: 'USER' },
      variant,
    );
    assert.ok(rendered.instructions?.startsWith('IDENTITY ONE\n\nDAILY EDITORIAL'));
  }
  const pinned = memory.versions.get(memory.active.get('discovery.d3.topic_discovery')!)!;
  const before = await resolvePromptFragments(memory.db, pinned);
  mutate(
    'shared.discovery.editorial_criteria',
    'NEW ACTIVE ordinary fragment must not affect pinned Request',
  );
  assert.deepEqual(await resolvePromptFragments(memory.db, pinned), before);
  assert.throws(
    () =>
      validatePromptBody(currentD2.key, 'request', {
        ...currentD2.body,
        fragments: [...currentD2.body.fragments, { slot: 'again', activeKey: 'xfield.identity' }],
      }),
    /Duplicate active/,
  );
  console.log('Actual renderer preview (Mock registry, no model):\n' + daily.instructions);
} finally {
  if (priorParent === undefined) delete process.env.DAILY_PROMPT_RUN_PATH;
  else process.env.DAILY_PROMPT_RUN_PATH = priorParent;
  await rm(fileRoot, { recursive: true, force: true });
}
memory.active.delete('xfield.identity');
await assert.rejects(() => captureSystemFragments(memory.db), /must be initialized/);
console.log(
  'System layers: explicit order, fixed Run snapshot, Active changes, independent Open, legacy refusal, atomic file retention, Stage4 variants, Memory preservation and pinned ordinary fragments passed.',
);
