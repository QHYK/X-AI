import { buildChatCompletionRequest } from '../src/processing/llm-client.js';
import { displayD2Request } from './preview-d2-input.js';
import { withPromptBindings } from '../src/lib/prompts/runtime.js';
import assert from 'node:assert/strict';
import { getActiveMemories, formatMemories } from '../src/lib/memories.js';
import type { Memory } from '../src/lib/memory-contracts.js';
import { buildDiscoveryD2UserPrompt } from '../src/prompts/discovery-topic-selection.js';
import { attachPromptMemory, PromptMemory } from './fixtures/prompt-runtime.js';
import { baselineVersionId } from '../src/lib/prompts/production-seeds.js';
import type { Pool } from 'pg';
import { resolveProviderLlmModel } from '../src/processing/llm-client.js';
import {
  parseAndValidateDiscoveryD4Output,
  resolveDirectDuration,
  runDiscoveryD4 as executeD4,
} from '../src/discovery/direct-verification.js';
import type { DiscoveryWindowInput } from '../src/discovery/daily-read-adapter.js';
import {
  parseAndValidateDiscoveryD2Output,
  runDiscoveryD2 as executeD2,
  prepareDiscoveryD2Request,
  type DiscoverySelectionOutput,
} from '../src/discovery/topic-selection.js';
import {
  resolveDiscoveryLlmProvider,
  resolveDiscoveryLlmTimeout,
  toDiscoveryRequestOptions,
} from '../src/discovery/llm-config.js';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const IDS = {
  event: '00000000-0000-4000-8000-000000000010',
  digestEligible: '00000000-0000-4000-8000-000000000011',
  digestIneligible: '00000000-0000-4000-8000-000000000012',
  longEligible: '00000000-0000-4000-8000-000000000013',
  digestDuplicate: '00000000-0000-4000-8000-000000000014',
  longMissingUrl: '00000000-0000-4000-8000-000000000015',
  unknown: '00000000-0000-4000-8000-000000000099',
};

const checks: Array<[string, boolean]> = [];

function testDiscoveryLlmConfig() {
  const environment = {
    LLM_PROVIDER: 'deepseek',
    DISCOVERY_LLM_PROVIDER: 'openai',
    DISCOVERY_D2_PROVIDER: 'codex',
    DISCOVERY_D4_PROVIDER: 'kimi',
  };
  const originalGenericModel = process.env.LLM_MODEL;
  const originalDeepseekModel = process.env.DEEPSEEK_MODEL;
  process.env.LLM_MODEL = 'generic-model-must-not-override-discovery-provider-model';
  process.env.DEEPSEEK_MODEL = 'deepseek-test-model';
  try {
    checks.push(
      [
        'Discovery stage provider overrides the shared Discovery and project default providers',
        resolveDiscoveryLlmProvider('d2', undefined, environment) === 'codex' &&
          resolveDiscoveryLlmProvider('d4', undefined, environment) === 'kimi',
      ],
      [
        'Discovery shared provider overrides the project default provider',
        resolveDiscoveryLlmProvider('d2', undefined, {
          LLM_PROVIDER: 'deepseek',
          DISCOVERY_LLM_PROVIDER: 'openai',
        }) === 'openai',
      ],
      [
        'Explicit provider option overrides Discovery provider configuration',
        resolveDiscoveryLlmProvider('d2', 'kimi', environment) === 'kimi',
      ],
      [
        'Discovery falls back to the existing project provider and provider-specific model resolver',
        resolveDiscoveryLlmProvider('d2', undefined, { LLM_PROVIDER: 'deepseek' }) === 'deepseek' &&
          resolveProviderLlmModel('deepseek') === 'deepseek-test-model',
      ],
      [
        'Invalid Discovery provider is rejected by the shared provider resolver',
        throws(() =>
          resolveDiscoveryLlmProvider('d2', undefined, {
            DISCOVERY_D2_PROVIDER: 'not-a-provider',
          }),
        ),
      ],
      [
        'Discovery stage timeout overrides the shared Discovery timeout',
        resolveDiscoveryLlmTimeout('d2', undefined, {
          DISCOVERY_LLM_TIMEOUT_MS: '120000',
          DISCOVERY_D2_TIMEOUT_MS: '90000',
          DISCOVERY_D4_TIMEOUT_MS: '150000',
        }) === 90_000 &&
          resolveDiscoveryLlmTimeout('d4', undefined, {
            DISCOVERY_LLM_TIMEOUT_MS: '120000',
            DISCOVERY_D2_TIMEOUT_MS: '90000',
            DISCOVERY_D4_TIMEOUT_MS: '150000',
          }) === 150_000,
      ],
      [
        'Discovery shared timeout is used when its stage timeout is absent',
        resolveDiscoveryLlmTimeout('d2', undefined, {
          DISCOVERY_LLM_TIMEOUT_MS: '120000',
        }) === 120_000,
      ],
      [
        'Discovery leaves timeout undefined for the shared LLM client default',
        resolveDiscoveryLlmTimeout('d2', undefined, {}) === undefined,
      ],
      [
        'Explicit timeout option overrides Discovery timeout configuration',
        resolveDiscoveryLlmTimeout('d2', 60_000, { DISCOVERY_D2_TIMEOUT_MS: '90000' }) === 60_000,
      ],
      [
        'Undefined timeout is omitted instead of sent to the OpenAI SDK',
        !Object.hasOwn(toDiscoveryRequestOptions(undefined), 'timeout') &&
          toDiscoveryRequestOptions(120_000).timeout === 120_000,
      ],
      [
        'Invalid Discovery timeout fails before reaching the OpenAI SDK',
        throws(() => toDiscoveryRequestOptions(12.5)) &&
          throws(() =>
            resolveDiscoveryLlmTimeout('d4', undefined, {
              DISCOVERY_D4_TIMEOUT_MS: 'not-a-number',
            }),
          ),
      ],
    );
  } finally {
    if (originalGenericModel === undefined) delete process.env.LLM_MODEL;
    else process.env.LLM_MODEL = originalGenericModel;
    if (originalDeepseekModel === undefined) delete process.env.DEEPSEEK_MODEL;
    else process.env.DEEPSEEK_MODEL = originalDeepseekModel;
  }
}

function testD2Validation() {
  const input = discoveryWindowFixture();
  const empty = parseAndValidateDiscoveryD2Output('{"leads":[]}', input);
  const acceptedDigest = parseAndValidateDiscoveryD2Output(
    JSON.stringify({
      leads: [
        d2Direct(IDS.digestEligible, '值得全文验证'),
        d2Topic('机制是什么？', '值得理解', '来自两期 Daily', [IDS.event]),
      ],
    }),
    input,
  );
  const stableAgain = parseAndValidateDiscoveryD2Output(
    JSON.stringify({
      leads: [
        d2Direct(IDS.digestEligible, '值得全文验证'),
        d2Topic('机制是什么？', '值得理解', '来自两期 Daily', [IDS.event]),
      ],
    }),
    input,
  );

  checks.push(
    [
      'D2 transport parser accepts empty output; execution enforces valid Leads',
      empty.leads.length === 0,
    ],
    [
      'D2 accepts an eligible Digest and assigns stable ordered Lead IDs',
      acceptedDigest.leads[0]?.kind === 'direct' &&
        acceptedDigest.leads[0].leadId === 'lead-01' &&
        acceptedDigest.leads[1]?.leadId === 'lead-02' &&
        JSON.stringify(acceptedDigest) === JSON.stringify(stableAgain),
    ],
    [
      'D2 rejects more than 8 Leads',
      throws(() =>
        parseAndValidateDiscoveryD2Output(
          JSON.stringify({
            leads: Array.from({ length: 9 }, () => d2Direct(IDS.digestEligible, 'x')),
          }),
          input,
        ),
      ),
    ],
    [
      'D2 rejects an unknown source ID',
      throws(() =>
        parseAndValidateDiscoveryD2Output(
          JSON.stringify({
            leads: [d2Direct(IDS.unknown, 'x')],
          }),
          input,
        ),
      ),
    ],
    [
      'D2 still rejects Event Direct references',
      [IDS.event].every((sourceContentId) =>
        throws(() =>
          parseAndValidateDiscoveryD2Output(
            JSON.stringify({
              leads: [d2Direct(sourceContentId, 'x')],
            }),
            input,
          ),
        ),
      ),
    ],
    [
      'D2 rejects invalid nullable field combinations and repeated Topic source IDs',
      throws(() =>
        parseAndValidateDiscoveryD2Output(
          JSON.stringify({
            leads: [
              {
                ...d2Direct(IDS.digestEligible, 'x'),
                question: 'Direct must not include a question',
              },
            ],
          }),
          input,
        ),
      ) &&
        throws(() =>
          parseAndValidateDiscoveryD2Output(
            JSON.stringify({
              leads: [d2Topic('问题', '理由', '背景', [IDS.event, IDS.event])],
            }),
            input,
          ),
        ),
    ],
  );
}

