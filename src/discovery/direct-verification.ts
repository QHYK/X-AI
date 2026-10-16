import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createLlmClient,
  resolveProviderLlmModel,
  type LlmProvider,
  type LlmResponse,
} from '../processing/llm-client.js';
import { normalizeArticleUrl } from '../processing/url-normalization.js';
import {
  buildDiscoveryD4Instructions,
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
import { getDiscoveryRun, updateDiscoveryBranchExecutionState } from './run-service.js';
import type { DiscoveryDirectLead, DiscoverySelectionOutput } from './topic-selection.js';

export type DiscoveryD4Decision = 'qualified' | 'rejected' | 'unverifiable';

export type DiscoveryD4Evaluation = {
  candidateId: string;
  decision: DiscoveryD4Decision;
  reason: string;
  evidence: string[];
  limitations: string[];
  extraInfo: Record<string, unknown>;
};

type DiscoveryD4Request = {
  model: string;
  instructions: string;
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
  source_name: string;
  source_type: string | null;
};

type CandidateRow = {
  id: string;
  source_lead_id: string;
  status: string;
  evaluation: Record<string, unknown> | null;
};

type PreparedCandidate = {
  id: string;
  lead: DiscoveryDirectLead;
  source: DirectSourceRow;
  prompt: DiscoveryD4PromptCandidate;
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
        required: ['candidateId', 'decision', 'reason', 'evidence', 'limitations', 'extra_info'],
        properties: {
          candidateId: { type: 'string', minLength: 1 },
          decision: {
            type: 'string',
            enum: ['qualified', 'rejected', 'unverifiable'],
          },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'array', items: { type: 'string' } },
          limitations: { type: 'array', items: { type: 'string' } },
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
  await updateDiscoveryBranchExecutionState(pool, runId, 'd4', {
    status: 'running',
    endReason: null,
    completedAt: null,
    errorSummary: null,
  });
  try {
    const result = await executeDiscoveryD4(pool, runId, options);
    await updateDiscoveryBranchExecutionState(pool, runId, 'd4', {
      status: result.failures.length > 0 ? 'failed' : 'completed',
      endReason:
        result.failures.length > 0
          ? 'error'
          : result.submittedForReview > 0
            ? 'candidates_found'
            : 'no_candidates',
      completedAt: new Date().toISOString(),
      errorSummary:
        result.failures.length > 0
          ? `${result.failures.length} D4 candidate evaluation request(s) failed.`
          : null,
    });
    return result;
  } catch (error) {
    await updateDiscoveryBranchExecutionState(pool, runId, 'd4', {
      status: 'failed',
      endReason: 'error',
      completedAt: new Date().toISOString(),
      errorSummary: toErrorMessage(error),
    });
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
    const estimatedDurationMinutes = readDurationMinutes(source.metadata);
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
        precheck,
        selectedContent,
      }));

    if (precheck || !selectedContent) continue;
    prepared.push({
      id: candidateId,
      lead,
      source,
      prompt: {
        candidateId,
        title: source.title,
        author: source.author,
        publication: source.source_name,
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
  let tokenUsageComplete = true;
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
          else tokenUsageComplete = false;
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
              tokenUsageComplete: responseUsage !== null,
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
          if (!responseReceived || responseUsage === null) tokenUsageComplete = false;
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
              tokenUsageComplete: responseUsage !== null,
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
    tokenUsageComplete,
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
      ['candidateId', 'decision', 'reason', 'evidence', 'limitations', 'extra_info'],
      ['candidateId', 'decision', 'reason', 'evidence', 'limitations'],
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
    return {
      candidateId,
      decision: decision as DiscoveryD4Decision,
      reason: requireNonEmptyString(evaluation.reason, 'reason'),
      evidence: requireStringArray(evaluation.evidence, 'evidence'),
      limitations: requireStringArray(evaluation.limitations, 'limitations'),
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
        s.name as source_name,
        s.source_type
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.id = any($1::uuid[])
        and pc.routing in ('digest', 'long_form')`,
    [contentIds],
  );
  return result.rows;
}

async function loadExistingCandidates(
  pool: Pool,
  runId: string,
  leadIds: string[],
): Promise<CandidateRow[]> {
  if (leadIds.length === 0) return [];
  const result = await pool.query<CandidateRow>(
    `select id, source_lead_id, status, evaluation
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
      where run_id <> $1::uuid
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
        durationVerification:
          input.estimatedDurationMinutes === null ? 'unavailable' : 'source_metadata',
      }
    : {
        contentSource: null,
        contentMayBeIncomplete: true,
        contentLength: 0,
        durationVerification:
          input.estimatedDurationMinutes === null ? 'unavailable' : 'source_metadata',
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
      input.source.source_name,
      readContentType(input.source),
      toIso(input.source.published_at),
      input.estimatedDurationMinutes,
      JSON.stringify(evidence),
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
  const requestStartedAt = Date.now();
  const response = await request(
    {
      model,
      instructions: buildDiscoveryD4Instructions(),
      input: buildDiscoveryD4UserPrompt([candidate.prompt]),
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
  };
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
        durationVerification:
          candidate.prompt.estimatedDurationMinutes === null ? 'unavailable' : 'source_metadata',
        details: evaluation.evidence,
        limitations: evaluation.limitations,
      };
      const status = evaluation.decision === 'qualified' ? 'evaluated' : evaluation.decision;
      await client.query(
        `update discovery_candidates
          set evaluation = $2::jsonb, evidence = $3::jsonb,
              extra_info = $4::jsonb, status = $5, updated_at = now()
          where id = $1::uuid and status = 'discovered'`,
        [
          evaluation.candidateId,
          JSON.stringify({ decision: evaluation.decision, reason: evaluation.reason }),
          JSON.stringify(evidence),
          JSON.stringify(evaluation.extraInfo),
          status,
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
    `select id, source_lead_id, status, evaluation
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
        promptVersion: DISCOVERY_D4_PROMPT_VERSION,
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

function readDurationMinutes(metadata: Record<string, unknown> | null): number | null {
  if (!metadata) return null;
  for (const key of ['durationMinutes', 'duration_minutes', 'readingTimeMinutes']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.ceil(value);
    }
  }
  return null;
}

function readContentType(source: DirectSourceRow): 'article' | 'video' | 'podcast' | null {
  const candidate =
    source.metadata?.contentType ?? source.metadata?.content_type ?? source.source_type;
  return candidate === 'article' || candidate === 'video' || candidate === 'podcast'
    ? candidate
    : null;
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
