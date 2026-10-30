import { mockAgentTraceRun } from './test-discovery-trace.js';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { Span, SpanData, Trace } from '@openai/agents';
import { PostgresDiscoveryTracingProcessor } from '../src/discovery/agent-tracing.js';
import {
  discoveryCacheHitRate,
  initialDiscoveryStageState,
  mergeDiscoveryStageUsage,
  missingDiscoveryStageUsage,
  usageFromAgentResponseUsage,
} from '../src/discovery/execution-diagnostics.js';
import type { DiscoveryFetchResult } from '../src/discovery/fetch-content.js';
import {
  DiscoveryD3ExecutionError,
  runDiscoveryD3,
  validateDiscoveryD3Output,
  validateAndPersistDiscoveryAgentCandidates,
  type DiscoveryD3Runtime,
} from '../src/discovery/topic-discovery.js';
import type { DiscoverySelectionOutput } from '../src/discovery/topic-selection.js';

const RUN_ID = '00000000-0000-4000-8000-000000000301';

async function main(): Promise<void> {
  await testSingleAgentRunValidationPersistenceAndResume();
  const traceFailureDb = new FakeD3Pool(selection());
  const traceFailureResult = await runDiscoveryD3(traceFailureDb as unknown as Pool, RUN_ID, {
    runtime: async () =>
      mockAgentTraceRun(
        'd3',
        {
          query: async () => {
            throw new Error('Mock Trace write failure');
          },
        } as unknown as Pool,
        { candidates: [candidate('lead-01', 'https://example.test/trace-failure')] },
        [successfulFetch('https://example.test/trace-failure')],
      ),
  });
  assert.equal(traceFailureResult.traceFlushed, false);
  assert.equal(
    traceFailureDb.reviewCandidateIds.size,
    1,
    'Trace failure must not discard the successfully generated Candidate.',
  );
  assert.equal(traceFailureDb.run.execution_state.d3?.status, 'completed');
  await testOpenSourcePersistence();
  await testNormalEmptyAndFailureReasons();
  await testTracePersistenceAndSanitization();
  testUsageNormalization();
  testOutputContract();
  console.log('Discovery Phase 3 tests passed.');
}

async function testSingleAgentRunValidationPersistenceAndResume(): Promise<void> {
  const db = new FakeD3Pool(selection(), {
    d4: {
      status: 'completed',
      endReason: 'candidates_found',
      completedAt: '2026-10-17T00:00:00.000Z',
    },
  });
  db.addDirectCandidate('https://example.test/duplicate');
  let calls = 0;
  let receivedLeadIds: string[] = [];
  const runtime: DiscoveryD3Runtime = async ({ topicLeads }) => {
    calls += 1;
    receivedLeadIds = topicLeads.map((lead) => lead.leadId);
    return runtimeResult(
      {
        candidates: [
          { ...candidate('lead-01', 'https://example.test/good'), category: 'technology' },
          candidate('lead-02', 'https://example.test/duplicate'),
          candidate('lead-02', 'https://example.test/no-fetch'),
        ],
      },
      [
        successfulFetch('https://example.test/good'),
        successfulFetch('https://example.test/duplicate'),
      ],
    );
  };

  const result = await runDiscoveryD3(db as unknown as Pool, RUN_ID, { runtime });
  assert.equal(calls, 1);
  assert.deepEqual(receivedLeadIds, ['lead-01', 'lead-02']);
  assert.deepEqual(
    {
      selected: result.selectedCount,
      rejected: result.rejectedCount,
      unverifiable: result.unverifiableCount,
    },
    { selected: 1, rejected: 1, unverifiable: 1 },
  );
  assert.equal(db.reviewCandidateIds.size, 1);
  assert.equal(db.candidates.filter((row) => row.path === 'direct').length, 1);
  assert.equal(db.run.execution_state.d4?.status, 'completed');
  assert.equal(db.run.execution_state.d3?.status, 'completed');
  const selected = db.candidates.find((row) => row.path === 'topic' && row.status === 'selected');
  assert.equal(selected?.publication, 'Verified Site');
  assert.equal(selected?.category, 'technology');
  assert.deepEqual(selected?.evaluation?.tags, [{ zh: '科学方法', en: 'Scientific Method' }]);
  assert.equal(
    ((selected?.evidence?.fetch as Record<string, unknown>)?.coverImage as { source?: string })
      ?.source,
    'og:image',
  );

  assert.ok(selected);
  selected.category = null;
  selected.evaluation = { ...selected.evaluation, categoryManuallySet: true };
  const resumed = await runDiscoveryD3(db as unknown as Pool, RUN_ID, { runtime });
  assert.equal(resumed.skipped, true);
  assert.equal(selected.category, null, 'Completed Resume preserves an explicit human clear.');
  assert.equal(selected.evaluation.categoryManuallySet, true);
  assert.equal(calls, 1, 'completed D3 must not call the Agent again');
}