const promptDbs = new WeakMap<Pool, Pool>();
function promptDb(db: Pool): Pool {
  let decorated = promptDbs.get(db);
  if (!decorated) {
    decorated = attachPromptMemory(db);
    promptDbs.set(db, decorated);
  }
  return decorated;
}
const runDiscoveryD2 = (
  db: Pool,
  ...args: Parameters<typeof executeD2> extends [Pool, ...infer R] ? R : never
) => executeD2(promptDb(db), ...args);
const runDiscoveryD4 = (
  db: Pool,
  ...args: Parameters<typeof executeD4> extends [Pool, ...infer R] ? R : never
) => executeD4(promptDb(db), ...args);

async function testD2PersistenceAndUrlEnrichment() {
  const input = discoveryWindowFixture();
  const db = new FakeDiscoveryPool(input, {
    [IDS.digestEligible]: 'https://example.test/digest',
    [IDS.longEligible]: null,
  });
  const output = {
    leads: [d2Direct(IDS.digestEligible, 'Digest'), d2Direct(IDS.longEligible, 'Long')],
  };
  let requestOptions: { timeout?: number } | null = null;
  let transportSchema: unknown = null;
  const result = await runDiscoveryD2(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    input,
    request: async (request, options) => {
      requestOptions = options;
      transportSchema = request.text.format.schema;
      return llmResponse(output);
    },
  });
  const direct = result.selection.leads.filter((lead) => lead.kind === 'direct');
  checks.push(
    [
      'D2 enriches Direct URLs in Code and persists them with Lead IDs',
      direct[0]?.url === 'https://example.test/digest' &&
        direct[1]?.url === null &&
        db.run.selection_output !== null &&
        (db.run.config_snapshot?.d2 as { promptVersion?: string })?.promptVersion ===
          baselineVersionId('discovery.d2.topic_selection'),
    ],
    [
      'D2 records missing_url diagnostics without putting URLs in LLM output',
      db.diagnostics.some(
        (diagnostic) =>
          diagnostic.reason === 'missing_url' && diagnostic.sourceContentId === IDS.longEligible,
      ),
    ],
    [
      'D2 omits an undefined timeout from the LLM request options',
      requestOptions !== null && !Object.hasOwn(requestOptions, 'timeout'),
    ],
    [
      'D2 sends a strict single-object transport Schema without oneOf',
      hasStrictD2TransportSchema(transportSchema),
    ],
    [
      'D2 returns the resolved model, API mode and request elapsed time for the integration caller',
      result.model === resolveProviderLlmModel('openai') &&
        result.apiMode === 'chat_completions' &&
        result.timeoutMs === undefined &&
        Number.isInteger(result.requestElapsedMs) &&
        result.requestElapsedMs >= 0,
    ],
    [
      'D2 persists complete per-stage usage including an explicit zero cached-token value',
      (db.run.execution_state as Record<string, Record<string, unknown>>).d2?.status ===
        'completed' &&
        JSON.stringify(
          (db.run.execution_state as Record<string, Record<string, unknown>>).d2?.usage,
        ) ===
          JSON.stringify({
            requests: 1,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            usageComplete: true,
          }),
    ],
  );
}

