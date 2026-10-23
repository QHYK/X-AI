import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import {
  buildProductionPromptSeeds,
  extractStage4DecisionInstructions,
} from '../src/lib/prompts/production-seeds.js';
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
  importPromptSeeds,
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
import {
  buildStage1Instructions,
  buildStage1UserPrompt,
} from '../src/prompts/stage1-content-understanding.js';
import {
  buildStage2Instructions,
  buildStage2UserPrompt,
} from '../src/prompts/stage2-event-merge.js';
import {
  buildStage3EventRankingInstructions,
  buildStage3EventRankingUserPrompt,
} from '../src/prompts/stage3-event-ranking.js';
import {
  buildStage3DigestRankingInstructions,
  buildStage3DigestRankingUserPrompt,
} from '../src/prompts/stage3-digest-ranking.js';
import {
  buildStage3LongFormRankingInstructions,
  buildStage3LongFormRankingUserPrompt,
} from '../src/prompts/stage3-long-form-ranking.js';
import {
  buildStage4EventEnrichmentInstructions,
  buildStage4EventEnrichmentUserPrompt,
} from '../src/prompts/stage4-event-enrichment.js';
import {
  buildDiscoveryD2Instructions,
  buildDiscoveryD2UserPrompt,
} from '../src/prompts/discovery-topic-selection.js';
import {
  buildDiscoveryD3Instructions,
  buildDiscoveryD3UserPrompt,
} from '../src/prompts/discovery-topic-agent.js';
import {
  buildDiscoveryD4Instructions,
  buildDiscoveryD4UserPrompt,
} from '../src/prompts/discovery-direct-verification.js';
import {
  buildDiscoveryD5Instructions,
  buildDiscoveryD5UserPrompt,
} from '../src/prompts/discovery-open-agent.js';
import { IN_DEPTH_INTRODUCTION_PROMPT } from '../src/prompts/in-depth-introduction.js';
import { buildManualInDepthInstructions } from '../src/prompts/manual-in-depth.js';
import { DIGEST_PUT_BACK_PROMPT } from '../src/prompts/digest-put-back.js';
import { buildReadMoreInstructions, buildReadMoreUserPrompt } from '../src/prompts/read-more.js';

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
  [...FRAGMENT_KEYS].sort(),
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
const source = await readFile(new URL('../src/processing/stage4-llm.ts', import.meta.url), 'utf8');
const expected: Record<string, string> = {
  'daily.stage1.content_understanding': buildStage1Instructions(),
  'daily.stage2.event_merge': buildStage2Instructions(),
  'daily.stage3.event_ranking': buildStage3EventRankingInstructions(),
  'daily.stage3.long_form_ranking': buildStage3LongFormRankingInstructions(),
  'daily.stage4.external_context_decision': extractStage4DecisionInstructions(source),
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
  renderResolvedPrompt(d3, new Map([[d3.body.fragments[0].versionId, base]]), { input: 'x' }),
);
assert.throws(() =>
  validatePromptBody(FRAGMENT_KEYS[0], 'fragment', { ...base.body, fragments: d3.body.fragments }),
);
assert.throws(() => withFragmentVersions(d3.body, { unknown: randomUUID() }));
assert.throws(() =>
  extractStage4DecisionInstructions(
    source.replaceAll('determineWhetherExternalContextIsNeeded', 'removedDecisionFunction'),
  ),
);

// Database seam Mock: exercise actual service queries, transaction rollback and immutable-version references.
class Store {
  registries = new Map<
    string,
    { id: string; key: RegistryKey; kind: string; activeVersionId: string | null }
  >();
  versions = new Map<string, PromptVersion>();
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
      if (sql.startsWith('insert into prompt_registry')) {
        if (!this.registries.has(String(values[0])))
          this.registries.set(String(values[0]), {
            id: randomUUID(),
            key: values[0] as RegistryKey,
            kind: String(values[1]),
            activeVersionId: null,
          });
        return { rows: [] };
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
        this.versions.set(version.id, version);
        return { rows: [{ id: version.id }] };
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
      if (sql.startsWith('update prompt_registry set active_version_id')) {
        if (this.failActive) throw new Error('Mock Active write failed');
        const r = [...this.registries.values()].find((r) => r.id === values[0])!;
        const v = this.versions.get(String(values[1]))!;
        assert.equal(v.registryId, r.id);
        assert.equal(v.status, 'published');
        r.activeVersionId = v.id;
        return { rows: [] };
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
const tampered = { ...base, contentHash: '0'.repeat(64) };
store.versions.set(base.id, tampered);
await assert.rejects(getPromptVersion(store.db, base.id), /hash mismatch/);
store.versions.set(base.id, base);

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