async function testOpenSourcePersistence(): Promise<void> {
  const db = new FakeD3Pool(selection());
  const { validateDiscoveryD5Output } = await import('../src/discovery/open-discovery.js');
  const output = {
    ...candidate('lead-01', 'https://example.test/open'),
    publication: 'Model Publication',
    category: 'history',
  };
  const openOutput = Object.fromEntries(
    Object.entries(output).filter(([key]) => key !== 'sourceLeadId'),
  );
  const candidates = validateDiscoveryD5Output({ candidates: [openOutput] });
  await validateAndPersistDiscoveryAgentCandidates(db as unknown as Pool, {
    runId: RUN_ID,
    stage: 'd5',
    discoveryPath: 'open',
    candidates,
    fetches: [successfulFetch('https://example.test/open')],
    executionState: {
      ...initialDiscoveryStageState(undefined, false),
      errorSummary: null,
      provider: 'codex',
      model: 'mock',
      apiMode: 'responses',
      status: 'completed',
      endReason: 'candidates_found',
      completedAt: '2026-10-19T00:00:00Z',
    },
  });
  assert.equal(
    db.candidates[0]?.publication,
    'Verified Site',
    'D5 model publication must not override verified Fetch Metadata.',
  );
  assert.equal(db.candidates[0]?.status, 'selected');
  assert.equal(db.candidates[0]?.category, 'history');
  assert.equal(db.reviewCandidateIds.size, 1);
}

async function testNormalEmptyAndFailureReasons(): Promise<void> {
  const emptyDb = new FakeD3Pool(selection());
  const empty = await runDiscoveryD3(emptyDb as unknown as Pool, RUN_ID, {
    runtime: async () => runtimeResult({ candidates: [] }, []),
  });
  assert.equal(empty.endReason, 'no_candidates');
  assert.equal(emptyDb.run.execution_state.d3?.status, 'completed');

  const toolFailureDb = new FakeD3Pool(selection());
  await assert.rejects(
    runDiscoveryD3(toolFailureDb as unknown as Pool, RUN_ID, {
      runtime: async () => runtimeResult({ candidates: [] }, [failedFetch('https://bad.test/')]),
    }),
    (error: unknown) =>
      error instanceof DiscoveryD3ExecutionError && error.endReason === 'tool_failure',
  );
  assert.equal(toolFailureDb.run.execution_state.d3?.status, 'failed');
  assert.equal(toolFailureDb.run.execution_state.d3?.endReason, 'tool_failure');
  assert.deepEqual(toolFailureDb.run.execution_state.d3?.usage, {
    requests: 2,
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    usageComplete: true,
  });

  let retryCalls = 0;
  const retry = await runDiscoveryD3(toolFailureDb as unknown as Pool, RUN_ID, {
    runtime: async () => {
      retryCalls += 1;
      return runtimeResult({ candidates: [] }, []);
    },
  });
  assert.equal(retry.skipped, false);
  assert.equal(retryCalls, 1);
  assert.equal(toolFailureDb.run.execution_state.d3?.status, 'completed');

  const timeoutDb = new FakeD3Pool(selection());
  await assert.rejects(
    runDiscoveryD3(timeoutDb as unknown as Pool, RUN_ID, {
      runtime: async () => {
        throw new Error('request timed out');
      },
    }),
    (error: unknown) => error instanceof DiscoveryD3ExecutionError && error.endReason === 'timeout',
  );

  const budgetDb = new FakeD3Pool(selection());
  await assert.rejects(
    runDiscoveryD3(budgetDb as unknown as Pool, RUN_ID, {
      runtime: async () => {
        throw new DiscoveryD3ExecutionError('budget_exhausted', 'max turns');
      },
    }),
    (error: unknown) =>
      error instanceof DiscoveryD3ExecutionError && error.endReason === 'budget_exhausted',
  );
}