async function testD2ResponseRecovery() {
  const input = discoveryWindowFixture();
  const mixed = {
    leads: [
      d2Direct(IDS.digestIneligible, 'Bad Direct'),
      d2Direct(IDS.digestEligible, 'Good Direct'),
      d2Topic('Question?', 'Reason', 'Context', [IDS.event]),
    ],
  };
  const skipped: unknown[] = [];
  const parsed = parseAndValidateDiscoveryD2Output(JSON.stringify(mixed), input, (lead) =>
    skipped.push(lead),
  );
  assert.deepEqual(
    parsed.leads.map((lead) => lead.leadId),
    ['lead-02', 'lead-03'],
  );
  assert.deepEqual(skipped, [
    { leadId: 'lead-01', sourceContentId: IDS.digestIneligible, reason: 'direct_not_eligible' },
  ]);
  for (const leads of [
    [d2Direct(IDS.digestIneligible, '')],
    [d2Direct(IDS.digestIneligible, 'One'), d2Direct(IDS.digestIneligible, 'Duplicate')],
    [d2Direct(IDS.digestIneligible, 'One'), d2Direct(IDS.unknown, 'Unknown')],
  ])
    assert.throws(() => parseAndValidateDiscoveryD2Output(JSON.stringify({ leads }), input));

  const db = new FakeDiscoveryPool(input, { [IDS.digestEligible]: 'https://example.test/good' });
  let calls = 0;
  const request = async () => {
    calls++;
    return llmResponse(mixed);
  };
  db.failSelectionOnce = true;
  await assert.rejects(
    () => runDiscoveryD2(db as unknown as Pool, RUN_ID, { input, request }),
    /Mock selection persistence failure/,
  );
  assert(db.run.config_snapshot?.d2Response, 'Raw output must precede business persistence');
  const usage = () =>
    (
      db.run.execution_state as Record<
        string,
        { usage: { requests: number; inputTokens: number }; status: string }
      >
    ).d2;
  assert.equal(usage().usage.requests, 1);
  const saved = structuredClone(db.run.config_snapshot!.d2Response);
  const recovered = await runDiscoveryD2(db as unknown as Pool, RUN_ID, { input, request });
  assert.equal(calls, 1, 'Matching response is revalidated without another model request');
  assert.equal(recovered.requestElapsedMs, 0);
  assert.equal(recovered.selection.leads.length, 2);
  assert.equal(usage().usage.requests, 1);
  assert.equal(usage().usage.inputTokens, 1, 'Reuse must not recount historical tokens');
  assert(db.diagnostics.some((entry) => entry.reason === 'direct_not_eligible'));
  assert.equal(db.checkpointWrites, 1);

  // Existing response with current fields is independently revalidated on every retry.
  for (const invalid of [
    { leads: [d2Direct(IDS.digestIneligible, 'Ineligible')] },
    { leads: [] },
    { leads: [d2Direct(IDS.unknown, 'Unknown')] },
  ]) {
    const broken = new FakeDiscoveryPool(input, {});
    let requests = 0;
    const options = {
      input,
      request: async () => {
        requests++;
        return llmResponse(invalid);
      },
    };
    await assert.rejects(() => runDiscoveryD2(broken as unknown as Pool, RUN_ID, options));
    assert.equal(broken.run.selection_output, null);
    assert.equal(
      (broken.run.execution_state as Record<string, { status: string }>).d2.status,
      'failed',
    );
    await assert.rejects(() => runDiscoveryD2(broken as unknown as Pool, RUN_ID, options));
    assert.equal(requests, 1, 'Invalid matching output is retained; no silent paid regeneration');
  }

  // No snapshot/changed inputs or version identifiers cannot reuse an unrelated result.
  for (const change of [
    'input',
    'eligibility',
    'memory',
    'prompt',
    'fragment',
    'provider',
    'legacy',
  ] as const) {
    db.run.selection_output = null;
    db.run.config_snapshot = { ...db.run.config_snapshot, d2Response: structuredClone(saved) };
    const changed = structuredClone(input);
    let provider: 'openai' | 'kimi' = 'openai';
    db.memories = [];
    if (change === 'input') changed.days[0].digests[0].title = 'Changed title';
    if (change === 'eligibility') changed.days[0].digests[0].directEligible = false;
    if (change === 'memory')
      db.memories = [
        {
          id: 'm',
          content: 'New preference',
          type: 'topic',
          priority: 0,
          enabled: true,
          createdAt: '2026-10-30T00:00:00Z',
          updatedAt: '2026-10-30T00:00:00Z',
        },
      ];
    if (change === 'prompt')
      (db.run.config_snapshot.d2Response as { promptVersion: string }).promptVersion =
        '00000000-0000-4000-8000-000000000777';
    if (change === 'fragment')
      db.run.config_snapshot.systemFragmentVersions = {
        'xfield.identity': '00000000-0000-4000-8000-000000000778',
      };
    else delete db.run.config_snapshot.systemFragmentVersions;
    if (change === 'provider') provider = 'kimi';
    if (change === 'legacy') delete db.run.config_snapshot.d2Response;
    const count: number = calls;
    await runDiscoveryD2(db as unknown as Pool, RUN_ID, { input: changed, provider, request });
    assert.equal(calls, count + 1, `${change} invalidates response reuse`);
  }
  const newRun = new FakeDiscoveryPool(input, {
    [IDS.digestEligible]: 'https://example.test/good',
  });
  const newRunId = '00000000-0000-4000-8000-000000000555';
  newRun.run.id = newRunId;
  newRun.run.config_snapshot = { d2Response: structuredClone(saved) };
  const previousCalls: number = calls;
  await runDiscoveryD2(newRun as unknown as Pool, newRunId, { input, request });
  assert.equal(calls, previousCalls + 1, 'A new Run never inherits another Run response');
  const traceFailure = new FakeDiscoveryPool(input, {
    [IDS.digestEligible]: 'https://example.test/good',
  });
  traceFailure.diagnosticError = true;
  assert.equal(
    (await runDiscoveryD2(traceFailure as unknown as Pool, RUN_ID, { input, request })).selection
      .leads.length,
    2,
    'Diagnostic failure cannot discard valid leads',
  );
  const malformed = new FakeDiscoveryPool(input, {});
  let malformedCalls = 0;
  const malformedOptions = {
    input,
    request: async () => {
      malformedCalls++;
      return { ...llmResponse({}), output_text: '{invalid JSON' };
    },
  };
  await assert.rejects(
    () => runDiscoveryD2(malformed as unknown as Pool, RUN_ID, malformedOptions),
    /not valid JSON/,
  );
  await assert.rejects(
    () => runDiscoveryD2(malformed as unknown as Pool, RUN_ID, malformedOptions),
    /not valid JSON/,
  );
  assert.equal(malformedCalls, 1);
  malformed.run.config_snapshot!.d2Response = { broken: true };
  await assert.rejects(() =>
    runDiscoveryD2(malformed as unknown as Pool, RUN_ID, malformedOptions),
  );
  assert.equal(malformedCalls, 1, 'Corrupt checkpoint fails explicitly instead of paying silently');
  db.run.selection_output = recovered.selection;
  const completedCalls = calls;
  await assert.rejects(
    () => runDiscoveryD2(db as unknown as Pool, RUN_ID, { input, request }),
    /already has a persisted selection/,
  );
  assert.equal(calls, completedCalls);
  const failedWrite = new FakeDiscoveryPool(input, {});
  failedWrite.checkpointError = true;
  await assert.rejects(
    () => runDiscoveryD2(failedWrite as unknown as Pool, RUN_ID, { input, request }),
    /raw response persistence failure/,
  );
  assert.equal(failedWrite.run.selection_output, null);
  assert.equal(failedWrite.run.config_snapshot?.d2Response, undefined);
  assert.equal(
    (failedWrite.run.execution_state as Record<string, { usage: { requests: number } }>).d2.usage
      .requests,
    1,
  );
  checks.push([
    'D2 filters only ineligible Directs, rejects empty/invalid results, checkpoints before validation, reuses exact inputs/versions without recounting Usage, and propagates persistence failures',
    true,
  ]);
}

