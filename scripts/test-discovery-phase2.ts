import type { Pool } from 'pg';
import { resolveProviderLlmModel } from '../src/processing/llm-client.js';
import {
  parseAndValidateDiscoveryD4Output,
  runDiscoveryD4,
} from '../src/discovery/direct-verification.js';
import type { DiscoveryWindowInput } from '../src/discovery/daily-read-adapter.js';
import {
  parseAndValidateDiscoveryD2Output,
  runDiscoveryD2,
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
    ['D2 accepts an empty result', empty.leads.length === 0],
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
      'D2 rejects Event and directEligible=false Direct references',
      [IDS.event, IDS.digestIneligible].every((sourceContentId) =>
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
        (db.run.config_snapshot?.d2 as { promptVersion?: string })?.promptVersion === 'v2',
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
};

class FakeDiscoveryPool {
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
    if (text === 'select name, url from sources order by name') return { rows: [] };
    if (text.trim() === 'begin' || text.trim() === 'commit' || text.trim() === 'rollback') {
      return { rows: [] };
    }
    if (text.includes('from discovery_runs where id')) return { rows: [this.run] };
    if (text.includes('set selection_output =')) {
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
        evaluation: values[13] ? (JSON.parse(String(values[13])) as Record<string, unknown>) : null,
        evidence: JSON.parse(String(values[12])) as Record<string, unknown>,
        status: String(values[14]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('set evaluation =')) {
      const candidate = this.candidates.find((row) => row.id === values[0]);
      if (candidate && candidate.status === 'discovered') {
        candidate.titleZh = values[5];
        candidate.summary = values[6];
        candidate.whyWorthReading = values[7];
        candidate.evaluation = JSON.parse(String(values[1])) as Record<string, unknown>;
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
  };
}

testDiscoveryLlmConfig();
testD2Validation();
await testD2PersistenceAndUrlEnrichment();
testD4OutputValidation();
await testD4PrechecksAndPersistence();
await testD4SerialPerCandidateRequests();
await testD4FailureRecovery();
await testD4MissingReaderFields();

const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length > 0) process.exitCode = 1;
