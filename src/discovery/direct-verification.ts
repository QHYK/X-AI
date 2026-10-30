import { withPromptBindings, databasePromptBinder } from '../lib/prompts/runtime.js';
import { productionPrompt } from '../lib/prompts/runtime.js';
import {
  IN_DEPTH_CATEGORIES,
  parseAiCategory,
  type InDepthCategory,
} from '../lib/in-depth-category.js';
import { loadDiscoverySources } from '../lib/discovery-source-list.js';
import { publicationFromMetadata, resolveDiscoveryPublication } from '../lib/discovery-source.js';
// D4
// 验证 D2 选出的 Direct Leads，判断 qualified/rejected/unverifiable，并持久化结果
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  DiscoveryTagsSchema,
  discoveryTagsJsonSchema,
  type DiscoveryTag,
} from '../lib/discovery-content-metadata.js';
import { coverFromRawArticle } from './article-cover.js';
import {
  createLlmClient,
  resolveProviderLlmModel,
  type LlmProvider,
  type LlmResponse,
} from '../processing/llm-client.js';
import { normalizeArticleUrl } from '../processing/url-normalization.js';
import {
  buildDiscoveryD4UserPrompt,
  DISCOVERY_D4_PROMPT_VERSION,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
  type DiscoveryD4PromptCandidate,
} from '../prompts/discovery-direct-verification.js';
import { recordDiscoveryDiagnostic } from './diagnostics.js';
import {
  resolveDiscoveryLlmProvider,
  resolveDiscoveryLlmTimeout,
  toDiscoveryRequestOptions,
} from './llm-config.js';
import {
  buildDiscoveryStageState,
  emptyDiscoveryStageUsage,
  initialDiscoveryStageState,
  mergeDiscoveryStageUsage,
  missingDiscoveryStageUsage,
  stageHasHistoricConfig,
  usageFromLlmResponse,
} from './execution-diagnostics.js';
import { getDiscoveryRun, updateDiscoveryBranchExecutionState } from './run-service.js';
import type { DiscoveryStageUsage } from '../db/schema.js';
import type { DiscoveryDirectLead, DiscoverySelectionOutput } from './topic-selection.js';

export type DiscoveryD4Decision = 'qualified' | 'rejected' | 'unverifiable';

export type DiscoveryD4Evaluation = {
  candidateId: string;
  decision: DiscoveryD4Decision;
  reason: string;
  titleZh: string;
  summary: string;
  whyWorthReading: string;
  evidence: string[];
  limitations: string[];
  tags: DiscoveryTag[];
  category?: InDepthCategory | null;
  extraInfo: Record<string, unknown>;
};

type DiscoveryD4Request = {
  model: string;
  instructions?: string;
  input: string;
  max_output_tokens: number;
  store: boolean;
  text: {
    format: {
      type: 'json_schema';
      name: string;
      description: string;
      schema: typeof discoveryD4OutputJsonSchema;
      strict: true;
    };
  };
};

export type RunDiscoveryD4Options = {
  provider?: LlmProvider;
  timeoutMs?: number;
  request?: (request: DiscoveryD4Request, options: { timeout?: number }) => Promise<LlmResponse>;
};

export type RunDiscoveryD4Result = {
  provider: LlmProvider;
  model: string;
  apiModes: LlmResponse['api_mode'][];
  requestElapsedMs: number;
  timeoutMs: number | undefined;
  evaluated: number;
  qualified: number;
  rejected: number;
  unverifiable: number;
  skippedMissingUrl: number;
  submittedForReview: number;
  requestCount: number;
  successfulRequestCount: number;
  failedRequestCount: number;
  successfulRequestElapsedMs: number;
  failedRequestElapsedMs: number;
  failures: DiscoveryD4CandidateFailure[];
  tokenUsage: LlmResponse['usage'] | null;
  tokenUsageComplete: boolean;
  usage: DiscoveryStageUsage;
};

export type DiscoveryD4CandidateFailure = {
  candidateId: string;
  leadId: string;
  error: string;
  requestElapsedMs: number;
};

type DirectSourceRow = {
  source_content_id: string;
  raw_article_id: string;
  routing: string;
  database_url: string | null;
  title: string;
  author: string | null;
  published_at: Date | string | null;
  content_text: string | null;
  full_content_text: string | null;
  metadata: Record<string, unknown> | null;
  image_url?: string | null;
  source_name: string;
  source_type: string | null;
};

type CandidateRow = {
  id: string;
  source_lead_id: string;
  status: string;
  evaluation: Record<string, unknown> | null;
  estimated_duration_minutes: number | null;
};

