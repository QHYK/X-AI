import assert from 'node:assert/strict';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import {
  validatePromptBody,
  renderResolvedPrompt,
  type PromptBody,
  type PromptVersion,
} from '../src/lib/prompts/contracts.js';
import { resolvePromptFragments } from '../src/lib/prompts/registry.js';
import { keyReferenceBody, syncKeyReferences } from '../src/lib/prompts/fragment-editor.js';
const db = new PromptMemory();
const active = (key: string) => db.versions.get(db.active.get(key as never)!)!;
const original = active('discovery.d3.topic_discovery');
const fragments = [...db.versions.values()].filter((v) => v.kind === 'fragment');
const unchanged = JSON.stringify(original);
const body = keyReferenceBody(original.body, fragments);
assert.ok(body.fragments.every((ref) => ref.key && !ref.slot));
const converted = { ...original, body };
assert.deepEqual(
  renderResolvedPrompt(converted, await resolvePromptFragments(db.db, converted), {
    input: 'INPUT',
  }),
  renderResolvedPrompt(original, await resolvePromptFragments(db.db, original), { input: 'INPUT' }),
);
assert.equal(JSON.stringify(original), unchanged, 'Published body not mutated');
const a = active('shared.discovery.editorial_criteria');
const b = active('shared.discovery.tags');
const reordered: PromptVersion = {
  ...original,
  body: {
    systemInstructions: `{{fragment.${b.key}}}\nSEP\n{{fragment.${a.key}}}`,
    userTemplate: '{{input}}',
    variants: {},
    fragments: [
      { key: a.key as never, versionId: a.id },
      { key: b.key as never, versionId: b.id },
    ],
  },
};
const rendered = renderResolvedPrompt(reordered, await resolvePromptFragments(db.db, reordered), {
  input: 'INPUT',
});
assert.equal(
  rendered.instructions,
  `${b.body.systemInstructions}\nSEP\n${a.body.systemInstructions}`,
);
const mismatch = {
  ...reordered,
  body: {
    ...reordered.body,
    fragments: [
      { key: a.key as never, versionId: b.id },
      { key: b.key as never, versionId: a.id },
    ],
  },
};
await assert.rejects(resolvePromptFragments(db.db, mismatch), /mismatch/);
const dynamic: PromptVersion = {
  ...original,
  body: {
    systemInstructions: '{{fragment.xfield.identity}}',
    userTemplate: '{{input}}',
    variants: {},
    fragments: [{ key: 'xfield.identity', activeKey: 'xfield.identity' }],
  },
};
assert.doesNotThrow(() => validatePromptBody(dynamic.key, 'request', dynamic.body));
assert.equal(
  (await resolvePromptFragments(db.db, dynamic)).get('xfield.identity')?.id,
  active('xfield.identity').id,
);
assert.throws(() =>
  validatePromptBody(dynamic.key, 'request', {
    ...dynamic.body,
    fragments: [{ key: 'xfield.identity', versionId: active('xfield.identity').id }],
  }),
);
const stage4 = active('daily.stage4.event_enrichment');
const variantBody: PromptBody = {
  systemInstructions: null,
  userTemplate: null,
  variants: {
    without_search: { systemInstructions: `{{fragment.${a.key}}}`, userTemplate: '{{input}}' },
    with_search: {
      systemInstructions: `{{fragment.${b.key}}}\n{{fragment.${a.key}}}`,
      userTemplate: '{{input}}',
    },
  },
  fragments: reordered.body.fragments,
};
assert.doesNotThrow(() => validatePromptBody(stage4.key, 'request', variantBody));
const synced = syncKeyReferences({
  ...variantBody,
  variants: {
    ...variantBody.variants,
    without_search: { systemInstructions: 'None', userTemplate: '{{input}}' },
  },
});
assert.equal(synced.fragments.length, 2, 'Other variant retains references');
const removed = syncKeyReferences({
  ...synced,
  variants: {
    ...synced.variants,
    with_search: { systemInstructions: 'None', userTemplate: '{{input}}' },
  },
});
assert.equal(removed.fragments.length, 0);
assert.throws(() =>
  validatePromptBody(original.key, 'request', {
    ...reordered.body,
    systemInstructions: `{{fragment.${a.key}}}\n{{fragment.${a.key}}}`,
  }),
);
assert.throws(() =>
  validatePromptBody(original.key, 'request', {
    ...reordered.body,
    systemInstructions: '{{fragment.unknown.key}}',
  }),
);
const manual = syncKeyReferences({
  ...dynamic.body,
  systemInstructions: '{{fragment.daily_brief.editorial}}',
});
assert.deepEqual(manual.fragments, [
  { key: 'daily_brief.editorial', activeKey: 'daily_brief.editorial' },
]);
const unresolved = syncKeyReferences({
  ...dynamic.body,
  systemInstructions: `{{fragment.${a.key}}}`,
});
assert.throws(
  () => validatePromptBody(original.key, 'request', unresolved),
  'Must explicitly select ordinary version',
);
console.log(
  'PASS direct Fragment Keys: legacy parity, literal ordering, version ownership, dynamic Active, all-variant reconciliation, missing/duplicate bindings, Published immutability',
);
// Direct Key syntax uses the unchanged persistent Run binding path.
const { randomUUID } = await import('node:crypto');
const { captureSystemFragments } = await import('../src/lib/prompts/system-fragments.js');
const { databasePromptBinder, withPromptBindings, productionPrompt } =
  await import('../src/lib/prompts/runtime.js');
const { promptContentHash } = await import('../src/lib/prompts/registry.js');
const fragment = active('xfield.identity');
fragment.body = { ...fragment.body, systemInstructions: 'IDENTITY BEFORE' };
fragment.contentHash = promptContentHash(fragment.body);
const request = { ...dynamic, id: randomUUID(), contentHash: promptContentHash(dynamic.body) };
db.versions.set(request.id, request);
db.active.set(request.key, request.id);
db.owners.set('discovery_runs:key-run', {
  systemFragmentVersions: await captureSystemFragments(db.db),
});
const execute = (id: string) =>
  withPromptBindings(db.db, databasePromptBinder(db.db, 'discovery', id), () =>
    productionPrompt('discovery.d3.topic_discovery', 'INPUT'),
  );
assert.equal((await execute('key-run')).instructions, 'IDENTITY BEFORE');
const later = {
  ...fragment,
  id: randomUUID(),
  version: fragment.version + 1,
  body: { ...fragment.body, systemInstructions: 'IDENTITY AFTER' },
};
later.contentHash = promptContentHash(later.body);
db.versions.set(later.id, later);
db.active.set(later.key, later.id);
assert.equal(
  (await execute('key-run')).instructions,
  'IDENTITY BEFORE',
  'Resume keeps exact snapshot',
);
db.owners.set('discovery_runs:open-run', {
  systemFragmentVersions: await captureSystemFragments(db.db),
});
assert.equal(
  (await execute('open-run')).instructions,
  'IDENTITY AFTER',
  'New Open Run freezes latest Active',
);
console.log('PASS direct Key Runtime binding: Resume fixed UUID and independent Open snapshot');