async function testD2Memories() {
  const input = discoveryWindowFixture();
  const db = new FakeDiscoveryPool(input, {});
  const promptStore = new PromptMemory();
  const pool = attachPromptMemory(db as unknown as Pool, promptStore);
  const row = (
    content: string,
    type: Memory['type'],
    priority: number,
    enabled = true,
    day = 20,
  ): Memory => ({
    id: content,
    content,
    type,
    priority,
    enabled,
    createdAt: `2026-10-${day}T00:00:00Z`,
    updatedAt: '2026-10-22T00:00:00Z',
  });
  db.memories = [
    row('topic older', 'topic', 5),
    row('general newer', 'general', 5, true, 21),
    row('topic highest', 'topic', 10),
    row('disabled', 'general', 100, false),
    row('excluded source', 'source', 100),
    row('excluded content', 'content', 100),
  ];
  assert.deepEqual(
    (await getActiveMemories(pool, { types: ['general', 'topic'] })).map((m) => m.content),
    ['topic highest', 'general newer', 'topic older'],
  );
  assert.deepEqual(
    (await getActiveMemories(pool, { types: ['source'] })).map((m) => m.content),
    ['excluded source'],
  );
  const reads = db.memoryReads;
  assert.deepEqual(await getActiveMemories(pool, { types: [] }), []);
  assert.equal(db.memoryReads, reads);
  assert.equal(formatMemories([]), '');
  assert.equal(buildDiscoveryD2UserPrompt(input, ''), buildDiscoveryD2UserPrompt(input));
  const schemas: string[] = [];
  const payloads: Array<{ contents: unknown; memory?: string }> = [];
  const call = async () => {
    db.run.selection_output = null;
    return executeD2(pool, RUN_ID, {
      provider: 'openai',
      input,
      request: async (request) => {
        schemas.push(JSON.stringify(request.text.format.schema));
        payloads.push(JSON.parse(request.input));
        return llmResponse({ leads: [d2Topic('Question?', 'Reason', 'Context', [IDS.event])] });
      },
    });
  };
  await call();
  assert.equal(db.memoryReads, reads + 1, 'One Memory read per actual D2 execution');
  assert.deepEqual(payloads[0].contents, JSON.parse(buildDiscoveryD2UserPrompt(input)).contents);
  assert.match(payloads[0].memory!, /topic highest/);
  assert.match(payloads[0].memory!, /general newer/);
  assert.equal(
    payloads[0].memory,
    formatMemories(await getActiveMemories(pool, { types: ['general', 'topic'] })),
  );
  assert.doesNotMatch(payloads[0].memory!, /disabled|excluded/);
  const bound = (
    promptStore.owners.get(`discovery_runs:${RUN_ID}`)?.promptVersions as Record<string, string>
  )?.['discovery.d2.topic_selection'];
  assert.ok(bound);
  db.memoryError = true;
  await assert.rejects(call, /Memory database unavailable/);
  assert.equal(payloads.length, 1, 'Memory read failure must not issue a model request');
  assert.equal((db.run.execution_state as Record<string, { status: string }>).d2.status, 'failed');
  db.memoryError = false;
  db.memories = [row('latest retry preference', 'topic', 0)];
  await call();
  assert.match(payloads[1].memory!, /latest retry preference/);
  assert.doesNotMatch(payloads[1].memory!, /topic highest/);
  assert.equal(
    (
      promptStore.owners.get(`discovery_runs:${RUN_ID}`)?.promptVersions as Record<string, string>
    )?.['discovery.d2.topic_selection'],
    bound,
  );
  db.memories = [];
  await call();
  assert.equal(Object.hasOwn(payloads[2], 'memory'), false);
  assert.equal(JSON.stringify(payloads[2]), buildDiscoveryD2UserPrompt(input));
  assert.ok(
    schemas.every((schema) => schema === schemas[0]),
    'Memory never changes Structured Output Schema',
  );
  assert.equal(
    JSON.stringify(db.run).includes('latest retry preference'),
    false,
    'No Memory snapshot is persisted',
  );
  db.memories = [row('preview Memory with {{input}} and {contents: []}', 'topic', 1)];
  const ownersBefore = JSON.stringify([...promptStore.owners]);
  const prepared = await withPromptBindings(
    pool,
    (_key, active) => active(),
    () => prepareDiscoveryD2Request(pool, input, 'preview-model'),
    { binding: 'active' },
  );
  const displayed = displayD2Request(prepared, 'openai');
  const actual = buildChatCompletionRequest('openai', prepared.request);
  const displayedUser = displayed.messages.find((m) => m.role === 'user')!.content as string;
  assert.equal(
    JSON.stringify([...promptStore.owners]),
    ownersBefore,
    'Preview must not bind a Run',
  );
  assert.deepEqual({ ...displayed, messages: [] }, { ...actual, messages: [] });
  assert.deepEqual(
    displayed.messages.filter((m) => m.role !== 'user'),
    actual.messages.filter((m) => m.role !== 'user'),
  );
  assert.deepEqual(JSON.parse(displayedUser).contents, {});
  assert.equal(JSON.parse(displayedUser).memory, JSON.parse(prepared.businessInput).memory);
  assert.ok(
    Array.isArray(JSON.parse(prepared.request.input).contents),
    'Original request is not redacted',
  );
  const wrapped = {
    ...prepared,
    request: { ...prepared.request, input: `Prefix\n${prepared.request.input}\nSuffix` },
  };
  assert.equal(
    displayD2Request(wrapped, 'openai').messages.find((m) => m.role === 'user')!.content,
    `Prefix\n${displayedUser}\nSuffix`,
  );
  assert.throws(
    () =>
      displayD2Request(
        { ...prepared, request: { ...prepared.request, input: 'not present' } },
        'openai',
      ),
    /Cannot safely locate/,
  );
  assert.equal(payloads.length, 3, 'Preview does not call the model');
  checks.push([
    'Memory Runtime filtering/order, final D2 request, empty parity, DB failure, retry refresh and fixed Prompt/Schema',
    true,
  ]);
}

function testD4OutputValidation() {
  for (const field of ['title_zh', 'summary', 'whyWorthReading']) {
    for (const invalid of [undefined, '', 'English only']) {
      const output = { ...evaluation('candidate', 'qualified'), [field]: invalid };
      checks.push([
        `D4 rejects invalid qualified ${field}: ${invalid}`,
        throws(() =>
          parseAndValidateDiscoveryD4Output(JSON.stringify({ evaluations: [output] }), [
            'candidate',
          ]),
        ),
      ]);
    }
  }
  const valid = parseAndValidateDiscoveryD4Output(
    JSON.stringify({
      evaluations: [
        evaluation('candidate-a', 'unverifiable'),
        evaluation('candidate-b', 'rejected'),
      ],
    }),
    ['candidate-a', 'candidate-b'],
  );
  const extraInfo = parseAndValidateDiscoveryD4Output(
    JSON.stringify({
      evaluations: [
        {
          ...evaluation('candidate-a', 'qualified'),
          extra_info: '{"editorialNote":"保留给人工审核"}',
        },
      ],
    }),
    ['candidate-a'],
  );
  checks.push(
    [
      'D4 keeps unverifiable distinct from rejected and defaults extra_info to an object',
      valid[0]?.decision === 'unverifiable' &&
        valid[1]?.decision === 'rejected' &&
        Object.keys(valid[0]?.extraInfo ?? {}).length === 0,
    ],
    [
      'D4 preserves JSON-serialized extra_info as the existing object business value',
      extraInfo[0]?.extraInfo.editorialNote === '保留给人工审核',
    ],
    [
      'D4 rejects missing Candidate IDs',
      throws(() =>
        parseAndValidateDiscoveryD4Output(
          JSON.stringify({ evaluations: [evaluation('candidate-a', 'qualified')] }),
          ['candidate-a', 'candidate-b'],
        ),
      ),
    ],
    [
      'D4 rejects duplicate Candidate IDs',
      throws(() =>
        parseAndValidateDiscoveryD4Output(
          JSON.stringify({
            evaluations: [
              evaluation('candidate-a', 'qualified'),
              evaluation('candidate-a', 'rejected'),
            ],
          }),
          ['candidate-a'],
        ),
      ),
    ],
  );
}

async function testD4PrechecksAndPersistence() {
  const input = discoveryWindowFixture();
  const selection: DiscoverySelectionOutput = {
    leads: [
      directLead('lead-01', IDS.digestEligible, 'https://example.test/qualified'),
      directLead('lead-02', IDS.longEligible, 'https://example.test/missing-body'),
      directLead('lead-03', IDS.digestDuplicate, 'https://example.test/duplicate?utm_source=x'),
      directLead('lead-04', IDS.longMissingUrl, null),
    ],
  };
  const db = new FakeDiscoveryPool(input, {}, selection);
  db.sources.set(IDS.digestEligible, sourceRow(IDS.digestEligible, 'Full body', null));
  db.sources.set(IDS.longEligible, sourceRow(IDS.longEligible, null, null));
  db.sources.set(IDS.digestDuplicate, sourceRow(IDS.digestDuplicate, 'Body', null));
  db.sources.set(IDS.longMissingUrl, sourceRow(IDS.longMissingUrl, 'Body', null));
  db.historicalUrls.add('https://example.test/duplicate');

  let requestOptions: { timeout?: number } | null = null;
  let transportSchema: unknown = null;
  const result = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    request: async (request, options) => {
      requestOptions = options;
      transportSchema = request.text.format.schema;
      const payload = JSON.parse(request.input) as { candidates: Array<{ candidateId: string }> };
      return llmResponse({
        evaluations: payload.candidates.map((candidate) =>
          evaluation(candidate.candidateId, 'qualified'),
        ),
      });
    },
  });

  const qualified = db.candidates.find((candidate) => candidate.sourceLeadId === 'lead-01');
  const missingBody = db.candidates.find((candidate) => candidate.sourceLeadId === 'lead-02');
  const duplicate = db.candidates.find((candidate) => candidate.sourceLeadId === 'lead-03');
  const storedQualified = db.candidates.find(
    (candidate) => candidate.evaluation?.decision === 'qualified',
  );
  checks.push([
    'D4 persists independent reader copy into existing Candidate columns',
    storedQualified?.titleZh === '中文标题' &&
      storedQualified?.summary === '文章主要论证和细节概要' &&
      storedQualified?.whyWorthReading === '适合关注科学方法的读者，具有长期学习价值',
  ]);
  checks.push(
    [
      'D4 persists source linkage and promotes qualified Direct candidates',
      qualified?.sourceContentId === IDS.digestEligible &&
        qualified.status === 'selected' &&
        db.reviewCandidateIds.has(qualified.id) &&
        JSON.stringify(qualified.evaluation?.tags) ===
          JSON.stringify([{ zh: '科学方法', en: 'Scientific Method' }]) &&
        (qualified.evidence.coverImage as { source?: string })?.source === 'raw_article',
    ],
    [
      'D4 records missing body as unverifiable and historical duplicate as rejected',
      missingBody?.status === 'unverifiable' &&
        missingBody.evaluation?.decision === 'unverifiable' &&
        duplicate?.status === 'rejected' &&
        duplicate.evaluation?.decision === 'rejected',
    ],
    [
      'D4 skips missing URL before Candidate creation and LLM evaluation',
      result.skippedMissingUrl === 1 &&
        !db.candidates.some((candidate) => candidate.sourceLeadId === 'lead-04') &&
        result.requestCount === 1,
    ],
    [
      'D4 returns provider token usage for the integration caller',
      result.tokenUsage?.input_tokens === 1 &&
        result.tokenUsage.output_tokens === 1 &&
        result.tokenUsage.total_tokens === 2 &&
        result.tokenUsageComplete,
    ],
    [
      'D4 omits an undefined timeout from the LLM request options',
      requestOptions !== null && !Object.hasOwn(requestOptions, 'timeout'),
    ],
    [
      'D4 sends a strict transport Schema without permissive additionalProperties',
      hasStrictD4TransportSchema(transportSchema),
    ],
    [
      'D4 returns the resolved model, API mode and cumulative request elapsed time',
      result.model === resolveProviderLlmModel('openai') &&
        JSON.stringify(result.apiModes) === JSON.stringify(['chat_completions']) &&
        result.timeoutMs === undefined &&
        Number.isInteger(result.requestElapsedMs) &&
        result.requestElapsedMs >= 0,
    ],
  );
}