type PreparedCandidate = {
  id: string;
  lead: DiscoveryDirectLead;
  source: DirectSourceRow;
  prompt: DiscoveryD4PromptCandidate;
  durationVerification: DirectDuration['verification'];
};

export const discoveryD4OutputJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['evaluations'],
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'candidateId',
          'decision',
          'reason',
          'title_zh',
          'summary',
          'whyWorthReading',
          'evidence',
          'limitations',
          'tags',
          'category',
          'extra_info',
        ],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          decision: {
            type: 'string',
            enum: ['qualified', 'rejected', 'unverifiable'],
          },
          title_zh: { type: 'string' },
          summary: { type: 'string' },
          whyWorthReading: { type: 'string' },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'array', items: { type: 'string' } },
          tags: discoveryTagsJsonSchema,
          category: { type: ['string', 'null'], enum: [...IN_DEPTH_CATEGORIES, null] },
          extra_info: {
            type: 'string',
            description: 'A JSON-serialized object. Use "{}" when no extra information applies.',
          },
        },
      },
    },
  },
} as const;

export async function runDiscoveryD4(
  pool: Pool,
  runId: string,
  options: RunDiscoveryD4Options = {},
): Promise<RunDiscoveryD4Result> {
  return withPromptBindings(pool, databasePromptBinder(pool, 'discovery', runId), () =>
    runDiscoveryD4Bound(pool, runId, options),
  );
}
async function runDiscoveryD4Bound(
  pool: Pool,
  runId: string,
  options: RunDiscoveryD4Options = {},
): Promise<RunDiscoveryD4Result> {
  const run = await getDiscoveryRun(pool, runId);
  const prior = initialDiscoveryStageState(
    run?.executionState.d4,
    stageHasHistoricConfig(run?.configSnapshot, 'd4'),
  );
  const stageStartedAt = Date.now();
  await updateDiscoveryBranchExecutionState(pool, runId, 'd4', {
    ...buildDiscoveryStageState({
      status: 'running',
      endReason: null,
      errorSummary: null,
      metadata: { provider: null, model: null, apiMode: null },
      prior,
    }),
  });
  try {
    const result = await executeDiscoveryD4(pool, runId, options);
    await updateDiscoveryBranchExecutionState(
      pool,
      runId,
      'd4',
      buildDiscoveryStageState({
        status: result.failures.length > 0 ? 'failed' : 'completed',
        endReason:
          result.failures.length > 0
            ? 'error'
            : result.submittedForReview > 0
              ? 'candidates_found'
              : 'no_candidates',
        errorSummary:
          result.failures.length > 0
            ? `${result.failures.length} D4 candidate evaluation request(s) failed.`
            : null,
        metadata: {
          provider: result.provider,
          model: result.model,
          apiMode: result.apiModes.length === 1 ? result.apiModes[0] : 'chat_completions',
        },
        prior,
        attemptUsage: result.usage,
        attemptElapsedMs: Date.now() - stageStartedAt,
        completedAt: new Date().toISOString(),
      }),
    );
    return result;
  } catch (error) {
    await updateDiscoveryBranchExecutionState(
      pool,
      runId,
      'd4',
      buildDiscoveryStageState({
        status: 'failed',
        endReason: 'error',
        errorSummary: toErrorMessage(error),
        metadata: { provider: null, model: null, apiMode: null },
        prior,
        attemptElapsedMs: Date.now() - stageStartedAt,
        completedAt: new Date().toISOString(),
      }),
    );
    throw error;
  }
}

