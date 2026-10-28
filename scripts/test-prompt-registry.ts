import { captureSystemFragments } from '../src/lib/prompts/system-fragments.js';
import { ACTIVE_FRAGMENT_KEYS } from '../src/lib/prompts/contracts.js';
import { STAGE4_CONTEXT_DECISION_INSTRUCTIONS } from './fixtures/legacy-prompts.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { Pool, type PoolClient } from 'pg';
import { buildProductionPromptSeeds } from '../src/lib/prompts/production-seeds.js';
import {
  PROMPT_CONTRACTS,
  FRAGMENT_KEYS,
  renderResolvedPrompt,
  mapPromptRoles,
  validatePromptBody,
  type PromptVersion,
  type RegistryKey,
} from '../src/lib/prompts/contracts.js';
import {
  listPromptRegistries,
  getPromptManagementDetail,
  createPromptDraftFromVersion,
  updatePromptDraft,
  importPromptSeeds,
  installSystemPromptLayers,
  initialPromptVersion,
  getActivePrompt,
  getPromptVersion,
  createPromptDraft,
  publishPromptVersion,
  activatePromptVersion,
  renderPromptVersion,
  withFragmentVersions,
  promptContentHash,
} from '../src/lib/prompts/registry.js';
import { buildStage1UserPrompt } from '../src/prompts/stage1-content-understanding.js';
import { buildStage1Instructions } from './fixtures/legacy-prompts.js';
import { buildStage2UserPrompt } from '../src/prompts/stage2-event-merge.js';
import { buildStage2Instructions } from './fixtures/legacy-prompts.js';
import { buildStage3EventRankingUserPrompt } from '../src/prompts/stage3-event-ranking.js';
import { buildStage3EventRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage3DigestRankingUserPrompt } from '../src/prompts/stage3-digest-ranking.js';
import { buildStage3DigestRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage3LongFormRankingUserPrompt } from '../src/prompts/stage3-long-form-ranking.js';
import { buildStage3LongFormRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage4EventEnrichmentUserPrompt } from '../src/prompts/stage4-event-enrichment.js';
import { buildStage4EventEnrichmentInstructions } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD2UserPrompt } from '../src/prompts/discovery-topic-selection.js';
import { buildDiscoveryD2Instructions } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD3UserPrompt } from '../src/prompts/discovery-topic-agent.js';
import { buildDiscoveryD3Instructions } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD4UserPrompt } from '../src/prompts/discovery-direct-verification.js';
import { buildDiscoveryD4Instructions } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD5UserPrompt } from '../src/prompts/discovery-open-agent.js';
import { buildDiscoveryD5Instructions } from './fixtures/legacy-prompts.js';
import { IN_DEPTH_INTRODUCTION_PROMPT } from './fixtures/legacy-prompts.js';
import { buildManualInDepthInstructions } from './fixtures/legacy-prompts.js';
import { DIGEST_PUT_BACK_PROMPT } from './fixtures/legacy-prompts.js';
import { buildReadMoreInstructions, buildReadMoreUserPrompt } from './fixtures/legacy-prompts.js';

const seeds = await buildProductionPromptSeeds('a'.repeat(40));
assert.equal(seeds.length, 18);
assert.deepEqual(
  seeds
    .filter((s) => s.kind === 'request')
    .map((s) => s.key)
    .sort(),
  Object.keys(PROMPT_CONTRACTS).sort(),
);
assert.deepEqual(
  seeds
    .filter((s) => s.kind === 'fragment')
    .map((s) => s.key)
    .sort(),
  FRAGMENT_KEYS.filter((key) => key.startsWith('shared.')).sort(),
);
function asVersion(seed: (typeof seeds)[number]): PromptVersion {
  return {
    ...seed,
    id: seed.id,
    registryId: randomUUID(),
    version: initialPromptVersion(seed.source.legacyVersion),
    status: 'published',
    contentHash: promptContentHash(seed.body),
    sourceCommit: seed.source.sourceCommit ?? null,
    legacyVersion: seed.source.legacyVersion ?? null,
  };
}
const versions = new Map(seeds.map((s) => [s.key, asVersion(s)]));
const fragments = new Map(
  [...versions.values()].filter((v) => v.kind === 'fragment').map((v) => [v.id, v]),
);