async function testD4SerialPerCandidateRequests() {
  const input = discoveryWindowFixture();
  const selection: DiscoverySelectionOutput = {
    leads: [
      directLead('lead-01', IDS.digestEligible, 'https://example.test/split-a'),
      directLead('lead-02', IDS.longEligible, 'https://example.test/split-b'),
    ],
  };
  const db = new FakeDiscoveryPool(input, {}, selection);
  db.sources.set(IDS.digestEligible, sourceRow(IDS.digestEligible, 'A body', null));
  db.sources.set(IDS.longEligible, sourceRow(IDS.longEligible, 'B body', null));

  const requestCandidateCounts: number[] = [];
  const result = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    request: async (request) => {
      const payload = JSON.parse(request.input) as { candidates: Array<{ candidateId: string }> };
      requestCandidateCounts.push(payload.candidates.length);
      return llmResponse({
        evaluations: [evaluation(payload.candidates[0]!.candidateId, 'qualified')],
      });
    },
  });

  checks.push([
    'D4 evaluates each Direct Candidate serially in its own request and aggregates successful usage',
    JSON.stringify(requestCandidateCounts) === JSON.stringify([1, 1]) &&
      result.requestCount === 2 &&
      result.successfulRequestCount === 2 &&
      result.failedRequestCount === 0 &&
      result.tokenUsage?.input_tokens === 2 &&
      result.tokenUsage.output_tokens === 2 &&
      result.tokenUsage.total_tokens === 4 &&
      result.tokenUsageComplete,
  ]);
}

async function testD4MissingReaderFields() {
  const input = discoveryWindowFixture();
  const db = new FakeDiscoveryPool(
    input,
    {},
    { leads: [directLead('lead-01', IDS.digestEligible, 'https://example.test/incomplete')] },
  );
  db.sources.set(IDS.digestEligible, {
    ...sourceRow(IDS.digestEligible, 'Article body', null),
    metadata: { ogSiteName: 'Verified Publisher' },
  });
  const result = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    request: async (request) => {
      const payload = JSON.parse(request.input);
      return llmResponse({
        evaluations: [
          { ...evaluation(payload.candidates[0].candidateId, 'qualified'), summary: '' },
        ],
      });
    },
  });
  checks.push([
    'D4 missing qualified content records failure without promotion or substitute calls',
    result.failedRequestCount === 1 &&
      result.requestCount === 1 &&
      db.candidates[0]?.status === 'discovered' &&
      db.reviewCandidateIds.size === 0 &&
      db.diagnostics.some(
        (diagnostic) =>
          diagnostic.requestStatus === 'response_received_validation_or_persistence_failed' &&
          String(diagnostic.error).includes('summary'),
      ),
  ]);
  checks.push([
    'D4 verified metadata takes priority over inherited Daily source',
    db.candidates[0]?.publication === 'Verified Publisher',
  ]);
}

async function testD4FailureRecovery() {
  const input = discoveryWindowFixture();
  const selection: DiscoverySelectionOutput = {
    leads: [
      directLead('lead-01', IDS.digestEligible, 'https://example.test/a'),
      directLead('lead-02', IDS.longEligible, 'https://example.test/b'),
    ],
  };
  const db = new FakeDiscoveryPool(input, {}, selection);
  db.sources.set(IDS.digestEligible, sourceRow(IDS.digestEligible, 'A body', null));
  db.sources.set(IDS.longEligible, sourceRow(IDS.longEligible, 'B body', null));

  let firstAttempt = true;
  const firstResult = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    request: async (request) => {
      const payload = JSON.parse(request.input) as { candidates: Array<{ candidateId: string }> };
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('timeout');
      }
      return llmResponse({
        evaluations: [evaluation(payload.candidates[0]!.candidateId, 'qualified')],
      });
    },
  });
  const idsAfterFailure = db.candidates.map((candidate) => candidate.id);
  const firstD4State = (db.run.execution_state as Record<string, Record<string, unknown>>).d4;
  const failedCandidate = db.candidates[0];
  const completedCandidate = db.candidates[1];
  const retriedCandidateIds: string[] = [];
  const retryResult = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
    provider: 'openai',
    request: async (request) => {
      const payload = JSON.parse(request.input) as { candidates: Array<{ candidateId: string }> };
      retriedCandidateIds.push(...payload.candidates.map((candidate) => candidate.candidateId));
      return llmResponse({
        evaluations: payload.candidates.map((candidate) =>
          evaluation(candidate.candidateId, 'rejected'),
        ),
      });
    },
  });
  const failureDiagnostic = db.diagnostics.find(
    (diagnostic) =>
      diagnostic.candidateId === failedCandidate?.id && diagnostic.requestStatus === 'failed',
  );
  const successDiagnostic = db.diagnostics.find(
    (diagnostic) =>
      diagnostic.candidateId === completedCandidate?.id && diagnostic.status === undefined,
  );
  checks.push([
    'D4 isolates a failed Candidate, records per-request diagnostics, and resume reuses only the discovered Candidate',
    firstResult.failedRequestCount === 1 &&
      firstResult.successfulRequestCount === 1 &&
      firstD4State?.status === 'failed' &&
      !firstResult.tokenUsageComplete &&
      idsAfterFailure.length === 2 &&
      db.candidates.length === 2 &&
      idsAfterFailure.every((id) => db.candidates.some((candidate) => candidate.id === id)) &&
      completedCandidate?.status === 'selected' &&
      completedCandidate.evaluation?.decision === 'qualified' &&
      failedCandidate?.status === 'rejected' &&
      retriedCandidateIds.length === 1 &&
      retriedCandidateIds[0] === failedCandidate?.id &&
      retryResult.successfulRequestCount === 1 &&
      retryResult.failedRequestCount === 0 &&
      (db.run.execution_state as Record<string, Record<string, unknown>>).d4?.status ===
        'completed' &&
      (
        (db.run.execution_state as Record<string, Record<string, unknown>>).d4?.usage as {
          requests?: number | null;
          inputTokens?: number | null;
          cachedInputTokens?: number | null;
          usageComplete?: boolean;
        }
      )?.requests === 3 &&
      (
        (db.run.execution_state as Record<string, Record<string, unknown>>).d4?.usage as {
          inputTokens?: number | null;
          cachedInputTokens?: number | null;
          usageComplete?: boolean;
        }
      )?.inputTokens === 2 &&
      (
        (db.run.execution_state as Record<string, Record<string, unknown>>).d4?.usage as {
          cachedInputTokens?: number | null;
        }
      )?.cachedInputTokens === null &&
      (
        (db.run.execution_state as Record<string, Record<string, unknown>>).d4?.usage as {
          usageComplete?: boolean;
        }
      )?.usageComplete === false &&
      failureDiagnostic?.provider === 'openai' &&
      failureDiagnostic?.model === resolveProviderLlmModel('openai') &&
      typeof failureDiagnostic?.requestElapsedMs === 'number' &&
      successDiagnostic?.provider === 'openai',
  ]);
}

