import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import {
  productionPrompt,
  withPromptBindings,
  databasePromptBinder,
  claimManualPrompt,
  finishManualPrompt,
  evaluationPromptBinder,
} from '../src/lib/prompts/runtime.js';
import {
  filePromptBinder,
  writeRunFile,
  inheritRunPrompt,
  observeRunPrompts,
  readBindings,
} from '../src/lib/prompts/run-file.js';
import { promptContentHash } from '../src/lib/prompts/registry.js';
import { mapPromptRoles, PROMPT_CONTRACTS, type PromptKey } from '../src/lib/prompts/contracts.js';

const store = new PromptMemory();
const root = await mkdtemp(join(tmpdir(), 'prompt-runtime-'));
const path = join(root, 'run.json');
const input = JSON.stringify({
  content: '原文\n{{not_a_template}}',
  url: 'https://example.test/a',
});
try {
  for (const key of Object.keys(PROMPT_CONTRACTS) as PromptKey[]) {
    const isDigest = key === 'daily.stage3.digest_ranking';
    const variants =
      key === 'daily.stage4.event_enrichment' ? ['without_search', 'with_search'] : [undefined];
    for (const variant of variants) {
      const rendered = await withPromptBindings(
        store.db,
        databasePromptBinder(store.db, 'discovery', 'all-types'),
        () =>
          productionPrompt(key, input, {
            ...(isDigest ? { category: 'Science' } : {}),
            ...(variant ? { variant } : {}),
          }),
      );
      assert.equal(rendered.versionId, store.active.get(key));
      assert.ok(rendered.input.includes(input));
      const wire = mapPromptRoles(rendered, { api: 'chat_completions', provider: 'openai' });
      assert.equal(wire.messages?.at(-1)?.content, rendered.input);
    }
  }
  const key: PromptKey = 'daily.stage3.digest_ranking';
  let calls = 0;
  await withPromptBindings(store.db, filePromptBinder(path, store.db), async () => {
    const first = await productionPrompt(key, input, { category: 'Science' });
    const old = store.versions.get(first.versionId)!;
    const version = {
      ...old,
      id: randomUUID(),
      version: old.version + 1,
      body: { ...old.body, systemInstructions: 'new active {{category}}' },
    };
    version.contentHash = promptContentHash(version.body);
    store.versions.set(version.id, version);
    store.active.set(key, version.id);
    const simultaneous = await Promise.all(
      Array.from({ length: 8 }, () => productionPrompt(key, input, { category: 'Technology' })),
    );
    simultaneous.forEach((p) => assert.equal(p.versionId, first.versionId));
    calls = store.activeReads;
    await productionPrompt(key, input, { category: 'Policy' });
    assert.equal(store.activeReads, calls);
  });
  await writeRunFile(path, { status: 'failed' });
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.ok(persisted.promptVersionIds[key]);
  assert.equal(persisted.promptVersions[key], 'v3');
  await writeRunFile(path, { status: 'failed', prompt_version: persisted.promptVersionIds[key] });
  const singular = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(singular.prompt_version, 'v3');
  assert.equal(singular.prompt_version_id, persisted.promptVersionIds[key]);
  assert.equal(singular.promptVersions[key], 'v3');
  assert.throws(() => readBindings({ promptVersions: { [key]: 'v3' } }), /UUID/);
  const legacyPath = join(root, 'legacy.json');
  await writeFile(
    legacyPath,
    JSON.stringify({ promptVersions: { [key]: persisted.promptVersionIds[key] } }),
  );
  const inheritedLegacy = join(root, 'inherited-legacy.json');
  await inheritRunPrompt(inheritedLegacy, legacyPath, key, store.db);
  const inherited = JSON.parse(await readFile(inheritedLegacy, 'utf8'));
  assert.equal(inherited.promptVersions[key], 'v3');
  assert.equal(inherited.promptVersionIds[key], persisted.promptVersionIds[key]);
  const legacyResumed = await withPromptBindings(
    store.db,
    filePromptBinder(legacyPath, store.db),
    () => productionPrompt(key, input, { category: 'Science' }),
  );
  assert.equal(legacyResumed.versionId, persisted.promptVersionIds[key]);
  const upgradedFile = JSON.parse(await readFile(legacyPath, 'utf8'));
  assert.equal(upgradedFile.promptVersions[key], 'v3');
  assert.equal(upgradedFile.promptVersionIds[key], persisted.promptVersionIds[key]);

  const retryPath = join(root, 'retry', 'run.json');
  await inheritRunPrompt(retryPath, path, key);
  const resumed = await withPromptBindings(store.db, filePromptBinder(retryPath, store.db), () =>
    productionPrompt(key, input, { category: 'Science' }),
  );
  assert.equal(resumed.versionId, persisted.promptVersionIds[key]);
  const beforeWriteFailure = store.activeReads;
  store.failWrite = true;
  await assert.rejects(
    withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'failed'), () =>
      productionPrompt(key, input, { category: 'Science' }),
    ),
  );
  store.failWrite = false;
  assert.equal(store.activeReads, beforeWriteFailure + 1);
  const decision: PromptKey = 'daily.stage4.external_context_decision';
  const enrich: PromptKey = 'daily.stage4.event_enrichment';
  await withPromptBindings(
    store.db,
    databasePromptBinder(store.db, 'stage4', 'run-a'),
    async () => {
      await productionPrompt(decision, input);
      assert.equal(
        (store.owners.get('stage4_runs:run-a') as Record<string, string>)[enrich],
        undefined,
      );
    },
  );
  await withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'run-a'), () =>
    productionPrompt(enrich, input, { variant: 'with_search' }),
  );
  const existing = store.owners.get('stage4_runs:run-a')!;
  const old = store.versions.get(String(existing[decision]))!;
  const changed = {
    ...old,
    id: randomUUID(),
    body: { ...old.body, systemInstructions: null, userTemplate: null },
  };
  changed.contentHash = promptContentHash(changed.body);
  store.versions.set(changed.id, changed);
  store.active.set(decision, changed.id);
  const retry = await withPromptBindings(
    store.db,
    databasePromptBinder(store.db, 'stage4', 'run-a'),
    () => productionPrompt(decision, input),
  );
  assert.equal(retry.versionId, existing[decision]);
  const fresh = await withPromptBindings(
    store.db,
    databasePromptBinder(store.db, 'stage4', 'run-b'),
    () => productionPrompt(decision, input),
  );
  assert.equal(fresh.versionId, changed.id);
  assert.equal(fresh.instructions, undefined);
  assert.equal(fresh.input, input);
  // A missing/mismatched/damaged version is never replaced by Active or a static builder.
  const owner = 'stage4_runs:bad';
  for (const bad of [randomUUID(), store.active.get(enrich)!]) {
    store.owners.set(owner, { [decision]: bad });
    await assert.rejects(
      withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'bad'), () =>
        productionPrompt(decision, input),
      ),
    );
  }
  store.active.delete(decision);
  await assert.rejects(
    withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'missing-active'), () =>
      productionPrompt(decision, input),
    ),
  );
  store.active.set(decision, changed.id);
  store.failRead = true;
  await assert.rejects(
    withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'offline'), () =>
      productionPrompt(decision, input),
    ),
  );
  store.failRead = false;
  await assert.rejects(
    withPromptBindings(store.db, databasePromptBinder(store.db, 'stage4', 'variant'), () =>
      productionPrompt(enrich, input, { variant: 'invalid' }),
    ),
  );
  const client = await store.db.connect();
  await client.query('begin');
  const firstClaim = await claimManualPrompt(
    client,
    'raw',
    'article',
    'daily.editorial.digest_put_back',
    true,
  );
  await client.query('commit');
  await assert.rejects(
    claimManualPrompt(client, 'raw', 'article', 'daily.editorial.digest_put_back', true),
  );
  await finishManualPrompt(store.db, 'raw', 'article', 'failed');
  assert.equal(
    await claimManualPrompt(client, 'raw', 'article', 'daily.editorial.digest_put_back', true),
    firstClaim,
  );
  await finishManualPrompt(store.db, 'raw', 'article', 'completed');
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      writeRunFile(join(root, 'parallel.json'), { status: `${i}` }),
    ),
  );
  assert.ok(JSON.parse(await readFile(join(root, 'parallel.json'), 'utf8')).promptVersions);
  assert.equal(
    (await readdir(root)).some((name) => name.endsWith('.tmp')),
    false,
  );
  await assert.rejects(
    writeRunFile(path, { promptVersions: { [key]: randomUUID() } }),
    /overwrite/,
  );
  const mirror = join(root, 'mirror.json');
  await writeRunFile(mirror, { promptVersions: { [decision]: old.id } });
  await assert.rejects(
    observeRunPrompts(mirror, store.db, mirror)(decision, changed.id),
    /conflicts/,
  );
  // Fresh HTTP attempts choose Active, while a persisted Put Back retry retains its old binding.
  const manualKey = 'in_depth.manual.generate' as const;
  const initialManual = await claimManualPrompt(client, 'candidate', 'manual', manualKey, false);
  await finishManualPrompt(store.db, 'candidate', 'manual', 'failed');
  const manualVersion = { ...store.versions.get(initialManual)!, id: randomUUID() };
  store.versions.set(manualVersion.id, manualVersion);
  store.active.set(manualKey, manualVersion.id);
  assert.equal(
    await claimManualPrompt(client, 'candidate', 'manual', manualKey, false),
    manualVersion.id,
  );
  await finishManualPrompt(store.db, 'candidate', 'manual', 'completed');
  const evaluationKey = 'daily.stage1.content_understanding' as const;
  const evaluationRows = [
    { id: 'model-1', prompt_version: 'legacy', status: 'running' },
    { id: 'model-2', prompt_version: 'legacy', status: 'running' },
  ];
  const evaluationSql: string[] = [];
  const evaluationQuery = async (sql: string, values: unknown[] = []) => {
    evaluationSql.push(sql);
    if (sql.includes('from evaluation_inputs')) return { rows: [{ id: 'input' }] };
    if (sql.includes('select prompt_version from evaluation_runs'))
      return {
        rows: evaluationRows.filter((row) => /^[a-fA-F0-9-]{36}$/.test(row.prompt_version)),
      };
    if (sql.includes('update evaluation_runs')) {
      const updated = evaluationRows.filter(
        (row) =>
          row.status === 'running' &&
          (!/^[a-fA-F0-9-]{36}$/.test(row.prompt_version) || row.prompt_version === values[1]),
      );
      updated.forEach((row) => {
        row.prompt_version = String(values[1]);
      });
      return { rows: updated.map((row) => ({ id: row.id })) };
    }
    return store.handle(sql, values) ?? { rows: [] };
  };
  const evaluationDb = {
    query: evaluationQuery,
    connect: async () => ({ query: evaluationQuery, release() {} }),
  } as unknown as typeof store.db;
  const firstEvaluation = await withPromptBindings(
    evaluationDb,
    evaluationPromptBinder(evaluationDb, 'input', 'model-1'),
    () => productionPrompt(evaluationKey, input),
  );
  const switched = { ...store.versions.get(firstEvaluation.versionId)!, id: randomUUID() };
  store.versions.set(switched.id, switched);
  store.active.set(evaluationKey, switched.id);
  const resumedEvaluation = await withPromptBindings(
    evaluationDb,
    evaluationPromptBinder(evaluationDb, 'input', 'model-2'),
    () => productionPrompt(evaluationKey, input),
  );
  assert.equal(resumedEvaluation.versionId, firstEvaluation.versionId);
  assert.equal(evaluationRows[0].prompt_version, evaluationRows[1].prompt_version);
  assert.ok(
    evaluationSql.some((sql) => sql.includes('evaluation_inputs') && sql.includes('for update')),
  );
  evaluationRows[1].prompt_version = switched.id;
  await assert.rejects(
    withPromptBindings(evaluationDb, evaluationPromptBinder(evaluationDb, 'input', 'model-1'), () =>
      productionPrompt(evaluationKey, input),
    ),
    /conflicting/,
  );
  console.log(
    'Prompt runtime: 15 keys, lazy binding, concurrent reuse, failed persistence, Resume, Stage4 authority/new runs, optional roles, invalid versions/DB/variants, manual fresh attempts/failed retries, Evaluation shared binding/conflicts and atomic files passed.',
  );
  client.release();
} finally {
  await rm(root, { recursive: true, force: true });
}