async function testTracePersistenceAndSanitization(): Promise<void> {
  const inserts: unknown[][] = [];
  const processor = new PostgresDiscoveryTracingProcessor(
    {
      query: async (_text: string, values: unknown[]) => {
        inserts.push(values);
        return { rows: [], rowCount: 1 } as never;
      },
    } as Pick<Pool, 'query'>,
    RUN_ID,
  );
  const trace = {
    traceId: 'trace_test',
    name: 'D3',
    toJSON: () => ({ trace_id: 'trace_test', metadata: { apiKey: 'secret' } }),
  } as unknown as Trace;
  await processor.onTraceStart(trace);
  await processor.onSpanEnd({
    traceId: 'trace_test',
    spanId: 'span_fetch',
    parentId: null,
    startedAt: '2026-10-17T00:00:00.000Z',
    endedAt: '2026-10-17T00:00:01.000Z',
    error: null,
    spanData: {
      type: 'function',
      name: 'fetch_content',
      input: JSON.stringify({ url: 'https://example.test/work' }),
      output: JSON.stringify({
        url: 'https://example.test/work',
        status: 'success',
        content: 'full body must not be persisted',
        content_length: 5000,
        returned_content_length: 5000,
        content_complete: true,
        truncated: false,
        content_type: 'article_body',
        error: null,
      }),
    },
  } as unknown as Span<SpanData>);
  await processor.onSpanEnd({
    traceId: 'trace_test',
    spanId: 'span_response_2',
    parentId: null,
    startedAt: '2026-10-17T00:00:02.000Z',
    endedAt: '2026-10-17T00:00:03.000Z',
    error: null,
    spanData: {
      type: 'response',
      response_id: 'resp_test_2',
      _response: {
        usage: {
          input_tokens: 40,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 5 },
        },
      },
    },
  } as unknown as Span<SpanData>);
  await processor.onSpanEnd({
    traceId: 'trace_test',
    spanId: 'span_response',
    parentId: null,
    startedAt: '2026-10-17T00:00:01.000Z',
    endedAt: '2026-10-17T00:00:02.000Z',
    error: null,
    spanData: {
      type: 'response',
      response_id: 'resp_test',
      _response: {
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          input_tokens_details: { cached_tokens: 25 },
        },
      },
    },
  } as unknown as Span<SpanData>);
  await processor.onTraceEnd(trace);
  await processor.forceFlush();
  assert.equal(processor.flushCount, 1);
  assert.ok(inserts.length >= 2);
  const serialized = JSON.stringify(inserts);
  assert.equal(serialized.includes('full body must not be persisted'), false);
  assert.equal(serialized.includes('https://example.test/work'), true);
  assert.equal(serialized.includes('secret'), false);
  assert.deepEqual(processor.getUsage(), {
    requests: 2,
    inputTokens: 140,
    outputTokens: 30,
    cachedInputTokens: 30,
    usageComplete: true,
  });
}