async function testDirectDurations() {
  const base = sourceRow(IDS.digestEligible, 'word '.repeat(2000), null);
  assert.equal(resolveDirectDuration(base).minutes, 10);
  assert.equal(
    resolveDirectDuration({
      ...base,
      source_type: 'News Platform',
      metadata: { content_completion: { status: 'success', content_type: 'article_body' } },
    }).minutes,
    10,
  );
  assert.equal(
    resolveDirectDuration({ ...base, source_type: 'unknown', metadata: {} }).minutes,
    null,
  );
  assert.equal(resolveDirectDuration({ ...base, full_content_text: '中'.repeat(800) }).minutes, 2);
  assert.equal(
    resolveDirectDuration({ ...base, full_content_text: '中'.repeat(400) + ' word'.repeat(200) })
      .minutes,
    2,
  );
  assert.equal(resolveDirectDuration({ ...base, metadata: { durationMinutes: 7.2 } }).minutes, 8);
  assert.equal(
    resolveDirectDuration({ ...base, source_type: 'video', metadata: { durationSeconds: 420 } })
      .minutes,
    7,
  );
  assert.equal(
    resolveDirectDuration({ ...base, source_type: 'podcast', metadata: { readingTimeMinutes: 2 } })
      .minutes,
    null,
  );
  assert.equal(resolveDirectDuration({ ...base, source_type: 'video' }).minutes, null);
  assert.equal(
    resolveDirectDuration({ ...base, full_content_text: null, content_text: 'fragment' }).minutes,
    null,
  );
  assert.equal(
    resolveDirectDuration({
      ...base,
      full_content_text: null,
      content_text: 'word '.repeat(400),
      metadata: {
        content_completion: {
          status: 'success',
          content_type: 'article_body',
          full_content_length: 0,
        },
      },
    }).minutes,
    2,
  );
  assert.equal(
    resolveDirectDuration(
      { ...base, full_content_text: null, metadata: { durationMinutes: 0 } },
      12,
    ).minutes,
    12,
  );
  for (const scenario of [
    { name: 'full body', full: 'word '.repeat(2000), metadata: {}, expected: 10 },
    {
      name: 'Daily metadata',
      full: 'word '.repeat(2000),
      metadata: { readingTimeMinutes: 7 },
      expected: 7,
    },
    { name: 'missing body', full: null, metadata: {}, expected: null },
    { name: 'unknown partial', full: null, partial: 'excerpt', metadata: {}, expected: null },
    { name: '30 minutes allowed', full: 'word '.repeat(6000), metadata: {}, expected: 30 },
    { name: 'over 30 body', full: 'word '.repeat(6200), metadata: {}, expected: 31 },
    {
      name: 'over 30 metadata',
      full: 'short body',
      metadata: { durationMinutes: 31 },
      expected: 31,
    },
    {
      name: 'media metadata',
      full: 'transcript',
      metadata: { contentType: 'video', durationSeconds: 900 },
      expected: 15,
    },
    {
      name: 'media unknown',
      full: 'word '.repeat(9000),
      metadata: { contentType: 'podcast' },
      expected: null,
    },
  ]) {
    const input = discoveryWindowFixture();
    const db = new FakeDiscoveryPool(
      input,
      {},
      { leads: [directLead('lead-01', IDS.digestEligible, 'https://example.test/duration')] },
    );
    db.sources.set(IDS.digestEligible, {
      ...sourceRow(IDS.digestEligible, scenario.full, scenario.partial ?? null),
      metadata: scenario.metadata,
    });
    let calls = 0;
    await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
      provider: 'openai',
      request: async (req) => {
        calls++;
        const candidate = JSON.parse(req.input).candidates[0];
        assert.equal(candidate.estimatedDurationMinutes, scenario.expected);
        return llmResponse({ evaluations: [evaluation(candidate.candidateId, 'qualified')] });
      },
    });
    assert.equal(db.candidates[0].estimatedDurationMinutes, scenario.expected, scenario.name);
    const rejected = scenario.expected !== null && scenario.expected > 30;
    assert.equal(calls, (!scenario.full && !scenario.partial) || rejected ? 0 : 1, scenario.name);
    if (rejected) assert.equal(db.candidates[0].status, 'rejected');
  }
  for (const saved of [null, 8, 31]) {
    const input = discoveryWindowFixture();
    const db = new FakeDiscoveryPool(
      input,
      {},
      { leads: [directLead('lead-01', IDS.digestEligible, 'https://example.test/retry-duration')] },
    );
    db.sources.set(IDS.digestEligible, base);
    db.candidates.push({
      id: 'existing-candidate',
      sourceLeadId: 'lead-01',
      sourceContentId: IDS.digestEligible,
      normalizedUrl: 'https://example.test/retry-duration',
      status: 'discovered',
      evaluation: null,
      evidence: {},
      estimatedDurationMinutes: saved,
    });
    let calls = 0;
    await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
      provider: 'openai',
      request: async () => {
        calls++;
        return llmResponse({ evaluations: [evaluation('existing-candidate', 'qualified')] });
      },
    });
    assert.equal(db.candidates.length, 1);
    assert.equal(db.candidates[0].estimatedDurationMinutes, saved ?? 10);
    assert.equal(calls, saved === 31 ? 0 : 1);
    assert.equal(db.candidates[0].status, saved === 31 ? 'rejected' : 'selected');
  }
  checks.push([
    'Direct duration: complete/partial bodies, trusted metadata, media, retry preservation and 30-minute hard checks',
    true,
  ]);
}

function discoveryWindowFixture(): DiscoveryWindowInput {
  const item = (id: string, kind: 'event' | 'digest' | 'long_form', directEligible: boolean) => ({
    id,
    dailyDate: '2026-10-01',
    kind,
    directEligible,
    title: id,
    titleZh: null,
    summary: 'Summary',
    summaryZh: '摘要',
    category: kind === 'digest' ? 'Technology' : null,
    tags: [],
    tagsZh: [],
    sources: ['Source'],
  });
  return {
    dailyDates: ['2026-10-01', '2026-10-02'],
    days: [
      {
        dailyDate: '2026-10-01',
        events: [item(IDS.event, 'event', false)],
        digests: [
          item(IDS.digestEligible, 'digest', true),
          item(IDS.digestIneligible, 'digest', false),
          item(IDS.digestDuplicate, 'digest', true),
        ],
        longForm: [
          item(IDS.longEligible, 'long_form', true),
          item(IDS.longMissingUrl, 'long_form', true),
        ],
      },
      { dailyDate: '2026-10-02', events: [], digests: [], longForm: [] },
    ],
    contentIds: {
      event: [{ dailyDate: '2026-10-01', id: IDS.event }],
      digest: [IDS.digestEligible, IDS.digestIneligible, IDS.digestDuplicate].map((id) => ({
        dailyDate: '2026-10-01',
        id,
      })),
      longForm: [IDS.longEligible, IDS.longMissingUrl].map((id) => ({
        dailyDate: '2026-10-01',
        id,
      })),
    },
  };
}