const expected: Record<string, string> = {
  'daily.stage1.content_understanding': buildStage1Instructions(),
  'daily.stage2.event_merge': buildStage2Instructions(),
  'daily.stage3.event_ranking': buildStage3EventRankingInstructions(),
  'daily.stage3.long_form_ranking': buildStage3LongFormRankingInstructions(),
  'daily.stage4.external_context_decision': STAGE4_CONTEXT_DECISION_INSTRUCTIONS,
  'discovery.d2.topic_selection': buildDiscoveryD2Instructions(),
  'discovery.d3.topic_discovery': buildDiscoveryD3Instructions(),
  'discovery.d4.direct_verification': buildDiscoveryD4Instructions(),
  'discovery.d5.open_discovery': buildDiscoveryD5Instructions(),
  'in_depth.editorial.introduction': IN_DEPTH_INTRODUCTION_PROMPT,
  'in_depth.manual.generate': buildManualInDepthInstructions(),
  'daily.editorial.digest_put_back': DIGEST_PUT_BACK_PROMPT,
  'daily.read_more.detailed_summary': buildReadMoreInstructions(),
};
// Use real User builders; their JSON mapping/serialization remains in code, including Unicode/newlines.
const dynamic = '正文\n{{untrusted.expression}} 科学 "quoted"';
const inputByKey: Record<string, string> = {
  'daily.stage1.content_understanding': buildStage1UserPrompt({ articles: [] }),
  'daily.stage2.event_merge': buildStage2UserPrompt({ event_candidates: [] }),
  'daily.stage3.event_ranking': buildStage3EventRankingUserPrompt({ events: [] }),
  'daily.stage3.long_form_ranking': buildStage3LongFormRankingUserPrompt({ candidates: [] }),
  'discovery.d2.topic_selection': buildDiscoveryD2UserPrompt({
    days: [{ events: [], digests: [], longForm: [] }],
  } as unknown as Parameters<typeof buildDiscoveryD2UserPrompt>[0]),
  'discovery.d3.topic_discovery': buildDiscoveryD3UserPrompt([], { note: dynamic }),
  'discovery.d4.direct_verification': buildDiscoveryD4UserPrompt([]),
  'discovery.d5.open_discovery': buildDiscoveryD5UserPrompt(
    { note: dynamic },
    ' editorial context ',
  ),
};
for (const [key, instructions] of Object.entries(expected)) {
  const input =
    inputByKey[key] ??
    JSON.stringify({ content: dynamic, originalUrl: 'https://example.test/original' });
  const rendered = renderResolvedPrompt(versions.get(key as RegistryKey)!, fragments, { input });
  assert.equal(rendered.instructions, instructions, key);
  assert.equal(
    rendered.user,
    key === 'daily.read_more.detailed_summary' ? buildReadMoreUserPrompt(input) : input,
  );
}
for (const category of [
  'Finance & Economy',
  'Technology',
  'Science',
  'Policy',
  'Company',
  'General',
]) {
  const input = buildStage3DigestRankingUserPrompt({
    category,
    candidates: [{ id: 'D1', title: dynamic, summary: 'Summary', source: 'Journal' }],
  });
  assert.deepEqual(
    renderResolvedPrompt(versions.get('daily.stage3.digest_ranking')!, fragments, {
      input,
      category,
    }),
    {
      instructions: buildStage3DigestRankingInstructions(category),
      user: input,
    },
  );
}
for (const search of [false, true]) {
  const input = buildStage4EventEnrichmentUserPrompt({ event_hint: dynamic, sources: [] });
  assert.deepEqual(
    renderResolvedPrompt(
      versions.get('daily.stage4.event_enrichment')!,
      fragments,
      { input },
      search ? 'with_search' : 'without_search',
    ),
    {
      instructions: buildStage4EventEnrichmentInstructions({ webSearchAvailable: search }),
      user: input,
    },
  );
}
assert.throws(() =>
  renderResolvedPrompt(versions.get('daily.stage3.digest_ranking')!, fragments, {
    input: 'x',
    category: '"malicious category',
  }),
);
const base = versions.get('daily.stage1.content_understanding')!;
for (const empty of [null, '', '  ']) {
  const body = { ...base.body, systemInstructions: empty, userTemplate: empty };
  const rendered = renderResolvedPrompt({ ...base, body }, fragments, { input: dynamic });
  assert.deepEqual(rendered, { user: dynamic });
  assert.deepEqual(mapPromptRoles(rendered, { api: 'chat_completions', provider: 'deepseek' }), {
    messages: [{ role: 'user', content: dynamic }],
  });
  assert.deepEqual(mapPromptRoles(rendered, { api: 'responses', provider: 'openai' }), {
    input: dynamic,
  });
  assert.deepEqual(mapPromptRoles(rendered, { api: 'agent', provider: 'codex' }), {
    input: dynamic,
  });
}
assert.deepEqual(
  mapPromptRoles({ instructions: '', user: '' }, { api: 'responses', provider: 'codex' }),
  {},
);
assert.deepEqual(
  renderResolvedPrompt({ ...base, body: { ...base.body, userTemplate: 'New User' } }, fragments, {
    input: dynamic,
  }),
  {
    instructions: base.body.systemInstructions,
    user: `New User\n\n${dynamic}`,
  },
);
assert.throws(() => mapPromptRoles({ user: 'x' }, { api: 'agent', provider: 'kimi' }));
assert.throws(() => mapPromptRoles({ user: 'x' }, { api: 'responses', provider: 'deepseek' }));
for (const text of ['{{unknown}}', '{{input.toUpperCase()}}', '{{ input + 1 }}', '{{input}}']) {
  assert.throws(() =>
    validatePromptBody(base.key, 'request', { ...base.body, systemInstructions: text }),
  );
}
assert.throws(() => renderResolvedPrompt(base, fragments, { input: '' }));
assert.throws(() => renderResolvedPrompt(base, fragments, { input: 'x', unknown: 'x' } as never));
assert.throws(() =>
  renderResolvedPrompt(versions.get('daily.stage3.digest_ranking')!, fragments, { input: 'x' }),
);
assert.throws(() =>
  renderResolvedPrompt(
    versions.get('daily.stage4.event_enrichment')!,
    fragments,
    { input: 'x' },
    'unknown',
  ),
);
const d3 = versions.get('discovery.d3.topic_discovery')!;
assert.throws(() => renderResolvedPrompt(d3, new Map(), { input: 'x' }));
assert.throws(() =>
  renderResolvedPrompt(d3, new Map([[d3.body.fragments[0].versionId!, base]]), { input: 'x' }),
);
assert.throws(() =>
  validatePromptBody(FRAGMENT_KEYS[0], 'fragment', { ...base.body, fragments: d3.body.fragments }),
);
assert.throws(() => withFragmentVersions(d3.body, { unknown: randomUUID() }));
// Database seam Mock: exercise actual service queries, transaction rollback and immutable-version references.
class Store {
  registries = new Map<
    string,
    {
      id: string;
      key: RegistryKey;
      kind: string;
      activeVersionId: string | null;
      workflow: string;
      step: string;
      requestType: string;
      displayName: string;
      updatedAt: string;
    }
  >();
  versions = new Map<string, PromptVersion & { createdAt?: string; changeNote?: string | null }>();
  failActive = false;
  statements: string[] = [];
  connect = async () => {
    let snapshot: { registries: Store['registries']; versions: Store['versions'] } | undefined;
    const query = async (sql: string, values: unknown[] = []) => {
      this.statements.push(sql);
      if (sql === 'begin') {
        snapshot = structuredClone({ registries: this.registries, versions: this.versions });
        return { rows: [] };
      }
      if (sql === 'commit') return { rows: [] };
      if (sql === 'rollback') {
        Object.assign(this, snapshot);
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('select r.key, v.id from prompt_registry r'))
        return {
          rows: ACTIVE_FRAGMENT_KEYS.flatMap((key) => {
            const r = this.registries.get(key);
            return r?.activeVersionId ? [{ key, id: r.activeVersionId }] : [];
          }),
        };
      if (sql.startsWith('insert into prompt_registry')) {
        if (!this.registries.has(String(values[0])))
          this.registries.set(String(values[0]), {
            id: randomUUID(),
            key: values[0] as RegistryKey,
            kind: String(values[1]),
            activeVersionId: null,
            workflow: String(values[2]),
            step: String(values[3]),
            requestType: String(values[4]),
            displayName: String(values[5]),
            updatedAt: new Date().toISOString(),
          });
        return { rows: [] };
      }
      if (sql.includes('from prompt_registry r left join')) {
        const rows = [...this.registries.values()].filter((r) =>
          sql.includes('where r.key=$1')
            ? r.key === values[0]
            : r.key.toLowerCase().includes(String(values[0]).toLowerCase()) &&
              (!values[1] || r.kind === values[1]),
        );
        return {
          rows: rows.map((r) => ({
            ...r,
            activeVersion: r.activeVersionId ? this.versions.get(r.activeVersionId)!.version : null,
          })),
        };
      }
      if (sql.includes('from prompt_registry where key')) {
        const r = this.registries.get(String(values[0]));
        return { rows: r ? [r] : [] };
      }
      if (sql.startsWith('select id from prompt_versions'))
        return {
          rows: [...this.versions.values()].filter((v) => v.registryId === values[0]).slice(0, 1),
        };
      if (sql.startsWith('insert into prompt_versions')) {
        const registry = [...this.registries.values()].find((r) => r.id === values[0])!;
        const version: PromptVersion = {
          id: String(values[6]),
          registryId: registry.id,
          key: registry.key,
          kind: registry.kind as PromptVersion['kind'],
          status: 'draft',
          version:
            Math.max(
              Number(values[7]) - 1,
              ...[...this.versions.values()]
                .filter((v) => v.registryId === registry.id)
                .map((v) => v.version),
            ) + 1,
          body: JSON.parse(String(values[1])),
          contentHash: String(values[2]),
          sourceCommit: values[3] as string | null,
          legacyVersion: values[4] as string | null,
        };
        this.versions.set(version.id, {
          ...version,
          createdAt: new Date().toISOString(),
          changeNote: values[5] as string | null,
        });
        return { rows: [{ id: version.id }] };
      }
      if (sql.includes('from prompt_versions v join') && sql.startsWith('select v.created_at')) {
        return {
          rows: [...this.versions.values()]
            .filter((v) =>
              sql.includes("where r.kind='fragment'")
                ? v.kind === 'fragment' && v.status === 'published'
                : v.key === values[0],
            )
            .sort((a, b) => b.version - a.version)
            .map((v) => ({
              ...structuredClone(v),
              createdAt: v.createdAt ?? new Date().toISOString(),
              changeNote: v.changeNote ?? null,
            })),
        };
      }
      if (sql.startsWith('update prompt_versions set body')) {
        const v = this.versions.get(String(values[0]))!;
        if (v.registryId !== values[1] || v.status !== 'draft' || v.contentHash !== values[4])
          return { rows: [], rowCount: 0 };
        this.versions.set(v.id, {
          ...v,
          body: JSON.parse(String(values[2])),
          contentHash: String(values[3]),
        });
        return { rows: [{ id: v.id }], rowCount: 1 };
      }
      if (sql.includes('from prompt_versions v join')) {
        const v = this.versions.get(String(values[0]));
        return { rows: v ? [structuredClone(v)] : [] };
      }
      if (sql.startsWith('update prompt_versions set status')) {
        const v = this.versions.get(String(values[0]))!;
        assert.equal(v.status, 'draft');
        this.versions.set(v.id, { ...v, status: 'published' });
        return { rows: [] };
      }
      if (sql.startsWith('update prompt_registry set updated_at')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('update prompt_registry set active_version_id')) {
        if (this.failActive) throw new Error('Mock Active write failed');
        const r = [...this.registries.values()].find((r) => r.id === values[0])!;
        const v = this.versions.get(String(values[1]))!;
        assert.equal(v.registryId, r.id);
        assert.equal(v.status, 'published');
        r.activeVersionId = v.id;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unhandled Mock SQL: ${sql}`);
    };
    return { query, release() {} } as unknown as PoolClient;
  };
  query = async (sql: string, values: unknown[] = []) => (await this.connect()).query(sql, values);
  db = this as unknown as Pool;
}
assert.equal(initialPromptVersion(), 1);
assert.equal(initialPromptVersion('v5'), 5);
for (const invalid of ['v0', 'v01', 'v2.1', '', '5', 'v2147483648'])
  assert.throws(() => initialPromptVersion(invalid));
const store = new Store();
assert.equal((await importPromptSeeds(store.db, seeds)).imported.length, 18);
assert.equal((await importPromptSeeds(store.db, seeds)).skipped.length, 18);
assert.equal(store.versions.size, 18);
for (const seed of seeds) {
  const imported = await getActivePrompt(store.db, seed.key);
  assert.equal(imported.id, seed.id);
  assert.equal(imported.version, initialPromptVersion(seed.source.legacyVersion));
}
assert.equal((await getActivePrompt(store.db, 'daily.stage1.content_understanding')).version, 5);
assert.equal((await getActivePrompt(store.db, 'daily.stage2.event_merge')).version, 4);
assert.equal((await getActivePrompt(store.db, 'daily.stage4.event_enrichment')).version, 7);
assert.equal(
  (await getActivePrompt(store.db, 'daily.stage4.external_context_decision')).version,
  1,
);
// Existing Published versions, including baselines imported as v1 before this change, stay immutable.
const priorImport = new Store();
await importPromptSeeds(priorImport.db, seeds);
for (const [id, version] of priorImport.versions)
  priorImport.versions.set(id, { ...version, version: 1 });
assert.equal((await importPromptSeeds(priorImport.db, seeds)).skipped.length, 18);
assert.ok([...priorImport.versions.values()].every((version) => version.version === 1));

const newBody = {
  ...base.body,
  systemInstructions: 'Administrator new System',
  userTemplate: null,
};
const draft = await createPromptDraft(store.db, base.key, newBody);
assert.equal(draft.version, base.version + 1);
assert.equal((await getActivePrompt(store.db, base.key)).id, base.id);
await assert.rejects(activatePromptVersion(store.db, base.key, draft.id));
await publishPromptVersion(store.db, base.key, draft.id);
store.failActive = true;
await assert.rejects(activatePromptVersion(store.db, base.key, draft.id));
assert.equal((await getActivePrompt(store.db, base.key)).id, base.id);
store.failActive = false;
await activatePromptVersion(store.db, base.key, draft.id);
await importPromptSeeds(store.db, seeds);
assert.equal(
  (await getActivePrompt(store.db, base.key)).id,
  draft.id,
  'Import preserves administrator Active',
);
await assert.rejects(activatePromptVersion(store.db, base.key, d3.id));
await activatePromptVersion(store.db, base.key, base.id);
const fragmentKey = FRAGMENT_KEYS[0];
const fragmentV2 = await createPromptDraft(store.db, fragmentKey, {
  ...versions.get(fragmentKey)!.body,
  systemInstructions: 'Updated criteria',
});
await publishPromptVersion(store.db, fragmentKey, fragmentV2.id);
await activatePromptVersion(store.db, fragmentKey, fragmentV2.id);
assert.equal(
  (await renderPromptVersion(store.db, d3.id, { input: dynamic })).instructions,
  buildDiscoveryD3Instructions(),
  'Original Request keeps original fragment',
);
const upgraded = await createPromptDraft(
  store.db,
  d3.key,
  withFragmentVersions(d3.body, { editorial: fragmentV2.id }),
);
await publishPromptVersion(store.db, d3.key, upgraded.id);
assert.match(
  (await renderPromptVersion(store.db, upgraded.id, { input: dynamic })).instructions!,
  /^Updated criteria/,
);
const broken = new Store();
broken.failActive = true;
await assert.rejects(importPromptSeeds(broken.db, seeds));
assert.equal(broken.registries.size, 0);
assert.equal(broken.versions.size, 0);
assert.ok(store.statements.some((sql) => sql.includes('for update')));
assert.ok(store.statements.includes('rollback'));
const unchanged = await readFile(
  new URL('../src/processing/stage1-llm.ts', import.meta.url),
  'utf8',
);
assert.match(unchanged, /productionPrompt/);
assert.equal((await getPromptVersion(store.db, base.id)).contentHash, promptContentHash(base.body));

// All production callers use the database Prompt service.
for (const path of [
  'processing/stage1-llm.ts',
  'processing/stage2-llm.ts',
  'processing/stage3-event-ranking-llm.ts',
  'processing/stage3-digest-ranking-llm.ts',
  'processing/stage3-long-form-ranking-llm.ts',
  'processing/stage4-llm.ts',
  'discovery/topic-selection.ts',
  'discovery/topic-discovery.ts',
  'discovery/direct-verification.ts',
  'discovery/open-discovery.ts',
  'lib/in-depth-introduction.ts',
  'lib/manual-in-depth.ts',
  'lib/digest-put-back.ts',
  'lib/read-more.ts',
]) {
  const text = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
  assert.match(text, /productionPrompt/);
}
await assert.rejects(
  createPromptDraft(store.db, d3.key, {
    ...d3.body,
    fragments: [{ slot: 'editorial', versionId: base.id }, d3.body.fragments[1]],
  }),
);
const originalStored = store.versions.get(base.id)!;
const tampered = { ...originalStored, contentHash: '0'.repeat(64) };
store.versions.set(base.id, tampered);
await assert.rejects(getPromptVersion(store.db, base.id), /hash mismatch/);
store.versions.set(base.id, originalStored);

// Management lifecycle: listing, optimistic concurrency, immutable history and independent activation.
assert.equal((await listPromptRegistries(store.db)).length, 18);
assert.equal((await listPromptRegistries(store.db, '', 'fragment')).length, 3);
assert.equal((await listPromptRegistries(store.db, 'DAILY.STAGE1')).length, 1);
const detail = await getPromptManagementDetail(store.db, base.key);
assert.equal(detail.registry.activeVersionId, base.id);
assert.ok(detail.versions.length >= 2);
assert.ok(detail.versions.every((v) => v.createdAt));
const cloned = await createPromptDraftFromVersion(store.db, base.key, base.id, base.contentHash);
assert.deepEqual(cloned.body, base.body);
let saved = await updatePromptDraft(store.db, base.key, cloned.id, cloned.contentHash, newBody);
await assert.rejects(
  updatePromptDraft(store.db, base.key, cloned.id, cloned.contentHash, base.body),
  { status: 409 },
);
assert.deepEqual((await getPromptVersion(store.db, cloned.id)).body, newBody);
saved = await updatePromptDraft(store.db, base.key, cloned.id, saved.contentHash, {
  ...newBody,
  userTemplate: 'Edited User',
});
await assert.rejects(
  updatePromptDraft(store.db, base.key, cloned.id, saved.contentHash, {
    ...newBody,
    userTemplate: '{{bad}}',
  }),
);
await assert.rejects(updatePromptDraft(store.db, base.key, base.id, base.contentHash, newBody), {
  status: 409,
});
await assert.rejects(createPromptDraftFromVersion(store.db, base.key, d3.id, d3.contentHash), {
  status: 400,
});
await assert.rejects(publishPromptVersion(store.db, base.key, saved.id, cloned.contentHash), {
  status: 409,
});
await publishPromptVersion(store.db, base.key, saved.id, saved.contentHash);
assert.equal((await getActivePrompt(store.db, base.key)).id, base.id, 'Publish does not Activate');
await activatePromptVersion(store.db, base.key, saved.id, base.id);
await assert.rejects(activatePromptVersion(store.db, base.key, base.id, base.id), { status: 409 });
await activatePromptVersion(store.db, base.key, base.id, saved.id);
assert.equal(
  (await getActivePrompt(store.db, base.key)).id,
  base.id,
  'Rollback selects immutable history',
);
const stage4 = await getActivePrompt(store.db, 'daily.stage4.event_enrichment');
const variantDraft = await createPromptDraftFromVersion(
  store.db,
  stage4.key,
  stage4.id,
  stage4.contentHash,
);
const variantBody = structuredClone(variantDraft.body);
variantBody.variants.with_search.systemInstructions = 'Changed search instructions';
const variantSaved = await updatePromptDraft(
  store.db,
  stage4.key,
  variantDraft.id,
  variantDraft.contentHash,
  variantBody,
);
assert.deepEqual(variantSaved.body.variants.without_search, stage4.body.variants.without_search);
variantBody.variants.without_search.userTemplate = '{{invalid}}';
await assert.rejects(
  updatePromptDraft(store.db, stage4.key, variantDraft.id, variantSaved.contentHash, variantBody),
);
await assert.rejects(
  updatePromptDraft(store.db, d3.key, upgraded.id, upgraded.contentHash, {
    ...d3.body,
    fragments: [{ slot: 'editorial', versionId: base.id }, d3.body.fragments[1]],
  }),
);
console.log(
  'PASS management: 18 registries, history, Draft CAS, Publish/Activate/rollback, pinned fragments, Stage4 variants',
);

// Architectural regression: production dependency graphs cannot reach Seed or legacy Fixture text.
const inspected = new Set<string>();
async function checkRuntimeDependencies(path: string): Promise<void> {
  const file = resolve(path);
  if (inspected.has(file)) return;
  inspected.add(file);
  assert.doesNotMatch(
    file,
    /(?:production-seeds\.ts|seed-baseline\.json|scripts\/fixtures\/legacy-)/,
    'Runtime must not depend on static Prompt text',
  );
  const source = await readFile(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly) continue;
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const name = specifier.text;
    if (!name.startsWith('.') && !name.startsWith('@/')) continue;
    const dependency = name.startsWith('@/')
      ? resolve('src', name.slice(2))
      : resolve(dirname(file), name);
    if (/\.js$/.test(dependency))
      await checkRuntimeDependencies(dependency.replace(/\.js$/, '.ts'));
  }
  if (file.includes('/src/prompts/')) {
    for (const statement of ast.statements) {
      if (ts.isFunctionDeclaration(statement))
        assert.match(
          statement.name?.text ?? '',
          /UserPrompt$/,
          'Only dynamic business input builders remain',
        );
    }
  }
}
for (const path of [
  'src/lib/model-evaluation.ts',
  'src/lib/read-more.ts',
  'src/lib/in-depth-introduction.ts',
  'src/lib/manual-in-depth.ts',
  'src/lib/digest-put-back.ts',
  'src/discovery/topic-selection.ts',
  'src/discovery/topic-discovery.ts',
  'src/discovery/direct-verification.ts',
  'src/discovery/open-discovery.ts',
  'scripts/process-stage1.ts',
  'scripts/process-stage2.ts',
  'scripts/process-stage3.ts',
  'scripts/process-stage4.ts',
  'scripts/test-stage1-chat-structured.ts',
])
  await checkRuntimeDependencies(path);
console.log(
  'PASS production Prompt dependency boundary: no Seed/Fixture/static instruction builders',
);

// Install from actual Active content, preserving existing published data and human edits.
const layers = new Store();
await importPromptSeeds(layers.db, seeds);
const active = await getActivePrompt(layers.db, 'daily.stage1.content_understanding');
const edited = await createPromptDraft(layers.db, active.key, {
  ...active.body,
  systemInstructions: 'Human edited instructions\n' + active.body.systemInstructions,
});
await publishPromptVersion(layers.db, active.key, edited.id);
await activatePromptVersion(layers.db, active.key, edited.id);
const originalVersions = structuredClone(layers.versions);
assert.equal((await installSystemPromptLayers(layers.db, undefined, true)).length, 16);
assert.deepEqual(layers.versions, originalVersions, 'dry run rolls back every change');
const changes = await installSystemPromptLayers(layers.db);
assert.equal(changes.length, 16);
assert.equal(layers.registries.size, 21);
for (const key of ACTIVE_FRAGMENT_KEYS) {
  const fragment = await getActivePrompt(layers.db, key);
  assert.equal(fragment.version, 1);
  assert.equal(fragment.body.systemInstructions, '');
}
for (const [id, v] of originalVersions)
  assert.deepEqual(layers.versions.get(id), v, 'Published history is unchanged');
const layered = await getActivePrompt(layers.db, active.key);
assert.ok(layered.body.systemInstructions?.endsWith(edited.body.systemInstructions!));
assert.equal(layered.version, edited.version + 1);
assert.deepEqual(layered.body.userTemplate, edited.body.userTemplate);
assert.equal(layered.body.fragments.filter((f) => f.activeKey).length, 2);
assert.deepEqual(await installSystemPromptLayers(layers.db), [], 'initialization is idempotent');
const identity = await getActivePrompt(layers.db, 'xfield.identity');
const nextIdentity = await createPromptDraft(layers.db, identity.key, {
  ...identity.body,
  systemInstructions: 'X-field Identity',
});
assert.equal(nextIdentity.version, 2);
await publishPromptVersion(layers.db, identity.key, nextIdentity.id);
await activatePromptVersion(layers.db, identity.key, nextIdentity.id);
const rendered = await renderPromptVersion(layers.db, layered.id, { input: 'unchanged input' });
assert.ok(rendered.instructions?.startsWith('X-field Identity\n\n'));
assert.ok(rendered.instructions?.endsWith(edited.body.systemInstructions!));
assert.equal(
  (await getActivePrompt(layers.db, active.key)).id,
  layered.id,
  'Fragment activation does not republish Request',
);
assert.equal((await captureSystemFragments(layers.db))['xfield.identity'], nextIdentity.id);
assert.deepEqual(await installSystemPromptLayers(layers.db), []);
assert.equal(
  (await getActivePrompt(layers.db, identity.key)).id,
  nextIdentity.id,
  'Rerun preserves human Fragment activation',
);
console.log(
  'System layer installer: empty v1, first edit v2, 13 Active-derived Requests, dry-run rollback, idempotency and immutable human-edited history passed.',
);

// Optional real PostgreSQL gate: isolated schema, all DDL/data rolled back; never loads .env / production URL.
const migration = await readFile(
  new URL('../drizzle/0021_prompt_registry.sql', import.meta.url),
  'utf8',
);
for (const required of [
  'FOREIGN KEY (active_version_id, id)',
  "OLD.status = 'published'",
  'BEFORE INSERT OR UPDATE OR DELETE',
  'Reference must resolve to a published fragment',
])
  assert.ok(migration.includes(required));
if (process.env.PROMPT_REGISTRY_TEST_DATABASE_URL) {
  const pool = new Pool({ connectionString: process.env.PROMPT_REGISTRY_TEST_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const schema = `prompt_test_${randomUUID().replaceAll('-', '')}`;
    await client.query(`create schema ${schema}`);
    await client.query(`set local search_path to ${schema}, public`);
    await client.query(migration);
    await client.query(
      await readFile(
        new URL('../drizzle/0024_active_system_fragments.sql', import.meta.url),
        'utf8',
      ),
    );
    await client.query(
      await readFile(
        new URL('../drizzle/0025_fragment_key_references.sql', import.meta.url),
        'utf8',
      ),
    );
    const db = {
      connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          if (sql === 'begin') return client.query('savepoint operation');
          if (sql === 'commit') return client.query('release savepoint operation');
          if (sql === 'rollback') return client.query('rollback to savepoint operation');
          return client.query(sql, values);
        },
        release() {},
      }),
    } as unknown as Pool;
    await importPromptSeeds(db, seeds);
    assert.equal((await importPromptSeeds(db, seeds)).skipped.length, 18);
    async function rejected(sql: string, args: unknown[]) {
      await client.query('savepoint invalid_write');
      await assert.rejects(client.query(sql, args));
      await client.query('rollback to savepoint invalid_write');
    }
    await rejected("update prompt_versions set body = '{}'::jsonb where id = $1", [base.id]);
    await rejected('delete from prompt_versions where id = $1', [base.id]);
    await rejected('update prompt_registry set active_version_id = $1 where key = $2', [
      d3.id,
      base.key,
    ]);
    const realDraft = await createPromptDraft(db, base.key, newBody);
    await rejected('update prompt_registry set active_version_id = $1 where key = $2', [
      realDraft.id,
      base.key,
    ]);
    await publishPromptVersion(db, base.key, realDraft.id);
    await activatePromptVersion(db, base.key, realDraft.id);
    assert.equal((await getActivePrompt(client, base.key)).id, realDraft.id);
    await activatePromptVersion(db, base.key, base.id);
    await rejected(
      "update prompt_versions set body = jsonb_set(body, '{fragments}', $2::jsonb) where id = $1",
      [realDraft.id, JSON.stringify([{ slot: 'bad', versionId: base.id }])],
    );
    const badBody = {
      ...d3.body,
      fragments: [{ slot: 'editorial', versionId: base.id }, d3.body.fragments[1]],
    };
    await assert.rejects(createPromptDraft(db, d3.key, badBody));
    // Exercise the actual new Trigger, not only application validation.
    const keyDraft = await createPromptDraft(db, d3.key, {
      ...d3.body,
      systemInstructions: '{{fragment.shared.discovery.editorial_criteria}}',
      fragments: [
        { key: 'shared.discovery.editorial_criteria', versionId: d3.body.fragments[0].versionId },
      ],
    });
    await rejected(
      "update prompt_versions set body=jsonb_set(body,'{fragments}',$2::jsonb) where id=$1",
      [
        keyDraft.id,
        JSON.stringify([
          { key: 'shared.discovery.tags', versionId: d3.body.fragments[0].versionId },
        ]),
      ],
    );
    console.log(
      'Real PostgreSQL immutable versions, same-registry Active FK, Draft rejection, fragments, import and activation passed.',
    );
  } finally {
    await client.query('rollback');
    client.release();
    await pool.end();
  }
} else
  console.log(
    'Real PostgreSQL constraint gate skipped: PROMPT_REGISTRY_TEST_DATABASE_URL not supplied.',
  );
console.log(
  '15 requests + 3 fragments, byte equality, categories/variants, templates/roles, exact references, idempotent import and transactional service Mock tests passed.',
);