async function executeDiscoveryD4(
  pool: Pool,
  runId: string,
  options: RunDiscoveryD4Options,
): Promise<RunDiscoveryD4Result> {
  const run = await getDiscoveryRun(pool, runId);
  if (!run || run.status !== 'running' || !run.selectionOutput) {
    throw new Error('D4 requires a running Discovery Run with persisted D2 output.');
  }
  const selection = parsePersistedSelection(run.selectionOutput);
  const directLeads = selection.leads.filter(
    (lead): lead is DiscoveryDirectLead => lead.kind === 'direct',
  );
  const provider = resolveDiscoveryLlmProvider('d4', options.provider);
  const model = resolveProviderLlmModel(provider);
  const timeoutMs = resolveDiscoveryLlmTimeout('d4', options.timeoutMs);
  await persistD4Config(pool, runId, { provider, model, timeoutMs });

  const sourceRows = await loadDirectSources(
    pool,
    directLeads.map((lead) => lead.sourceContentId),
  );
  const sourcesById = new Map(sourceRows.map((row) => [row.source_content_id, row]));
  const existing = await loadExistingCandidates(
    pool,
    runId,
    directLeads.map((lead) => lead.leadId),
  );
  const existingByLead = new Map(existing.map((row) => [row.source_lead_id, row]));
  const historicalUrls = await loadHistoricalNormalizedUrls(
    pool,
    runId,
    directLeads.flatMap((lead) => {
      const normalized = normalizeArticleUrl(lead.url);
      return normalized ? [normalized] : [];
    }),
  );
  const currentUrls = new Set<string>();
  const prepared: PreparedCandidate[] = [];
  let skippedMissingUrl = 0;

  for (const lead of directLeads) {
    if (!lead.url) {
      skippedMissingUrl += 1;
      continue;
    }
    const source = sourcesById.get(lead.sourceContentId);
    if (!source) {
      await recordDiscoveryDiagnostic(pool, {
        runId,
        name: 'd4_source_check',
        status: 'failed',
        payload: {
          leadId: lead.leadId,
          sourceContentId: lead.sourceContentId,
          reason: 'missing_source_content',
        },
      });
      continue;
    }

    const normalizedUrl = normalizeArticleUrl(lead.url);
    const invalidUrl = !isHttpUrl(lead.url);
    const duplicateReason = normalizedUrl
      ? historicalUrls.has(normalizedUrl)
        ? 'historical_duplicate_url'
        : currentUrls.has(normalizedUrl)
          ? 'duplicate_url_in_run'
          : null
      : null;
    if (normalizedUrl) currentUrls.add(normalizedUrl);

    const prior = existingByLead.get(lead.leadId);
    if (prior && prior.status !== 'discovered') continue;

    const selectedContent = selectSourceContent(source);
    const duration = resolveDirectDuration(source, prior?.estimated_duration_minutes);
    const estimatedDurationMinutes = duration.minutes;
    const precheck = invalidUrl
      ? { decision: 'rejected' as const, reason: 'invalid_url' }
      : duplicateReason
        ? { decision: 'rejected' as const, reason: duplicateReason }
        : !selectedContent
          ? { decision: 'unverifiable' as const, reason: 'missing_content' }
          : estimatedDurationMinutes !== null && estimatedDurationMinutes > 30
            ? { decision: 'rejected' as const, reason: 'duration_exceeds_30_minutes' }
            : null;

    const candidateId =
      prior?.id ??
      (await insertDirectCandidate(pool, {
        runId,
        lead,
        source,
        normalizedUrl,
        estimatedDurationMinutes,
        durationVerification: duration.verification,
        precheck,
        selectedContent,
      }));

    if (prior) {
      // Retry may have an old null duration. Never replace a valid saved value with null.
      await pool.query(
        `update discovery_candidates
           set estimated_duration_minutes = case when estimated_duration_minutes > 0
                 then estimated_duration_minutes else $2 end,
               evidence = coalesce(evidence, '{}'::jsonb) || $3::jsonb,
               status = coalesce($4::text, status),
               evaluation = case when $4::text is null then evaluation else coalesce(evaluation, '{}'::jsonb) || $5::jsonb end,
               updated_at = now()
         where id = $1::uuid and status = 'discovered'`,
        [
          prior.id,
          estimatedDurationMinutes,
          JSON.stringify({ durationVerification: duration.verification }),
          precheck?.decision ?? null,
          precheck ? JSON.stringify(precheck) : null,
        ],
      );
    }
    if (precheck || !selectedContent) continue;
    prepared.push({
      id: candidateId,
      lead,
      source,
      durationVerification: duration.verification,
      prompt: {
        candidateId,
        title: source.title,
        author: source.author,
        publication: resolveDiscoveryPublication({
          url: source.database_url,
          metadata: source.metadata,
          dailySource: source.source_name,
        }),
        publishedAt: toIso(source.published_at),
        url: lead.url,
        contentSource: selectedContent.source,
        contentMayBeIncomplete: selectedContent.source === 'content_text',
        estimatedDurationMinutes,
        content: selectedContent.text,
      },
    });
  }

  let requestCount = 0;
  let successfulRequestCount = 0;
  let failedRequestCount = 0;
  let successfulRequestElapsedMs = 0;
  let failedRequestElapsedMs = 0;
  let tokenUsage: LlmResponse['usage'] | null = null;
  let usage = emptyDiscoveryStageUsage();
  let apiModes: LlmResponse['api_mode'][] = [];
  let requestElapsedMs = 0;
  const failures: DiscoveryD4CandidateFailure[] = [];
  if (prepared.length > 0) {
    const client = options.request ? null : createLlmClient({ provider, timeoutMs, maxRetries: 0 });
    const request = options.request ?? client?.structured.create;
    if (!request) throw new Error('D4 LLM request function is unavailable.');
    try {
      for (const candidate of prepared) {
        const startedAt = new Date();
        let responseReceived = false;
        let responseUsage: LlmResponse['usage'] | null = null;
        let responseApiMode: LlmResponse['api_mode'] | null = null;
        let llmRequestElapsedMs = 0;
        requestCount += 1;
        try {
          const result = await requestOneCandidate(candidate, model, timeoutMs, request);
          responseReceived = true;
          responseUsage = result.response.usage ?? null;
          responseApiMode = result.response.api_mode;
          llmRequestElapsedMs = result.requestElapsedMs;
          if (responseUsage) tokenUsage = sumTokenUsage(tokenUsage, responseUsage);
          usage = mergeDiscoveryStageUsage(usage, usageFromLlmResponse(responseUsage));
          apiModes = [...new Set([...apiModes, result.response.api_mode])];

          const evaluation = parseAndValidateDiscoveryD4Output(result.response.output_text, [
            candidate.id,
          ])[0];
          if (!evaluation) throw new Error(`D4 output did not evaluate candidate: ${candidate.id}`);

          await persistD4Evaluations(pool, [candidate], [evaluation]);
          successfulRequestCount += 1;
          successfulRequestElapsedMs += result.requestElapsedMs;
          requestElapsedMs += result.requestElapsedMs;
          await recordDiscoveryDiagnostic(pool, {
            runId,
            name: 'd4_candidate_evaluation',
            status: 'success',
            startedAt,
            endedAt: new Date(),
            payload: {
              candidateId: candidate.id,
              leadId: candidate.lead.leadId,
              provider,
              model,
              timeoutMs: timeoutMs ?? null,
              requestElapsedMs: result.requestElapsedMs,
              apiMode: result.response.api_mode,
              tokenUsage: responseUsage,
              tokenUsageComplete: usageFromLlmResponse(responseUsage).usageComplete,
            },
          });
        } catch (error) {
          const endedAt = new Date();
          const elapsedMs = responseReceived
            ? llmRequestElapsedMs
            : endedAt.getTime() - startedAt.getTime();
          failedRequestCount += 1;
          failedRequestElapsedMs += elapsedMs;
          requestElapsedMs += elapsedMs;
          if (!responseReceived) {
            usage = mergeDiscoveryStageUsage(usage, missingDiscoveryStageUsage());
          }
          const failure = {
            candidateId: candidate.id,
            leadId: candidate.lead.leadId,
            error: toErrorMessage(error),
            requestElapsedMs: elapsedMs,
          };
          failures.push(failure);
          await recordDiscoveryDiagnostic(pool, {
            runId,
            name: 'd4_candidate_evaluation',
            status: 'failed',
            startedAt,
            endedAt,
            payload: {
              ...failure,
              provider,
              model,
              timeoutMs: timeoutMs ?? null,
              apiMode: responseApiMode,
              requestStatus: responseReceived
                ? 'response_received_validation_or_persistence_failed'
                : 'failed',
              tokenUsage: responseUsage,
              tokenUsageComplete: usageFromLlmResponse(responseUsage).usageComplete,
            },
          });
        }
      }
    } finally {
      await client?.close();
    }
  }

  const submittedForReview = await promoteQualifiedDirectCandidates(
    pool,
    runId,
    directLeads.map((lead) => lead.leadId),
  );
  const counts = await loadD4DecisionCounts(pool, runId);
  return {
    provider,
    model,
    apiModes,
    requestElapsedMs,
    timeoutMs,
    evaluated: counts.qualified + counts.rejected + counts.unverifiable,
    ...counts,
    skippedMissingUrl,
    submittedForReview,
    requestCount,
    successfulRequestCount,
    failedRequestCount,
    successfulRequestElapsedMs,
    failedRequestElapsedMs,
    failures,
    tokenUsage,
    tokenUsageComplete: usage.usageComplete,
    usage,
  };
}

