/** No SDK network clients, database connections, or paid tools are invoked. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { Trace } from '@openai/agents';
import type { Pool } from 'pg';
import {
  PostgresDiscoveryTracingProcessor,
  finishDiscoveryTrace,
} from '../src/discovery/agent-tracing.js';
import type { DiscoveryD3RuntimeResult } from '../src/discovery/topic-discovery.js';
import type { DiscoveryFetchResult } from '../src/discovery/fetch-content.js';

export async function mockAgentTraceRun(
  stage: 'd3' | 'd5',
  pool: Pick<Pool, 'query'>,
  output: unknown,
  fetches: DiscoveryFetchResult[] = [],
  sdkFailure = false,
  agentFailure = false,
): Promise<DiscoveryD3RuntimeResult> {
  const file = stage === 'd3' ? 'topic-discovery' : 'open-discovery';
  const name = stage === 'd3' ? 'runDiscoveryD3Agent' : 'runDiscoveryD5Agent';
  const source = await readFile(new URL(`../src/discovery/${file}.ts`, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('agent.ts', source, ts.ScriptTarget.Latest, true);
  const fn = parsed.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  )!;
  let processor: PostgresDiscoveryTracingProcessor;
  const invoke = runInNewContext(
    ts.transpileModule(fn.getText(parsed).replace('export ', '') + `\n${name};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      process: { env: { CODEX_API_KEY: 'mock' } },
      AbortSignal,
      PostgresDiscoveryTracingProcessor,
      finishDiscoveryTrace,
      productionPrompt: async () => ({ input: 'mock' }),
      buildDiscoveryD3UserPrompt: () => '',
      buildDiscoveryD5UserPrompt: () => '',
      setTraceProcessors: (p: PostgresDiscoveryTracingProcessor[]) => {
        processor = p[0]!;
      },
      setDefaultOpenAIClient: () => {},
      setOpenAIAPI: () => {},
      OpenAI: class {},
      Agent: class {},
      DiscoveryD3OutputSchema: {},
      DiscoveryD5OutputSchema: {},
      webSearchTool: () => ({}),
      createDiscoveryFetchContentTool: () => ({}),
      Runner: class {
        async run(
          _agent: unknown,
          _input: unknown,
          options: { context: { fetches: DiscoveryFetchResult[] } },
        ) {
          await processor.onTraceStart(trace('agent'));
          if (agentFailure) throw new Error('Original Agent failure');
          options.context.fetches.push(...fetches);
          await processor.onTraceEnd(trace('agent'));
          return { finalOutput: output };
        }
      },
      getGlobalTraceProvider: () => ({
        forceFlush: async () => {
          if (sdkFailure) throw new Error('SDK flush failure');
          await processor.forceFlush();
        },
      }),
    },
  ) as (input: unknown) => Promise<DiscoveryD3RuntimeResult>;
  return invoke({
    pool,
    runId: 'mock-run',
    topicLeads: [],
    memory: null,
    config: { baseUrl: 'http://unused', timeoutMs: 10000, maxTurns: 1, model: 'mock' },
  });
}
const trace = (id: string) => ({ traceId: id, name: id, toJSON: () => ({}) }) as unknown as Trace;
const logs: unknown[][] = [];
const original = console.error;
console.error = (...args: unknown[]) => {
  logs.push(args);
};
try {
  const writes: string[] = [];
  let fail = true;
  const processor = new PostgresDiscoveryTracingProcessor(
    {
      query: async (_sql: unknown, p: unknown[]) => {
        writes.push(String(p[2]));
        if (writes.length === 2 && fail) throw new Error('Mock Trace DB failure');
        return { rows: [] };
      },
    } as unknown as Pool,
    'partial',
  );
  for (const id of ['a', 'b', 'c']) await processor.onTraceStart(trace(id));
  await processor.forceFlush();
  assert.equal(processor.traceFlushed, false);
  fail = false;
  await processor.forceFlush();
  assert.deepEqual(
    writes,
    ['a', 'b', 'b', 'c'],
    'Only unwritten spans retry; successful writes are not lost or repeated.',
  );
  assert.equal(processor.traceFlushed, true);
  assert.equal(await finishDiscoveryTrace(processor, async () => {}), true);

  let finishWrite!: () => void;
  let first = true;
  const statuses: string[] = [];
  const racing = new PostgresDiscoveryTracingProcessor(
    {
      query: async (_sql: unknown, p: unknown[]) => {
        statuses.push(String(p[9]));
        if (first) {
          first = false;
          await new Promise<void>((r) => {
            finishWrite = r;
          });
        }
        return { rows: [] };
      },
    } as unknown as Pool,
    'race',
  );
  await racing.onTraceStart(trace('updated'));
  const flushing = racing.forceFlush();
  await racing.onTraceEnd(trace('updated'));
  finishWrite();
  await flushing;
  assert.equal(racing.traceFlushed, false);
  await racing.forceFlush();
  assert.deepEqual(statuses, ['running', 'success']);

  const unavailable = {
    query: async () => {
      throw new Error('Trace database unavailable');
    },
  } as unknown as Pool;
  for (const stage of ['d3', 'd5'] as const) {
    const result = await mockAgentTraceRun(stage, unavailable, { candidates: [] });
    assert.deepEqual(result.output, { candidates: [] });
    assert.equal(result.traceFlushed, false);
    const normal = await mockAgentTraceRun(
      stage,
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      { candidates: [] },
    );
    assert.equal(normal.traceFlushed, true);
    const sdk = await mockAgentTraceRun(stage, unavailable, { candidates: [] }, [], true);
    assert.equal(sdk.traceFlushed, false);
    await assert.rejects(
      mockAgentTraceRun(stage, unavailable, null, [], true, true),
      /Original Agent failure/,
    );
  }
  const bounded = new PostgresDiscoveryTracingProcessor(unavailable, 'bounded');
  for (let n = 0; n < 1002; n++) await bounded.onTraceStart(trace(String(n)));
  assert.equal(await finishDiscoveryTrace(bounded, () => bounded.forceFlush()), false);
  await bounded.onTraceStart(trace('late'));
  assert.ok(logs.some((r) => r[0] === 'Discovery Trace buffer limit reached; dropping new spans.'));
  assert.ok(logs.some((r) => r[0] === 'Discovery Trace shutdown discarded unwritten spans.'));
  console.log(
    'Trace normal/partial flush, retry, concurrent updates, bounded discard and D3/D5 result/error isolation passed.',
  );
} finally {
  console.error = original;
}
