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
  __promptWireClient?: () => unknown;
  __promptWireAgent?: (options: unknown, input: unknown, runOptions: unknown) => unknown;
};
const dataModule = (source: string) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const clientUrl = pathToFileURL(resolve('src/processing/llm-client.ts')).href;
const mockClient = dataModule(`export * from ${JSON.stringify(clientUrl)};
export function createLlmClient() { return globalThis.__promptWireClient(); }`);
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
  delete globals.__promptWireStatic;
  delete globals.__promptWireClient;
  delete globals.__promptWireAgent;
}