function testUsageNormalization(): void {
  const explicitZero = usageFromAgentResponseUsage({
    input_tokens: 10,
    output_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
  });
  assert.equal(explicitZero.cachedInputTokens, 0);
  assert.equal(explicitZero.usageComplete, true);
  assert.equal(discoveryCacheHitRate(explicitZero), 0);

  const camelCase = usageFromAgentResponseUsage({
    inputTokens: 20,
    outputTokens: 3,
    inputTokensDetails: { cached_tokens: 5 },
  });
  const multiple = mergeDiscoveryStageUsage(explicitZero, camelCase);
  assert.equal(multiple.requests, 2);
  assert.equal(multiple.inputTokens, 30);
  assert.equal(multiple.outputTokens, 5);
  assert.equal(multiple.cachedInputTokens, 5);
  assert.equal(discoveryCacheHitRate(multiple), 5 / 30);
  assert.equal(discoveryCacheHitRate({ ...explicitZero, inputTokens: 0 }), null);
  const missingCache = usageFromAgentResponseUsage({ input_tokens: 10, output_tokens: 2 });
  assert.equal(missingCache.cachedInputTokens, null);
  assert.equal(missingCache.usageComplete, false);
  assert.equal(discoveryCacheHitRate(missingCache), null);

  const resumed = mergeDiscoveryStageUsage(
    mergeDiscoveryStageUsage(explicitZero, missingDiscoveryStageUsage()),
    explicitZero,
  );
  assert.deepEqual(resumed, {
    requests: 3,
    inputTokens: 20,
    outputTokens: 4,
    cachedInputTokens: null,
    usageComplete: false,
  });

  const historicMissing = initialDiscoveryStageState(undefined, true);
  assert.deepEqual(historicMissing.usage, {
    requests: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    usageComplete: false,
  });
}

function testOutputContract(): void {
  assert.throws(() =>
    validateDiscoveryD3Output(
      { candidates: [candidate('unknown-lead', 'https://example.test/work')] },
      selection().leads.filter((lead) => lead.kind === 'topic'),
    ),
  );
  assert.throws(() =>
    validateDiscoveryD3Output(
      {
        candidates: Array.from({ length: 4 }, (_, index) =>
          candidate('lead-01', `https://example.test/${index}`),
        ),
      },
      selection().leads.filter((lead) => lead.kind === 'topic'),
    ),
  );
}

function selection(): DiscoverySelectionOutput {
  return {
    leads: [
      {
        leadId: 'lead-01',
        kind: 'topic',
        question: 'Question one?',
        rationale: 'Rationale',
        newsContext: 'Context one',
        sourceContentIds: ['00000000-0000-4000-8000-000000000311'],
      },
      {
        leadId: 'lead-02',
        kind: 'topic',
        question: 'Question two?',
        rationale: 'Rationale',
        newsContext: 'Context two',
        sourceContentIds: ['00000000-0000-4000-8000-000000000312'],
      },
    ],
  };
}

function candidate(sourceLeadId: string, url: string) {
  return {
    sourceLeadId,
    url,
    title: 'Original title',
    title_zh: '中文标题',
    author: 'Author',
    contentType: 'article',
    publishedAt: null,
    estimatedDurationMinutes: 20,
    summary: '中文摘要',
    whyWorthReading: '中文推荐理由',
    evidence: '正文中的具体论点',
    limitations: '',
    tags: [{ zh: '科学方法', en: 'Scientific Method' }],
    extra_info: '{}',
  };
}

function successfulFetch(url: string): DiscoveryFetchResult {
  return {
    url,
    status: 'success',
    content: 'body',
    content_length: 5000,
    returned_content_length: 5000,
    content_complete: true,
    truncated: false,
    content_type: 'article_body',
    cover_image: {
      url: 'https://example.test/article-cover.jpg',
      source: 'og:image',
      width: 1200,
      height: 800,
    },
    metadata: {
      publication: 'Verified Site',
      title: 'Original title',
      author: 'Author',
      published_time: null,
      source_url: url,
      status_code: 200,
    },
    error: null,
  };
}

function failedFetch(url: string): DiscoveryFetchResult {
  return {
    ...successfulFetch(url),
    status: 'error',
    content: '',
    content_length: 0,
    returned_content_length: 0,
    content_complete: false,
    error: 'blocked',
  };
}

