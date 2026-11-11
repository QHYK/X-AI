import { buildStage1Instructions } from './fixtures/legacy-prompts.js';
import { buildStage2Instructions } from './fixtures/legacy-prompts.js';
import { buildStage3EventRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage3DigestRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage3LongFormRankingInstructions } from './fixtures/legacy-prompts.js';
import { buildStage4EventEnrichmentInstructions } from './fixtures/legacy-prompts.js';
import { STAGE4_CONTEXT_DECISION_INSTRUCTIONS } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD3Instructions } from './fixtures/legacy-prompts.js';
import { buildDiscoveryD5Instructions } from './fixtures/legacy-prompts.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import type { Pool } from 'pg';
import { getActiveMemories, formatMemories } from '../src/lib/memories.js';
import { preparePromptPreview, displayPromptRequest, parsePreviewArgs } from './preview-prompt.js';
import { PromptMemory } from './fixtures/prompt-runtime.js';
import { withPromptBindings, databasePromptBinder } from '../src/lib/prompts/runtime.js';

// Execute production request builders with retained static references and database Prompts with network clients replaced at import time.
// No real client method, Agent loop, tool or database connection is invoked.
const captured: unknown[] = [];
const globals = globalThis as typeof globalThis & {
  __promptWireStatic?: (
    key: string,
    input: string,
    options?: { category?: string; variant?: string },
  ) => unknown;
  __promptWireBatch?: (articles: unknown, options: unknown) => unknown;
  __promptWireClient?: () => unknown;
  __promptWireAgent?: (options: unknown, input: unknown, runOptions: unknown) => unknown;
};
const dataModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const clientUrl = pathToFileURL(resolve('src/processing/llm-client.ts')).href;
const mockClient = dataModule(`export * from ${JSON.stringify(clientUrl)};
export function createLlmClient() { return globalThis.__promptWireClient(); }`);
const mockStage1 = dataModule(
  `export async function runStage1BatchLlm(articles,options) { return globalThis.__promptWireBatch(articles,options); }`,
);
const sdkUrl = import.meta.resolve('@openai/agents');
const { convertAgentOutputTypeToSerializable } = await import(
  new URL('./utils/tools.mjs', import.meta.resolve('@openai/agents-core')).href
);
const mockSdk = dataModule(`export * from ${JSON.stringify(sdkUrl)};
export class Agent { constructor(options) { this.options = options; } }
export class Runner { async run(agent, input, options) { return globalThis.__promptWireAgent(agent.options, input, options); } }
export function setDefaultOpenAIClient() {}
export function setOpenAIAPI() {}
export function setTraceProcessors() {}
export function getGlobalTraceProvider() { return { forceFlush: async () => {} }; }`);
const runtimeUrl = pathToFileURL(resolve('src/lib/prompts/runtime.ts')).href;
const staticRuntime = dataModule(`export * from ${JSON.stringify(runtimeUrl)};
export async function productionPrompt(key, input, options) { return globalThis.__promptWireStatic(key,input,options); }`);
async function moduleFromSource(path: string, source: string, baseline = false) {
  const javascript = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace(/from (['"])([^'"]+)\1/g, (_match, _quote, specifier: string) => {
      if (baseline && specifier.endsWith('/prompts/runtime.js'))
        return `from ${JSON.stringify(staticRuntime)}`;
      if (specifier.endsWith('/llm-client.js') || specifier === './llm-client.js')
        return `from ${JSON.stringify(mockClient)}`;
      if (specifier.endsWith('/stage1-llm.js')) return `from ${JSON.stringify(mockStage1)}`;
      if (specifier === '@openai/agents') return `from ${JSON.stringify(mockSdk)}`;
      if (!specifier.startsWith('.'))
        return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
      return `from ${JSON.stringify(pathToFileURL(resolve(dirname(path), specifier.replace(/\.js$/, '.ts'))).href)}`;
    });
  return import(dataModule(javascript));
}
const staticInstructions: Record<
  string,
  (options: { category?: string; variant?: string }) => string
> = {
  'daily.stage1.content_understanding': buildStage1Instructions,
  'daily.stage2.event_merge': buildStage2Instructions,
  'daily.stage3.event_ranking': buildStage3EventRankingInstructions,
  'daily.stage3.digest_ranking': (options) =>
    buildStage3DigestRankingInstructions(options.category!),
  'daily.stage3.long_form_ranking': buildStage3LongFormRankingInstructions,
  'daily.stage4.external_context_decision': () => STAGE4_CONTEXT_DECISION_INSTRUCTIONS,
  'daily.stage4.event_enrichment': (options) =>
    buildStage4EventEnrichmentInstructions({
      webSearchAvailable: options.variant === 'with_search',
    }),
  'discovery.d3.topic_discovery': buildDiscoveryD3Instructions,
  'discovery.d5.open_discovery': buildDiscoveryD5Instructions,
};
globals.__promptWireStatic = (key, input, options = {}) => ({
  instructions: staticInstructions[key](options),
  input,
  versionId: 'static-reference',
});
const memory = new PromptMemory();
let search = false;
globals.__promptWireClient = () => {
  const request = async (args: Record<string, unknown>, options: unknown) => {
    captured.push(structuredClone({ args, options }));
    const schema = args.text as { format?: { name?: string } } | undefined;
    return {
      id: 'mock-response',
      output: [],
      api_mode: 'responses',
      output_text:
        schema?.format?.name === 'stage4_external_context_decision'
          ? JSON.stringify({ need_external_context: search })
          : schema?.format?.name === 'stage3_consolidation'
            ? '{"matches":[]}'
            : '{}',
    };
  };
  return { structured: { create: request }, responses: { create: request }, close: async () => {} };
};
globals.__promptWireAgent = (options, input, runOptions) => {
  const agent = options as Record<string, unknown>;
  const run = runOptions as { maxTurns: number };
  // Tool functions have different closures, so compare their serializable configuration and schema.
  const schema = convertAgentOutputTypeToSerializable(agent.outputType);
  captured.push({
    instructions: agent.instructions,
    input,
    model: agent.model,
    tools: (agent.tools as { name?: string; type?: string; searchContextSize?: string }[]).map(
      (tool) => ({ name: tool.name, type: tool.type, searchContextSize: tool.searchContextSize }),
    ),
    outputType: schema,
    maxTurns: run.maxTurns,
  });
  return { finalOutput: { candidates: [] } };
};
const cases = [
  {
    path: 'src/processing/stage1-llm.ts',
    fn: 'runStage1BatchLlmForInput',
    input: { articles: [{ temp_id: 'A1', title: '原文', content: '内容' }] },
  },
  {
    path: 'src/processing/stage2-llm.ts',
    fn: 'runStage2MergeLlm',
    input: { event_candidates: [] },
  },
  {
    path: 'src/processing/stage3-event-ranking-llm.ts',
    fn: 'runStage3EventRankingLlm',
    input: { events: [] },
  },
  {
    path: 'src/processing/stage3-digest-ranking-llm.ts',
    fn: 'runStage3DigestRankingLlm',
    input: { category: 'Science', candidates: [] },
  },
  {
    path: 'src/processing/stage3-long-form-ranking-llm.ts',
    fn: 'runStage3LongFormRankingLlm',
    input: { candidates: [] },
  },
  {
    path: 'src/processing/stage4-llm.ts',
    fn: 'runStage4EventEnrichmentLlm',
    input: {
      event_hint: '原始事件',
      sources: [],
    },
  },
];
try {
  for (const test of cases) {
    const current = await moduleFromSource(test.path, await readFile(test.path, 'utf8'));
    const previous = await moduleFromSource(test.path, await readFile(test.path, 'utf8'), true);
    for (const webSearch of test.path.includes('stage4') ? [false, true] : [false]) {
      search = webSearch;
      captured.length = 0;
      await previous[test.fn](test.input, { maxRetries: 0, provider: 'openai' });
      const oldRequests = structuredClone(captured);
      assert.ok(oldRequests.length, `No original model request captured: ${test.fn}`);
      captured.length = 0;
      await withPromptBindings(
        memory.db,
        databasePromptBinder(memory.db, 'discovery', 'wire-test'),
        () => current[test.fn](test.input, { maxRetries: 0, provider: 'openai' }),
      );
      assert.deepEqual(captured, oldRequests, `${test.fn}, search=${webSearch}`);
      if (test.path.includes('stage4')) {
        for (const request of captured) {
          assert.ok(
            !JSON.stringify(request).includes('recent_events'),
            'Decision and both enrichment variants no longer receive historical context',
          );
        }
      }
    }
  }
  // New semantic matching request uses the actual Registry and structured client, with no legacy Prompt copy.
  const consolidationModule = await moduleFromSource(
    'src/processing/stage3-consolidation-llm.ts',
    await readFile('src/processing/stage3-consolidation-llm.ts', 'utf8'),
  );
  const consolidationInput = {
    category: 'Company',
    events: [
      {
        event_group_id: '00000000-0000-4000-8000-000000000001',
        hint: 'A specific earnings announcement',
      },
    ],
    candidates: [
      {
        id: '00000000-0000-4000-8000-000000000002',
        title: 'Report',
        summary: 'Announcement',
        source: 'Source',
      },
    ],
  };
  captured.length = 0;
  const consolidationResult = (await withPromptBindings(
    memory.db,
    databasePromptBinder(memory.db, 'discovery', 'consolidation-wire'),
    () =>
      consolidationModule.runStage3Consolidation(consolidationInput, {
        model: 'test-stage3-model',
      }),
  )) as import('../src/processing/stage3-consolidation-llm.js').ConsolidationResult;
  assert.equal(consolidationResult.calls, 1);
  assert.deepEqual(consolidationResult.output, { matches: [] });
  const consolidationRequest = (
    captured[0] as {
      args: {
        model: string;
        input: { content: { text: string }[] }[];
        text: { format: { strict: boolean; schema: { required: string[] } } };
      };
    }
  ).args;
  assert.equal(consolidationRequest.model, 'test-stage3-model');
  assert.deepEqual(JSON.parse(consolidationRequest.input[0].content[0].text), consolidationInput);
  assert.equal(consolidationRequest.text.format.strict, true);
  assert.deepEqual(consolidationRequest.text.format.schema.required, ['matches']);
  // Optional Memory changes only the dynamic User data; retries reuse the prepared request.
  for (const test of cases.filter((c) => /stage[13]-/.test(c.path))) {
    const current = await moduleFromSource(test.path, await readFile(test.path, 'utf8'));
    const requests = async (memoryContext: string, maxRetries = 0) => {
      captured.length = 0;
      await withPromptBindings(
        memory.db,
        databasePromptBinder(memory.db, 'discovery', 'memory-wire'),
        () => current[test.fn](test.input, { provider: 'openai', maxRetries, memoryContext }),
      );
      return structuredClone(captured) as {
        args: {
          instructions?: string;
          input: { content: { text: string }[] }[];
          text: unknown;
          model: string;
        };
      }[];
    };
    const empty = await requests('');
    const withMemory = await requests('Content preference marker', 1);
    assert.equal(withMemory.length, 2, 'Invalid Mock output triggers one automatic retry');
    for (const request of withMemory) {
      const data = JSON.parse(request.args.input[0].content[0].text);
      assert.equal(data.memory, 'Content preference marker');
      delete data.memory;
      assert.deepEqual(data, test.input, 'Original business input remains unchanged');
      assert.equal(
        request.args.input[0].content[0].text.split('Content preference marker').length,
        2,
      );
      assert.equal(request.args.instructions, empty[0].args.instructions);
      assert.deepEqual(request.args.text, empty[0].args.text, 'Output Schema is unchanged');
      assert.equal(request.args.model, empty[0].args.model);
    }
    assert.ok(!('memory' in JSON.parse(empty[0].args.input[0].content[0].text)));
    assert.deepEqual(withMemory[0], withMemory[1], 'Retry uses exactly the same prepared context');
  }

  // Exercise actual Stage1 batching with the shared Memory query and a network-free client.
  const stage1 = await moduleFromSource(
    'src/processing/stage1-llm.ts',
    await readFile('src/processing/stage1-llm.ts', 'utf8'),
  );
  const job = await moduleFromSource(
    'src/processing/stage1-job.ts',
    await readFile('src/processing/stage1-job.ts', 'utf8'),
  );
  globals.__promptWireBatch = (articles, options) => stage1.runStage1BatchLlm(articles, options);
  const originalClient = globals.__promptWireClient;
  let rejectMultiArticleBatch = false;
  globals.__promptWireClient = () => ({
    structured: {
      create: async (args: { input: { content: { text: string }[] }[] }) => {
        captured.push(structuredClone(args));
        const data = JSON.parse(args.input[0].content[0].text);
        return {
          id: 'mock',
          output_text:
            rejectMultiArticleBatch && data.articles.length > 1
              ? '{}'
              : JSON.stringify({
                  results: data.articles.map((a: { temp_id: string }) => ({
                    temp_id: a.temp_id,
                    category: 'General',
                    tags: [],
                    entities: [],
                    entities_zh: [],
                    routing: 'Ignore',
                    generated_content: { summary: '', summary_zh: '', title_zh: '' },
                  })),
                }),
        };
      },
    },
    close: async () => {},
  });
  const rows = [
    {
      content: 'content high',
      type: 'content',
      priority: 10,
      enabled: true,
      createdAt: '2026-10-20',
    },
    {
      content: 'content new',
      type: 'content',
      priority: 0,
      enabled: true,
      createdAt: '2026-10-22',
    },
    {
      content: 'content old',
      type: 'content',
      priority: 0,
      enabled: true,
      createdAt: '2026-10-21',
    },
    {
      content: 'disabled marker',
      type: 'content',
      priority: 100,
      enabled: false,
      createdAt: '2026-10-23',
    },
    { content: 'event marker', type: 'event', priority: 5, enabled: true, createdAt: '2026-10-20' },
    {
      content: 'disabled event',
      type: 'event',
      priority: 100,
      enabled: false,
      createdAt: '2026-10-20',
    },
    ...['general', 'topic', 'source'].map((type) => ({
      content: type,
      type,
      priority: 100,
      enabled: true,
      createdAt: '2026-10-23',
    })),
  ].map((r, i) => ({ ...r, id: String(i), updatedAt: '2026-10-23' }));
  let reads = 0;
  let failRead = false;
  let activeRows = rows;
  const db = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes('from memories')) {
        reads++;
        assert.ok(
          sql.includes('enabled = true') &&
            sql.includes('order by priority desc, created_at desc, id desc'),
        );
        assert.ok(
          JSON.stringify(values) === JSON.stringify([['content']]) ||
            JSON.stringify(values) === JSON.stringify([['content', 'event']]),
        );
        if (failRead) throw new Error('Memory read failure');
        return {
          rows: activeRows
            .filter((r) => r.enabled && (values[0] as string[]).includes(r.type))
            .sort(
              (a, b) =>
                b.priority - a.priority || Date.parse(b.createdAt) - Date.parse(a.createdAt),
            ),
        };
      }
      if (sql.includes('from raw_articles ra'))
        return {
          rows: [1, 2].map((id) => ({
            id: String(id),
            title: `Title ${id}`,
            contentText: 'Body',
            publishedAt: null,
            url: null,
            author: null,
            sourceName: 'Source',
            sourceCategory: 'General',
            sourceType: null,
            sourceTags: [],
            sourcePriority: 'High',
            eventCandidate: false,
            sourceDigestCandidate: true,
            sourceAvailability: null,
            sourceLanguage: 'en',
          })),
        };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  try {
    const selected = await getActiveMemories(db, { types: ['content'] });
    assert.deepEqual(
      selected.map((r) => r.content),
      ['content high', 'content new', 'content old'],
    );
    const context = formatMemories(selected);
    const previewDb = {
      query: async (sql: string, values: unknown[] = []) => {
        assert.match(sql.trim(), /^select/i, 'Preview must only issue read queries');
        return memory.handle(sql, values) ?? db.query(sql, values);
      },
    } as unknown as Pool;
    const preview = await preparePromptPreview(previewDb, 'stage1', { date: '2026-11-05' });
    assert.equal(preview.promptVersion, memory.active.get('daily.stage1.content_understanding'));
    assert.deepEqual(
      JSON.parse(
        String(
          displayPromptRequest(preview, preview.provider, 'articles').messages.find(
            (m) => m.role === 'user',
          )!.content,
        ),
      ),
      { articles: [], memory: context },
    );
    assert.equal(preview.memories.length, 3);
    assert.equal(
      JSON.parse(preview.businessInput).articles.length,
      2,
      'Real batch is built before display-only redaction',
    );
    const eventDb = {
      query: async (sql: string, args: unknown[] = []) =>
        sql.includes('from event_groups eg')
          ? {
              rows: [
                {
                  eventGroupId: 'event-group',
                  eventHint: 'Hidden event',
                  processedContentId: 'member',
                  source: 'Source',
                  title: 'Hidden title',
                  summary: 'Hidden summary',
                },
              ],
            }
          : previewDb.query(sql, args),
    } as unknown as Pool;
    const eventPreview = await preparePromptPreview(eventDb, 'stage3:event', {
      date: '2026-11-05',
    });
    assert.equal(JSON.parse(eventPreview.businessInput).events.length, 1);
    assert.deepEqual(
      JSON.parse(
        String(
          displayPromptRequest(eventPreview, eventPreview.provider, 'events').messages.find(
            (m) => m.role === 'user',
          )!.content,
        ),
      ),
      {
        events: [],
        memory: formatMemories(await getActiveMemories(db, { types: ['content', 'event'] })),
      },
    );
    const eventMemory = JSON.parse(eventPreview.businessInput).memory as string;
    assert.equal(eventMemory.split('event marker').length - 1, 1);
    assert.ok(!eventMemory.includes('disabled event'));
    assert.ok(!JSON.parse(preview.businessInput).memory.includes('event marker'));
    assert.equal(eventPreview.request.max_output_tokens, 8000);
    assert.equal(preview.request.max_output_tokens, 2400);
    for (const step of ['D2', 'stage1', 'stage3:event'])
      assert.equal(parsePreviewArgs([step]).step, step.toLowerCase());
    for (const args of [
      [],
      ['stage2'],
      ['D2', '--date=2026-11-05'],
      ['stage1', '--dates=a,b'],
      ['stage1', '--date=bad'],
    ])
      assert.throws(() => parsePreviewArgs(args));

    activeRows = [];
    assert.ok(
      !(
        'memory' in
        JSON.parse(
          (await preparePromptPreview(previewDb, 'stage1', { date: '2026-11-05' })).businessInput,
        )
      ),
    );
    activeRows = rows;
    memory.failRead = true;
    await assert.rejects(
      () => preparePromptPreview(previewDb, 'stage1', { date: '2026-11-05' }),
      /Mock Prompt DB unavailable/,
    );
    memory.failRead = false;

    for (const empty of [false, true]) {
      if (empty) activeRows = [];
      reads = 0;
      captured.length = 0;
      const result = await withPromptBindings<
        import('../src/processing/stage1-job.js').Stage1JobSummary
      >(memory.db, databasePromptBinder(memory.db, 'discovery', 'memory-batch'), () =>
        job.processStage1Batch(db, { batchSize: 1, maxRetries: 0, concurrency: 2 }),
      );
      assert.equal(result.ignoredCount, 2);
      assert.equal(reads, 1, 'All batches read Memory once');
      assert.equal(captured.length, 2);
      for (const args of captured as { input: { content: { text: string }[] }[] }[]) {
        const data = JSON.parse(args.input[0].content[0].text);
        assert.equal(data.memory, empty ? undefined : context);
      }
    }
    activeRows = rows;
    rejectMultiArticleBatch = true;
    reads = 0;
    captured.length = 0;
    const split = await withPromptBindings<
      import('../src/processing/stage1-job.js').Stage1JobSummary
    >(memory.db, databasePromptBinder(memory.db, 'discovery', 'memory-split'), () =>
      job.processStage1Batch(db, { batchSize: 2, maxRetries: 0 }),
    );
    assert.equal(split.ignoredCount, 2);
    assert.equal(split.splitCount, 1);
    assert.equal(reads, 1);
    assert.equal(captured.length, 4, 'Initial Codex, Provider fallback and two split batches');
    for (const args of captured as { input: { content: { text: string }[] }[] }[])
      assert.equal(JSON.parse(args.input[0].content[0].text).memory, context);
    captured.length = 0;
    failRead = true;
    await assert.rejects(() => job.processStage1Batch(db), /Memory read failure/);
    await assert.rejects(
      () => preparePromptPreview(previewDb, 'stage1', { date: '2026-11-05' }),
      /Memory read failure/,
    );
    assert.equal(captured.length, 0, 'Read failure must not call the model');
  } finally {
    globals.__promptWireClient = originalClient;
    delete globals.__promptWireBatch;
  }
  const originalKey = process.env.CODEX_API_KEY;
  process.env.CODEX_API_KEY = 'mock-never-sent';
  try {
    for (const stage of ['topic', 'open']) {
      const path = `src/discovery/${stage}-discovery.ts`;
      const fn = stage === 'topic' ? 'runDiscoveryD3Agent' : 'runDiscoveryD5Agent';
      const args = {
        pool: memory.db,
        runId: 'mock-run',
        topicLeads: [],
        memory: { example: '动态输入' },
        manualContext: '人工方向',
        config: {
          model: 'mock-model',
          baseUrl: 'http://127.0.0.1:1',
          fetchTimeoutMs: 1000,
          timeoutMs: 1000,
          maxTurns: 8,
        },
      };
      const previous = await moduleFromSource(path, await readFile(path, 'utf8'), true);
      const current = await moduleFromSource(path, await readFile(path, 'utf8'));
      captured.length = 0;
      await previous[fn](args);
      const old = [...captured];
      captured.length = 0;
      await withPromptBindings(
        memory.db,
        databasePromptBinder(memory.db, 'discovery', 'wire-agent'),
        () => current[fn](args),
      );
      assert.deepEqual(captured, old, fn);
    }
  } finally {
    if (originalKey === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = originalKey;
  }
  console.log(
    'Original vs database production request equality: Daily 7 types, Stage4 search/no-search, D3/D5 Agent instructions/input/model/tools/schema/maxTurns passed.',
  );
} finally {
  delete globals.__promptWireBatch;
  delete globals.__promptWireStatic;
  delete globals.__promptWireClient;
  delete globals.__promptWireAgent;
}