function directLead(
  leadId: string,
  sourceContentId: string,
  url: string | null,
): DiscoverySelectionOutput['leads'][number] {
  return { leadId, kind: 'direct', sourceContentId, url, rationale: '值得验证' };
}

function d2Direct(sourceContentId: string, rationale: string) {
  return {
    kind: 'direct',
    sourceContentId,
    question: null,
    rationale,
    newsContext: null,
    sourceContentIds: null,
  };
}

function d2Topic(
  question: string,
  rationale: string,
  newsContext: string,
  sourceContentIds: string[],
) {
  return {
    kind: 'topic',
    sourceContentId: null,
    question,
    rationale,
    newsContext,
    sourceContentIds,
  };
}

function evaluation(candidateId: string, decision: string) {
  return {
    candidateId,
    decision,
    reason: `${decision} reason`,
    title_zh: decision === 'qualified' ? '中文标题' : '',
    summary: decision === 'qualified' ? '文章主要论证和细节概要' : '',
    whyWorthReading: decision === 'qualified' ? '适合关注科学方法的读者，具有长期学习价值' : '',
    evidence: ['evidence'],
    limitations: [],
    tags: [{ zh: '科学方法', en: 'Scientific Method' }],
    extra_info: '{}',
  };
}

function hasStrictD2TransportSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  const leads = schema.properties;
  if (!leads || typeof leads !== 'object' || Array.isArray(leads)) return false;
  const leadProperty = (leads as Record<string, unknown>).leads;
  if (!leadProperty || typeof leadProperty !== 'object' || Array.isArray(leadProperty))
    return false;
  const items = (leadProperty as Record<string, unknown>).items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return false;
  const lead = items as Record<string, unknown>;
  return (
    !Object.hasOwn(lead, 'oneOf') &&
    lead.additionalProperties === false &&
    Array.isArray(lead.required) &&
    lead.required.length === 6
  );
}

function hasStrictD4TransportSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  const evaluations = schema.properties;
  if (!evaluations || typeof evaluations !== 'object' || Array.isArray(evaluations)) return false;
  const evaluationProperty = (evaluations as Record<string, unknown>).evaluations;
  if (
    !evaluationProperty ||
    typeof evaluationProperty !== 'object' ||
    Array.isArray(evaluationProperty)
  ) {
    return false;
  }
  const items = (evaluationProperty as Record<string, unknown>).items;
  if (!items || typeof items !== 'object' || Array.isArray(items)) return false;
  const evaluation = items as Record<string, unknown>;
  const properties = evaluation.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  const extraInfo = (properties as Record<string, unknown>).extra_info;
  return (
    evaluation.additionalProperties === false &&
    !Object.hasOwn(evaluation, 'oneOf') &&
    !!extraInfo &&
    typeof extraInfo === 'object' &&
    !Array.isArray(extraInfo) &&
    (extraInfo as Record<string, unknown>).type === 'string'
  );
}

function llmResponse(output: unknown) {
  return {
    id: 'response-test',
    output_text: JSON.stringify(output),
    output: [],
    api_mode: 'chat_completions' as const,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_input_tokens: 0 },
    finish_reason: 'stop',
  };
}

function sourceRow(sourceContentId: string, full: string | null, partial: string | null) {
  return {
    source_content_id: sourceContentId,
    raw_article_id: `${sourceContentId.slice(0, -1)}9`,
    routing: 'digest',
    database_url: `https://example.test/${sourceContentId}`,
    title: 'Title',
    author: 'Author',
    published_at: '2026-10-01T00:00:00.000Z',
    content_text: partial,
    full_content_text: full,
    metadata: {},
    image_url: 'https://example.test/article-cover.jpg',
    source_name: 'Source',
    source_type: 'article',
  };
}