function runtimeResult(output: unknown, fetches: DiscoveryFetchResult[]) {
  return {
    output,
    fetches,
    usage: {
      requests: 2,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      usageComplete: true,
    },
    elapsedMs: 50,
    traceIds: ['trace_test'],
    traceFlushed: true,
  };
}

type FakeCandidate = {
  category?: unknown;
  id: string;
  path: 'direct' | 'topic';
  normalizedUrl: string | null;
  status: string;
  publication?: unknown;
  evaluation?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

type FakeBranchState = {
  status: string;
  endReason: string | null;
  completedAt: string | null;
  errorSummary?: string | null;
  usage?: unknown;
};

type FakeRunRow = {
  [key: string]: unknown;
  config_snapshot: Record<string, unknown>;
  execution_state: Record<string, FakeBranchState>;
};

class FakeD3Pool {
  readonly candidates: FakeCandidate[] = [];
  readonly reviewCandidateIds = new Set<string>();
  readonly run: FakeRunRow;

  constructor(
    selectionOutput: DiscoverySelectionOutput,
    executionState: Record<string, FakeBranchState> = {},
  ) {
    this.run = {
      id: RUN_ID,
      parent_run_id: null,
      source_lead_id: null,
      run_type: 'regular',
      trigger_source: 'manual',
      status: 'running',
      end_reason: null,
      window_start_date: '2026-10-15',
      window_end_date: '2026-10-16',
      input_content_ids: { event: [], digest: [], longForm: [] },
      selection_output: selectionOutput,
      config_snapshot: {},
      execution_state: executionState,
      started_at: '2026-10-17T00:00:00.000Z',
      finished_at: null,
      error_summary: null,
      created_at: '2026-10-17T00:00:00.000Z',
      updated_at: '2026-10-17T00:00:00.000Z',
    };
  }

  addDirectCandidate(url: string): void {
    this.candidates.push({
      id: '00000000-0000-4000-8000-000000000399',
      path: 'direct',
      normalizedUrl: url,
      status: 'selected',
    });
  }

  async connect() {
    return { query: this.query.bind(this), release() {} };
  }

  async query(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount?: number }> {
    if (text === 'select name, url from sources order by name') return { rows: [] };
    if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [] };
    if (text.includes('from discovery_runs where id')) return { rows: [this.run] };
    if (text.includes("when coalesce(config_snapshot, '{}'::jsonb) ? 'd3'")) {
      if (!this.run.config_snapshot.d3) {
        this.run.config_snapshot.d3 = JSON.parse(String(values[1])) as Record<string, unknown>;
      }
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set execution_state = jsonb_set')) {
      this.run.execution_state[String(values[1])] = JSON.parse(
        String(values[2]),
      ) as FakeBranchState;
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('select distinct normalized_url')) {
      const requested = new Set(values[0] as string[]);
      return {
        rows: this.candidates
          .filter((row) => row.normalizedUrl && requested.has(row.normalizedUrl))
          .map((row) => ({ normalized_url: row.normalizedUrl })),
      };
    }
    if (text.includes('insert into discovery_candidates')) {
      this.candidates.push({
        id: String(values[0]),
        path: 'topic',
        normalizedUrl: values[6] === null ? null : String(values[6]),
        status: String(values[19]),
        category: values[20],
        evidence: JSON.parse(String(values[17])) as Record<string, unknown>,
        publication: values[10],
        evaluation: JSON.parse(String(values[18])) as Record<string, unknown>,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('insert into in_depth_candidates')) {
      this.reviewCandidateIds.add(String(values[0]));
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("where run_id = $1::uuid and discovery_path = 'topic'")) {
      const counts = new Map<string, number>();
      for (const candidateRow of this.candidates.filter((row) => row.path === 'topic')) {
        counts.set(candidateRow.status, (counts.get(candidateRow.status) ?? 0) + 1);
      }
      return { rows: [...counts].map(([status, count]) => ({ status, count: String(count) })) };
    }
    throw new Error(`Unexpected SQL in D3 test: ${text}`);
  }
}

await main();