export function parseAndValidateDiscoveryD4Output(
  rawOutput: string,
  candidateIds: string[],
): DiscoveryD4Evaluation[] {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(
      `D4 structured output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = requireExactObject(value, ['evaluations'], 'D4 output');
  if (!Array.isArray(root.evaluations)) {
    throw new Error('D4 output.evaluations must be an array.');
  }
  const expected = new Set(candidateIds);
  const seen = new Set<string>();
  const evaluations = root.evaluations.map((item, index) => {
    const evaluation = requireAllowedObject(
      item,
      [
        'candidateId',
        'decision',
        'reason',
        'evidence',
        'limitations',
        'tags',
        'category',
        'extra_info',
        'title_zh',
        'summary',
        'whyWorthReading',
      ],
      [
        'candidateId',
        'decision',
        'reason',
        'evidence',
        'limitations',
        'tags',
        'title_zh',
        'summary',
        'whyWorthReading',
      ],
      `D4 evaluation ${index + 1}`,
    );
    const candidateId = requireNonEmptyString(evaluation.candidateId, 'candidateId');
    if (!expected.has(candidateId)) {
      throw new Error(`D4 output references unknown candidate ID: ${candidateId}`);
    }
    if (seen.has(candidateId)) {
      throw new Error(`D4 output repeats candidate ID: ${candidateId}`);
    }
    seen.add(candidateId);
    const decision = evaluation.decision;
    if (decision !== 'qualified' && decision !== 'rejected' && decision !== 'unverifiable') {
      throw new Error(`D4 evaluation ${candidateId} has an invalid decision.`);
    }
    const readerField = (field: string): string => {
      const text = evaluation[field];
      if (typeof text !== 'string') throw new Error(`D4 ${field} must be a string.`);
      if (decision === 'qualified' && (!text.trim() || !/[\p{Script=Han}]/u.test(text))) {
        throw new Error(`D4 qualified ${candidateId} requires Chinese ${field}.`);
      }
      return text.trim();
    };
    return {
      titleZh: readerField('title_zh'),
      summary: readerField('summary'),
      whyWorthReading: readerField('whyWorthReading'),
      candidateId,
      decision: decision as DiscoveryD4Decision,
      reason: requireNonEmptyString(evaluation.reason, 'reason'),
      evidence: requireStringArray(evaluation.evidence, 'evidence'),
      limitations: requireStringArray(evaluation.limitations, 'limitations'),
      tags: DiscoveryTagsSchema.parse(evaluation.tags),
      category: parseAiCategory(evaluation.category),
      extraInfo: normalizeExtraInfo(evaluation.extra_info),
    };
  });
  const missing = candidateIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`D4 output is missing candidate IDs: ${missing.join(', ')}`);
  }
  return evaluations;
}

function parsePersistedSelection(value: Record<string, unknown>): DiscoverySelectionOutput {
  if (!Array.isArray(value.leads)) {
    throw new Error('Persisted D2 selection_output.leads is invalid.');
  }
  const leads = value.leads.map((raw, index) => {
    const lead = requireObject(raw, `Persisted D2 lead ${index + 1}`);
    const leadId = requireNonEmptyString(lead.leadId, 'leadId');
    if (lead.kind === 'direct') {
      return {
        leadId,
        kind: 'direct' as const,
        sourceContentId: requireNonEmptyString(lead.sourceContentId, 'sourceContentId'),
        url: lead.url === null ? null : requireNonEmptyString(lead.url, 'url'),
        rationale: requireNonEmptyString(lead.rationale, 'rationale'),
      };
    }
    if (lead.kind === 'topic') {
      return {
        leadId,
        kind: 'topic' as const,
        question: requireNonEmptyString(lead.question, 'question'),
        rationale: requireNonEmptyString(lead.rationale, 'rationale'),
        newsContext: requireNonEmptyString(lead.newsContext, 'newsContext'),
        sourceContentIds: requireStringArray(lead.sourceContentIds, 'sourceContentIds'),
      };
    }
    throw new Error(`Persisted D2 lead ${leadId} has an invalid kind.`);
  });
  return { leads };
}

async function loadDirectSources(pool: Pool, contentIds: string[]): Promise<DirectSourceRow[]> {
  if (contentIds.length === 0) return [];
  const result = await pool.query<DirectSourceRow>(
    `select
        pc.id as source_content_id,
        pc.raw_article_id,
        pc.routing,
        ra.url as database_url,
        ra.title,
        ra.author,
        ra.published_at,
        ra.content_text,
        ra.full_content_text,
        ra.metadata,
        ra.image_url,
        s.name as source_name,
        s.source_type
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.id = any($1::uuid[])
        and pc.routing in ('digest', 'long_form')`,
    [contentIds],
  );
  const sources = result.rows.length ? await loadDiscoverySources(pool) : [];
  return result.rows.map((source) => ({
    ...source,
    source_name: resolveDiscoveryPublication({
      url: source.database_url,
      metadata: source.metadata,
      dailySource: source.source_name,
      sources,
    }),
  }));
}

async function loadExistingCandidates(
  pool: Pool,
  runId: string,
  leadIds: string[],
): Promise<CandidateRow[]> {
  if (leadIds.length === 0) return [];
  const result = await pool.query<CandidateRow>(
    `select id, source_lead_id, status, evaluation, estimated_duration_minutes
      from discovery_candidates
      where run_id = $1::uuid
        and discovery_path = 'direct'
        and source_lead_id = any($2::text[])
      order by created_at asc, id asc`,
    [runId, leadIds],
  );
  return result.rows;
}

async function loadHistoricalNormalizedUrls(
  pool: Pool,
  runId: string,
  urls: string[],
): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const result = await pool.query<{ normalized_url: string }>(
    `select distinct normalized_url
      from discovery_candidates
      where run_id is distinct from $1::uuid
        and normalized_url = any($2::text[])`,
    [runId, urls],
  );
  return new Set(result.rows.map((row) => row.normalized_url));
}

async function insertDirectCandidate(
  pool: Pool,
  input: {
    runId: string;
    lead: DiscoveryDirectLead;
    source: DirectSourceRow;
    normalizedUrl: string | null;
    estimatedDurationMinutes: number | null;
    durationVerification: DirectDuration['verification'];
    precheck: { decision: 'rejected' | 'unverifiable'; reason: string } | null;
    selectedContent: ReturnType<typeof selectSourceContent>;
  },
): Promise<string> {
  const id = randomUUID();
  const status = input.precheck?.decision ?? 'discovered';
  const evaluation = input.precheck
    ? {
        decision: input.precheck.decision,
        reason: input.precheck.reason,
        limitations: [input.precheck.reason],
      }
    : null;
  const evidence = input.selectedContent
    ? {
        contentSource: input.selectedContent.source,
        contentMayBeIncomplete: input.selectedContent.source === 'content_text',
        contentLength: Array.from(input.selectedContent.text).length,
        durationVerification: input.durationVerification,
      }
    : {
        contentSource: null,
        contentMayBeIncomplete: true,
        contentLength: 0,
        durationVerification: input.durationVerification,
      };
  await pool.query(
    `insert into discovery_candidates (
        id, run_id, discovery_path, source_content_type, source_content_id,
        source_lead_id, url, normalized_url, title, author, publication,
        content_type, published_at, estimated_duration_minutes, extra_info,
        evidence, evaluation, status
      ) values (
        $1::uuid, $2::uuid, 'direct', 'processed_content', $3::uuid,
        $4, $5, $6, $7, $8, $9,
        $10, $11::timestamptz, $12, '{}'::jsonb,
        $13::jsonb, $14::jsonb, $15
      )`,
    [
      id,
      input.runId,
      input.lead.sourceContentId,
      input.lead.leadId,
      input.lead.url,
      input.normalizedUrl,
      input.source.title,
      input.source.author,
      resolveDiscoveryPublication({
        url: input.lead.url,
        metadata: input.source.metadata,
        dailySource: input.source.source_name,
      }),
      readContentType(input.source),
      toIso(input.source.published_at),
      input.estimatedDurationMinutes,
      JSON.stringify({
        ...evidence,
        coverImage: coverFromRawArticle(
          input.source.image_url,
          input.lead.url ?? '',
          input.source.metadata,
        ),
      }),
      evaluation ? JSON.stringify(evaluation) : null,
      status,
    ],
  );
  return id;
}

async function requestOneCandidate(
  candidate: PreparedCandidate,
  model: string,
  timeoutMs: number | undefined,
  request: NonNullable<RunDiscoveryD4Options['request']>,
): Promise<{
  response: LlmResponse;
  requestElapsedMs: number;
}> {
  const prompt = await productionPrompt(
    'discovery.d4.direct_verification',
    buildDiscoveryD4UserPrompt([candidate.prompt]),
  );
  const requestStartedAt = Date.now();
  const response = await request(
    {
      model,
      ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
      input: prompt.input,
      max_output_tokens: 8_000,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'discovery_direct_verification',
          description: 'Independent editorial evaluation of one Direct candidate.',
          schema: discoveryD4OutputJsonSchema,
          strict: true,
        },
      },
    },
    toDiscoveryRequestOptions(timeoutMs),
  );
  return {
    response,
    requestElapsedMs: Date.now() - requestStartedAt,
  };
}

function sumTokenUsage(
  left: LlmResponse['usage'] | null,
  right: LlmResponse['usage'] | null,
): LlmResponse['usage'] | null {
  if (!left && !right) return null;
  return {
    input_tokens: (left?.input_tokens ?? 0) + (right?.input_tokens ?? 0),
    output_tokens: (left?.output_tokens ?? 0) + (right?.output_tokens ?? 0),
    total_tokens: (left?.total_tokens ?? 0) + (right?.total_tokens ?? 0),
    ...sumCachedInputTokens(left, right),
  };
}

function sumCachedInputTokens(
  left: LlmResponse['usage'] | null,
  right: LlmResponse['usage'] | null,
): Pick<NonNullable<LlmResponse['usage']>, 'cached_input_tokens'> | Record<string, never> {
  if (!left) {
    return typeof right?.cached_input_tokens === 'number'
      ? { cached_input_tokens: right.cached_input_tokens }
      : {};
  }
  if (!right) {
    return typeof left.cached_input_tokens === 'number'
      ? { cached_input_tokens: left.cached_input_tokens }
      : {};
  }
  return typeof left.cached_input_tokens === 'number' &&
    typeof right.cached_input_tokens === 'number'
    ? { cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens }
    : {};
}

async function persistD4Evaluations(
  pool: Pool,
  candidates: PreparedCandidate[],
  evaluations: DiscoveryD4Evaluation[],
): Promise<void> {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const evaluation of evaluations) {
      const candidate = candidateById.get(evaluation.candidateId);
      if (!candidate) throw new Error(`D4 candidate disappeared: ${evaluation.candidateId}`);
      const evidence = {
        contentSource: candidate.prompt.contentSource,
        contentMayBeIncomplete: candidate.prompt.contentMayBeIncomplete,
        contentLength: Array.from(candidate.prompt.content).length,
        durationVerification: candidate.durationVerification,
        sourceMetadata: { publication: publicationFromMetadata(candidate.source.metadata) },
        details: evaluation.evidence,
        limitations: evaluation.limitations,
        coverImage: coverFromRawArticle(
          candidate.source.image_url,
          candidate.prompt.url,
          candidate.source.metadata,
        ),
      };
      const status = evaluation.decision === 'qualified' ? 'evaluated' : evaluation.decision;
      await client.query(
        // Merge evaluation to retain human flags; Category protection is atomic with the write.
        `update discovery_candidates
          set evaluation = coalesce(evaluation, '{}'::jsonb) || $2::jsonb, evidence = $3::jsonb,
              extra_info = $4::jsonb, status = $5,
              title_zh = $6, summary = $7, why_worth_reading = $8,
              category = case when evaluation @> '{"categoryManuallySet":true}'::jsonb
                then category else coalesce($9::text, category) end, updated_at = now()
          where id = $1::uuid and status = 'discovered'`,
        [
          evaluation.candidateId,
          JSON.stringify({
            decision: evaluation.decision,
            reason: evaluation.reason,
            tags: evaluation.tags,
          }),
          JSON.stringify(evidence),
          JSON.stringify(evaluation.extraInfo),
          status,
          evaluation.titleZh || null,
          evaluation.summary || null,
          evaluation.whyWorthReading || null,
          evaluation.category ?? null,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function promoteQualifiedDirectCandidates(
  pool: Pool,
  runId: string,
  leadOrder: string[],
): Promise<number> {
  if (leadOrder.length === 0) return 0;
  const result = await pool.query<CandidateRow>(
    `select id, source_lead_id, status, evaluation, estimated_duration_minutes
      from discovery_candidates
      where run_id = $1::uuid and discovery_path = 'direct'
        and evaluation->>'decision' = 'qualified'`,
    [runId],
  );
  const priority = new Map(leadOrder.map((leadId, index) => [leadId, index]));
  const selected = result.rows
    .sort(
      (left, right) =>
        (priority.get(left.source_lead_id) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.source_lead_id) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 3);
  if (selected.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const candidate of selected) {
      await client.query(
        `update discovery_candidates set status = 'selected', updated_at = now()
          where id = $1::uuid`,
        [candidate.id],
      );
      await client.query(
        `insert into in_depth_candidates (discovery_candidate_id, review_status)
          values ($1::uuid, 'pending')
          on conflict (discovery_candidate_id) do nothing`,
        [candidate.id],
      );
    }
    await client.query('commit');
    return selected.length;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function loadD4DecisionCounts(
  pool: Pool,
  runId: string,
): Promise<{ qualified: number; rejected: number; unverifiable: number }> {
  const result = await pool.query<{ decision: string; count: string }>(
    `select evaluation->>'decision' as decision, count(*)::text as count
      from discovery_candidates
      where run_id = $1::uuid and discovery_path = 'direct' and evaluation is not null
      group by evaluation->>'decision'`,
    [runId],
  );
  const counts = new Map(result.rows.map((row) => [row.decision, Number(row.count)]));
  return {
    qualified: counts.get('qualified') ?? 0,
    rejected: counts.get('rejected') ?? 0,
    unverifiable: counts.get('unverifiable') ?? 0,
  };
}

async function persistD4Config(
  pool: Pool,
  runId: string,
  config: { provider: LlmProvider; model: string; timeoutMs: number | undefined },
): Promise<void> {
  const result = await pool.query(
    `update discovery_runs
      set config_snapshot = jsonb_set(
        coalesce(config_snapshot, '{}'::jsonb),
        '{d4}',
        $2::jsonb,
        true
      ), updated_at = now()
      where id = $1::uuid and status = 'running'`,
    [
      runId,
      JSON.stringify({
        ...config,
        legacyPromptVersion: DISCOVERY_D4_PROMPT_VERSION,
        editorialPromptVersion: DISCOVERY_EDITORIAL_PROMPT_VERSION,
      }),
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error('D4 could not persist config for the running Discovery Run.');
  }
}

function selectSourceContent(source: DirectSourceRow): {
  source: 'full_content_text' | 'content_text';
  text: string;
} | null {
  const full = source.full_content_text?.trim();
  if (full) return { source: 'full_content_text', text: full };
  const partial = source.content_text?.trim();
  return partial ? { source: 'content_text', text: partial } : null;
}

type DirectDuration = {
  minutes: number | null;
  verification:
    'existing_candidate' | 'source_metadata' | 'content_length_estimate' | 'unavailable';
};

/** Direct has no Agent-provided duration: reuse evidence, then estimate only proven article text. */
export function resolveDirectDuration(
  source: DirectSourceRow,
  existingMinutes?: number | null,
): DirectDuration {
  if (
    typeof existingMinutes === 'number' &&
    Number.isInteger(existingMinutes) &&
    existingMinutes > 0
  )
    return { minutes: existingMinutes, verification: 'existing_candidate' };
  const contentType = readContentType(source);
  const metadata = source.metadata ?? {};
  const minuteKeys = [
    'durationMinutes',
    'duration_minutes',
    ...(contentType === 'video' || contentType === 'podcast' ? [] : ['readingTimeMinutes']),
  ];
  for (const key of [...minuteKeys, 'durationSeconds', 'duration_seconds']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const minutes = Math.ceil(
        key.endsWith('Seconds') || key.endsWith('_seconds') ? value / 60 : value,
      );
      if (minutes <= 2147483647) return { minutes, verification: 'source_metadata' };
    }
  }
  if (contentType !== 'article') return { minutes: null, verification: 'unavailable' };
  const completion = metadata.content_completion as Record<string, unknown> | undefined;
  const completeShortBody =
    completion?.status === 'success' &&
    completion.content_type === 'article_body' &&
    completion.full_content_length === 0;
  const text =
    source.full_content_text?.trim() || (completeShortBody ? source.content_text?.trim() : null);
  if (!text) return { minutes: null, verification: 'unavailable' };
  // Deterministic estimate: 200 words/minute, 400 CJK characters/minute; add mixed-language costs.
  // Ignore URL destinations rather than counting long link strings as prose.
  const prose = text.replace(/https?:\/\/\S+/g, ' ');
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
  const characters = prose.match(cjk)?.length ?? 0;
  const words =
    prose.replace(cjk, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  const minutes = Math.ceil(characters / 400 + words / 200);
  return minutes > 0
    ? { minutes, verification: 'content_length_estimate' }
    : { minutes: null, verification: 'unavailable' };
}

function readContentType(source: DirectSourceRow): 'article' | 'video' | 'podcast' | null {
  const candidate =
    source.metadata?.contentType ?? source.metadata?.content_type ?? source.source_type;
  if (candidate === 'article' || candidate === 'video' || candidate === 'podcast') return candidate;
  const completion = source.metadata?.content_completion as Record<string, unknown> | undefined;
  return completion?.content_type === 'article_body' ? 'article' : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function toErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000) || 'Unknown D4 candidate evaluation failure.';
}

function normalizeExtraInfo(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(
        `D4 extra_info must be a JSON-serialized object: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const object = requireObject(parsed, 'D4 extra_info');
  const serialized = JSON.stringify(object);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) {
    throw new Error('D4 extra_info exceeds 16 KiB.');
  }
  return object;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactObject(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  return requireAllowedObject(value, keys, keys, label);
}

function requireAllowedObject(
  value: unknown,
  allowedKeys: string[],
  requiredKeys: string[],
  label: string,
): Record<string, unknown> {
  const object = requireObject(value, label);
  const unknown = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  const missing = requiredKeys.filter((key) => !(key in object));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
  return object;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`D4 ${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`D4 ${label} must be a string array.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