function throws(callback: () => unknown): boolean {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

type FakeCandidate = {
  category?: string | null;
  id: string;
  sourceLeadId: string;
  sourceContentId: string;
  normalizedUrl: string | null;
  status: string;
  evaluation: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  titleZh?: unknown;
  summary?: unknown;
  whyWorthReading?: unknown;
  publication?: unknown;
  estimatedDurationMinutes?: number | null;
};

class FakeDiscoveryPool {
  memories: Memory[] = [];
  memoryReads = 0;
  memoryError = false;
  checkpointError = false;
  checkpointWrites = 0;
  failSelectionOnce = false;
  diagnosticError = false;
  readonly candidates: FakeCandidate[] = [];
  readonly reviewCandidateIds = new Set<string>();
  readonly diagnostics: Array<Record<string, unknown>> = [];
  readonly sources = new Map<string, ReturnType<typeof sourceRow>>();
  readonly historicalUrls = new Set<string>();
  readonly sourceUrls: Record<string, string | null>;
  readonly run: Record<string, unknown> & {
    selection_output: DiscoverySelectionOutput | null;
    config_snapshot: Record<string, unknown> | null;
  };

  constructor(
    input: DiscoveryWindowInput,
    sourceUrls: Record<string, string | null>,
    selection: DiscoverySelectionOutput | null = null,
  ) {
    this.sourceUrls = sourceUrls;
    this.run = {
      id: RUN_ID,
      parent_run_id: null,
      source_lead_id: null,
      run_type: 'regular',
      trigger_source: 'manual',
      status: 'running',
      end_reason: null,
      window_start_date: input.dailyDates[0],
      window_end_date: input.dailyDates[1],
      input_content_ids: input.contentIds,
      selection_output: selection,
      config_snapshot: null,
      started_at: '2026-10-16T00:00:00.000Z',
      finished_at: null,
      error_summary: null,
      created_at: '2026-10-16T00:00:00.000Z',
      updated_at: '2026-10-16T00:00:00.000Z',
    };
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount?: number }> {
    if (text.includes('from memories')) {
      this.memoryReads++;
      if (this.memoryError) throw new Error('Memory database unavailable');
      assert.match(text, /where enabled = true and type = any\(\$1::text\[\]\)/);
      assert.match(text, /order by priority desc, created_at desc, id desc/);
      return {
        rows: this.memories
          .filter((m) => m.enabled && (values[0] as string[]).includes(m.type))
          .sort(
            (a, b) =>
              b.priority - a.priority ||
              Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
              b.id.localeCompare(a.id),
          ),
      };
    }
    if (text === 'select name, url from sources order by name') return { rows: [] };
    if (text.trim() === 'begin' || text.trim() === 'commit' || text.trim() === 'rollback') {
      return { rows: [] };
    }
    if (text.includes('from discovery_runs where id')) return { rows: [this.run] };
    if (text.includes("'{d2Response}'")) {
      if (this.checkpointError) throw new Error('Mock raw response persistence failure');
      if (this.run.selection_output || this.run.status !== 'running')
        return { rows: [], rowCount: 0 };
      assert.match(text, /execution_state = jsonb_set/);
      this.checkpointWrites++;
      this.run.config_snapshot = {
        ...(this.run.config_snapshot ?? {}),
        d2Response: JSON.parse(String(values[1])),
      };
      this.run.execution_state = {
        ...((this.run.execution_state ?? {}) as object),
        d2: JSON.parse(String(values[2])),
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set selection_output =')) {
      if (this.failSelectionOnce) {
        this.failSelectionOnce = false;
        throw new Error('Mock selection persistence failure');
      }
      this.run.selection_output = JSON.parse(String(values[1])) as DiscoverySelectionOutput;
      this.run.config_snapshot = {
        ...(this.run.config_snapshot ?? {}),
        d2: JSON.parse(String(values[2])) as Record<string, unknown>,
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("'{d4}'")) {
      this.run.config_snapshot = {
        ...(this.run.config_snapshot ?? {}),
        d4: JSON.parse(String(values[1])) as Record<string, unknown>,
      };
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set execution_state = jsonb_set')) {
      const branch = String(values[1]);
      const executionState = (this.run.execution_state ?? {}) as Record<string, unknown>;
      executionState[branch] = JSON.parse(String(values[2])) as Record<string, unknown>;
      this.run.execution_state = executionState;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('select pc.id, ra.url')) {
      return {
        rows: (values[0] as string[]).map((id) => ({ id, url: this.sourceUrls[id] ?? null })),
      };
    }
    if (text.includes('insert into discovery_trace_spans')) {
      if (this.diagnosticError) throw new Error('Mock trace database failure');
      this.diagnostics.push(JSON.parse(String(values[7])) as Record<string, unknown>);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('pc.raw_article_id') && text.includes('ra.full_content_text')) {
      return {
        rows: (values[0] as string[]).flatMap((id) => {
          const source = this.sources.get(id);
          return source ? [source] : [];
        }),
      };
    }
    if (text.includes('source_lead_id = any')) {
      const leadIds = new Set(values[1] as string[]);
      return {
        rows: this.candidates
          .filter((candidate) => leadIds.has(candidate.sourceLeadId))
          .map(toCandidateRow),
      };
    }
    if (text.includes('select distinct normalized_url')) {
      return {
        rows: [...this.historicalUrls]
          .filter((url) => (values[1] as string[]).includes(url))
          .map((normalized_url) => ({ normalized_url })),
      };
    }
    if (text.includes('insert into discovery_candidates')) {
      this.candidates.push({
        id: String(values[0]),
        sourceContentId: String(values[2]),
        sourceLeadId: String(values[3]),
        normalizedUrl: values[5] === null ? null : String(values[5]),
        publication: values[8],
        estimatedDurationMinutes: values[11] as number | null,
        evaluation: values[13] ? (JSON.parse(String(values[13])) as Record<string, unknown>) : null,
        evidence: JSON.parse(String(values[12])) as Record<string, unknown>,
        status: String(values[14]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set estimated_duration_minutes')) {
      assert.match(text, /when estimated_duration_minutes > 0/);
      const candidate = this.candidates.find((row) => row.id === values[0]);
      if (!candidate || candidate.status !== 'discovered') return { rows: [], rowCount: 0 };
      if (!candidate.estimatedDurationMinutes || candidate.estimatedDurationMinutes < 0)
        candidate.estimatedDurationMinutes = values[1] as number | null;
      Object.assign(candidate.evidence, JSON.parse(String(values[2])));
      if (values[3]) {
        candidate.status = String(values[3]);
        assert.match(text, /coalesce\(evaluation, '\{\}'::jsonb\) \|\| \$5::jsonb/);
        candidate.evaluation = { ...candidate.evaluation, ...JSON.parse(String(values[4])) };
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set evaluation =')) {
      const candidate = this.candidates.find((row) => row.id === values[0]);
      if (candidate && candidate.status === 'discovered') {
        candidate.titleZh = values[5];
        candidate.summary = values[6];
        candidate.whyWorthReading = values[7];
        assert.match(text, /evaluation @> '\{"categoryManuallySet":true\}'::jsonb/);
        if (candidate.evaluation?.categoryManuallySet !== true)
          candidate.category = (values[8] as string | null) ?? candidate.category ?? null;
        candidate.evaluation = { ...candidate.evaluation, ...JSON.parse(String(values[1])) };
        candidate.evidence = JSON.parse(String(values[2])) as Record<string, unknown>;
        candidate.status = String(values[4]);
      }
      return { rows: [], rowCount: candidate ? 1 : 0 };
    }
    if (text.includes("evaluation->>'decision' = 'qualified'")) {
      return {
        rows: this.candidates
          .filter((candidate) => candidate.evaluation?.decision === 'qualified')
          .map(toCandidateRow),
      };
    }
    if (text.includes("set status = 'selected'")) {
      const candidate = this.candidates.find((row) => row.id === values[0]);
      if (candidate) candidate.status = 'selected';
      return { rows: [], rowCount: candidate ? 1 : 0 };
    }
    if (text.includes('insert into in_depth_candidates')) {
      this.reviewCandidateIds.add(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("group by evaluation->>'decision'")) {
      const counts = new Map<string, number>();
      for (const candidate of this.candidates) {
        const decision = candidate.evaluation?.decision;
        if (typeof decision === 'string') counts.set(decision, (counts.get(decision) ?? 0) + 1);
      }
      return {
        rows: [...counts].map(([decision, count]) => ({ decision, count: String(count) })),
      };
    }
    throw new Error(`Unexpected test SQL: ${text}`);
  }
}

function toCandidateRow(candidate: FakeCandidate) {
  return {
    id: candidate.id,
    source_lead_id: candidate.sourceLeadId,
    status: candidate.status,
    evaluation: candidate.evaluation,
    estimated_duration_minutes: candidate.estimatedDurationMinutes ?? null,
  };
}

async function testD4Categories() {
  for (const scenario of ['ai', 'legacy', 'manual', 'clear', 'concurrent', 'precheck'] as const) {
    const db = new FakeDiscoveryPool(
      discoveryWindowFixture(),
      {},
      {
        leads: [directLead('lead-01', IDS.digestEligible, 'https://example.test/category')],
      },
    );
    db.sources.set(IDS.digestEligible, sourceRow(IDS.digestEligible, 'word '.repeat(2000), null));
    db.candidates.push({
      id: 'existing-candidate',
      sourceLeadId: 'lead-01',
      sourceContentId: IDS.digestEligible,
      normalizedUrl: 'https://example.test/category',
      status: 'discovered',
      evidence: {},
      estimatedDurationMinutes: scenario === 'precheck' ? 31 : 10,
      category: scenario === 'clear' ? null : 'history',
      evaluation: { categoryManuallySet: ['manual', 'clear', 'precheck'].includes(scenario) },
    });
    const result = await runDiscoveryD4(db as unknown as Pool, RUN_ID, {
      provider: 'openai',
      request: async () => {
        if (scenario === 'concurrent') {
          db.candidates[0]!.category = null;
          db.candidates[0]!.evaluation = { categoryManuallySet: true };
        }
        return llmResponse({
          evaluations: [
            {
              ...evaluation('existing-candidate', 'qualified'),
              ...(scenario === 'legacy' ? {} : { category: 'technology' }),
            },
          ],
        });
      },
    });
    assert.equal(result.failedRequestCount, 0, scenario);
    const row = db.candidates[0]!;
    assert.equal(
      row.category,
      scenario === 'ai'
        ? 'technology'
        : ['clear', 'concurrent'].includes(scenario)
          ? null
          : 'history',
      scenario,
    );
    assert.equal(
      row.evaluation?.categoryManuallySet,
      ['manual', 'clear', 'concurrent', 'precheck'].includes(scenario),
      scenario,
    );
  }
  checks.push([
    'D4 Category generation, legacy omission, retry/precheck and concurrent human classification protection',
    true,
  ]);
}

testDiscoveryLlmConfig();
testD2Validation();
await testD2PersistenceAndUrlEnrichment();
await testD2Memories();
await testD2ResponseRecovery();
testD4OutputValidation();
await testD4PrechecksAndPersistence();
await testD4SerialPerCandidateRequests();
await testD4FailureRecovery();
await testD4MissingReaderFields();
await testDirectDurations();
await testD4Categories();

const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) process.exitCode = 1;
