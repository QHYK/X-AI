import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  Agent,
  getGlobalTraceProvider,
  MaxTurnsExceededError,
  ModelTimeoutError,
  Runner,
  setDefaultOpenAIClient,
  setOpenAIAPI,
  setTraceProcessors,
  webSearchTool,
} from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';
import { normalizeArticleUrl } from '../processing/url-normalization.js';
import {
  buildDiscoveryD3Instructions,
  buildDiscoveryD3UserPrompt,
  DISCOVERY_D3_PROMPT_VERSION,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
} from '../prompts/discovery-topic-agent.js';
import { PostgresDiscoveryTracingProcessor } from './agent-tracing.js';
import {
  createDiscoveryFetchContentTool,
  type DiscoveryAgentContext,
  type DiscoveryFetchResult,
} from './fetch-content.js';
import {
  getDiscoveryRun,
  updateDiscoveryBranchExecutionState,
  type DiscoveryRunRecord,
} from './run-service.js';
import type { DiscoverySelectionOutput, DiscoveryTopicLead } from './topic-selection.js';

const D3CandidateTransportSchema = z
  .object({
    sourceLeadId: z.string().min(1),
    url: z.string().min(1),
    title: z.string().min(1),
    title_zh: z.string().min(1),
    author: z.string(),
    contentType: z.enum(['article', 'video', 'podcast']),
    publishedAt: z.string().nullable(),
    estimatedDurationMinutes: z.number().int().positive().nullable(),
    summary: z.string().min(1),
    whyWorthReading: z.string().min(1),
    evidence: z.string().min(1),
    limitations: z.string(),
    extra_info: z.string(),
  })
  .strict();

export const DiscoveryD3OutputSchema = z
  .object({ candidates: z.array(D3CandidateTransportSchema).max(3) })
  .strict();

export type DiscoveryD3Candidate = {
  sourceLeadId: string;
  url: string;
  title: string;
  titleZh: string;
  author: string;
  contentType: 'article' | 'video' | 'podcast';
  publishedAt: string | null;
  estimatedDurationMinutes: number | null;
  summary: string;
  whyWorthReading: string;
  evidence: string;
  limitations: string;
  extraInfo: Record<string, unknown>;
};

export type DiscoveryD3Usage = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type DiscoveryD3RuntimeResult = {
  output: unknown;
  fetches: DiscoveryFetchResult[];
  usage: DiscoveryD3Usage;
  elapsedMs: number;
  traceIds: string[];
  traceFlushed: boolean;
};

export type DiscoveryD3Runtime = (input: {
  runId: string;
  topicLeads: DiscoveryTopicLead[];
  memory: unknown;
  config: DiscoveryD3RuntimeConfig;
}) => Promise<DiscoveryD3RuntimeResult>;

export type DiscoveryD3RuntimeConfig = {
  provider: 'codex';
  model: string;
  apiMode: 'responses';
  baseUrl: string;
  timeoutMs: number;
  fetchTimeoutMs: number;
  maxTurns: number;
};

export type DiscoveryD3EndReason =
  'candidates_found' | 'no_candidates' | 'timeout' | 'budget_exhausted' | 'tool_failure' | 'error';

export class DiscoveryD3ExecutionError extends Error {
  constructor(
    readonly endReason: Exclude<DiscoveryD3EndReason, 'candidates_found' | 'no_candidates'>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DiscoveryD3ExecutionError';
  }
}

export type RunDiscoveryD3Result = {
  skipped: boolean;
  topicCount: number;
  discoveredCount: number;
  selectedCount: number;
  rejectedCount: number;
  unverifiableCount: number;
  endReason: 'candidates_found' | 'no_candidates';
  config: DiscoveryD3RuntimeConfig;
  usage: DiscoveryD3Usage;
  elapsedMs: number;
  traceIds: string[];
  traceFlushed: boolean;
};

export async function runDiscoveryD3(
  pool: Pool,
  runId: string,
  options: { runtime?: DiscoveryD3Runtime; environment?: NodeJS.ProcessEnv } = {},
): Promise<RunDiscoveryD3Result> {
  const run = await getDiscoveryRun(pool, runId);
  if (!run?.selectionOutput) {
    throw new Error('D3 requires a Discovery Run with persisted D2 selection_output.');
  }
  const topicLeads = readTopicLeads(run);
  const config = readD3ConfigSnapshot(run) ?? resolveDiscoveryD3RuntimeConfig(options.environment);
  if (run.executionState.d3?.status === 'completed') {
    const counts = await loadD3Counts(pool, runId);
    return completedResult(true, topicLeads.length, counts, config);
  }
  if (run.status !== 'running') throw new Error('D3 requires a running Discovery Run.');

  await persistDiscoveryD3Config(pool, runId, config);
  await updateDiscoveryBranchExecutionState(pool, runId, 'd3', {
    status: 'running',
    endReason: null,
    completedAt: null,
    errorSummary: null,
  });

  if (topicLeads.length === 0) {
    await completeEmptyD3(pool, runId);
    return completedResult(false, 0, emptyCounts(), config);
  }

  try {
    const runtimeInput = { runId, topicLeads, memory: run.configSnapshot?.memory ?? null, config };
    const runtimeResult = options.runtime
      ? await options.runtime(runtimeInput)
      : await runDiscoveryD3Agent({ ...runtimeInput, pool });
    const candidates = validateDiscoveryD3Output(runtimeResult.output, topicLeads);
    if (
      candidates.length === 0 &&
      runtimeResult.fetches.length > 0 &&
      runtimeResult.fetches.every((fetchResult) => fetchResult.status === 'error')
    ) {
      throw new DiscoveryD3ExecutionError(
        'tool_failure',
        'D3 could not complete because every fetch_content call failed.',
      );
    }
    const counts = await validateAndPersistD3Candidates(
      pool,
      runId,
      topicLeads,
      candidates,
      runtimeResult.fetches,
    );
    return {
      ...completedResult(false, topicLeads.length, counts, config),
      usage: runtimeResult.usage,
      elapsedMs: runtimeResult.elapsedMs,
      traceIds: runtimeResult.traceIds,
      traceFlushed: runtimeResult.traceFlushed,
    };
  } catch (error) {
    const classified = classifyD3Error(error);
    await updateDiscoveryBranchExecutionState(pool, runId, 'd3', {
      status: 'failed',
      endReason: classified.endReason,
      completedAt: new Date().toISOString(),
      errorSummary: classified.message,
    });
    throw classified;
  }
}

export function validateDiscoveryD3Output(
  output: unknown,
  topicLeads: DiscoveryTopicLead[],
): DiscoveryD3Candidate[] {
  const parsed = DiscoveryD3OutputSchema.parse(output);
  const validLeadIds = new Set(topicLeads.map((lead) => lead.leadId));
  return parsed.candidates.map((candidate) => {
    if (!validLeadIds.has(candidate.sourceLeadId)) {
      throw new Error(`D3 candidate references unknown sourceLeadId: ${candidate.sourceLeadId}`);
    }
    return {
      sourceLeadId: candidate.sourceLeadId,
      url: candidate.url,
      title: candidate.title,
      titleZh: candidate.title_zh,
      author: candidate.author,
      contentType: candidate.contentType,
      publishedAt: parsePublishedAt(candidate.publishedAt),
      estimatedDurationMinutes: candidate.estimatedDurationMinutes,
      summary: candidate.summary,
      whyWorthReading: candidate.whyWorthReading,
      evidence: candidate.evidence,
      limitations: candidate.limitations,
      extraInfo: parseExtraInfo(candidate.extra_info),
    };
  });
}

export function resolveDiscoveryD3RuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DiscoveryD3RuntimeConfig {
  return {
    provider: 'codex',
    model:
      configured(environment.DISCOVERY_AGENT_MODEL) ??
      configured(environment.CODEX_MODEL) ??
      'gpt-5.6-terra',
    apiMode: 'responses',
    baseUrl: configured(environment.CODEX_BASE_URL) ?? 'http://127.0.0.1:8317/v1',
    timeoutMs: positiveInteger(
      environment.DISCOVERY_D3_TIMEOUT_MS,
      8 * 60_000,
      'DISCOVERY_D3_TIMEOUT_MS',
    ),
    fetchTimeoutMs: positiveInteger(
      environment.DISCOVERY_FETCH_CONTENT_TIMEOUT_MS,
      90_000,
      'DISCOVERY_FETCH_CONTENT_TIMEOUT_MS',
    ),
    maxTurns: positiveInteger(environment.DISCOVERY_D3_MAX_TURNS, 8, 'DISCOVERY_D3_MAX_TURNS'),
  };
}

export async function runDiscoveryD3Agent(input: {
  pool?: Pool;
  runId: string;
  topicLeads: DiscoveryTopicLead[];
  memory: unknown;
  config: DiscoveryD3RuntimeConfig;
}): Promise<DiscoveryD3RuntimeResult> {
  if (!input.pool) throw new Error('D3 Agent runtime requires a PostgreSQL pool for tracing.');
  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) throw new Error('CODEX_API_KEY is required for D3 Topic Discovery.');

  const context: DiscoveryAgentContext = { fetches: [] };
  const processor = new PostgresDiscoveryTracingProcessor(input.pool, input.runId);
  setTraceProcessors([processor]);
  setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL: input.config.baseUrl, maxRetries: 0 }));
  setOpenAIAPI('responses');

  const runner = new Runner({
    workflowName: 'x-field-discovery-d3',
    traceIncludeSensitiveData: true,
  });
  const agent = new Agent<DiscoveryAgentContext, typeof DiscoveryD3OutputSchema>({
    name: 'X-field Topic Discovery Agent',
    model: input.config.model,
    instructions: buildDiscoveryD3Instructions(),
    tools: [
      webSearchTool({ searchContextSize: 'medium' }),
      createDiscoveryFetchContentTool({ timeoutMs: input.config.fetchTimeoutMs }),
    ],
    outputType: DiscoveryD3OutputSchema,
  });

  const startedAt = Date.now();
  try {
    const result = await runner.run(
      agent,
      buildDiscoveryD3UserPrompt(input.topicLeads, input.memory),
      {
        context,
        maxTurns: input.config.maxTurns,
        signal: AbortSignal.timeout(input.config.timeoutMs),
      },
    );
    if (!result.finalOutput) throw new Error('D3 Agent returned no final output.');
    return {
      output: result.finalOutput,
      fetches: context.fetches,
      usage: {
        requests: result.runContext.usage.requests,
        inputTokens: result.runContext.usage.inputTokens,
        outputTokens: result.runContext.usage.outputTokens,
        totalTokens: result.runContext.usage.totalTokens,
      },
      elapsedMs: Date.now() - startedAt,
      traceIds: [...processor.traceIds],
      traceFlushed: true,
    };
  } finally {
    await getGlobalTraceProvider().forceFlush();
    await processor.shutdown();
  }
}

type D3Counts = {
  discoveredCount: number;
  selectedCount: number;
  rejectedCount: number;
  unverifiableCount: number;
};

async function validateAndPersistD3Candidates(
  pool: Pool,
  runId: string,
  topicLeads: DiscoveryTopicLead[],
  candidates: DiscoveryD3Candidate[],
  fetches: DiscoveryFetchResult[],
): Promise<D3Counts> {
  const normalizedUrls = candidates.flatMap((candidate) => {
    const normalized = normalizeArticleUrl(candidate.url);
    return normalized ? [normalized] : [];
  });
  const historical = await loadDuplicateUrls(pool, runId, normalizedUrls);
  const successfulFetches = new Map(
    fetches.flatMap((result) => {
      const normalized = normalizeArticleUrl(result.url);
      return result.status === 'success' && normalized ? [[normalized, result] as const] : [];
    }),
  );
  const leadById = new Map(topicLeads.map((lead) => [lead.leadId, lead]));
  const seen = new Set<string>();
  const rows = candidates.map((candidate) => {
    const normalizedUrl = normalizeArticleUrl(candidate.url);
    const fetchEvidence = normalizedUrl ? (successfulFetches.get(normalizedUrl) ?? null) : null;
    const duplicate = normalizedUrl
      ? historical.has(normalizedUrl) || seen.has(normalizedUrl)
      : false;
    if (normalizedUrl) seen.add(normalizedUrl);
    const durationRejected =
      candidate.estimatedDurationMinutes !== null && candidate.estimatedDurationMinutes > 30;
    const decision = !normalizedUrl
      ? { status: 'rejected' as const, reason: 'invalid_url' }
      : duplicate
        ? { status: 'rejected' as const, reason: 'duplicate_url' }
        : !fetchEvidence
          ? { status: 'unverifiable' as const, reason: 'missing_successful_fetch_evidence' }
          : durationRejected
            ? { status: 'rejected' as const, reason: 'duration_exceeds_30_minutes' }
            : { status: 'selected' as const, reason: 'qualified' };
    return {
      id: randomUUID(),
      candidate,
      lead: leadById.get(candidate.sourceLeadId)!,
      normalizedUrl,
      fetchEvidence,
      decision,
    };
  });

  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const row of rows) {
      await client.query(
        `insert into discovery_candidates (
            id, run_id, discovery_path, source_content_type, source_content_id,
            source_lead_id, topic_context, url, normalized_url, title, title_zh,
            author, publication, content_type, published_at, estimated_duration_minutes,
            summary, why_worth_reading, extra_info, evidence, evaluation, status
          ) values (
            $1::uuid, $2::uuid, 'topic', null, null,
            $3, $4::jsonb, $5, $6, $7, $8,
            $9, null, $10, $11::timestamptz, $12,
            $13, $14, $15::jsonb, $16::jsonb, $17::jsonb, $18
          )`,
        [
          row.id,
          runId,
          row.candidate.sourceLeadId,
          JSON.stringify({
            question: row.lead.question,
            newsContext: row.lead.newsContext,
            sourceContentIds: row.lead.sourceContentIds,
          }),
          row.candidate.url,
          row.normalizedUrl,
          row.candidate.title,
          row.candidate.titleZh,
          row.candidate.author || null,
          row.candidate.contentType,
          row.candidate.publishedAt,
          row.candidate.estimatedDurationMinutes,
          row.candidate.summary,
          row.candidate.whyWorthReading,
          JSON.stringify(row.candidate.extraInfo),
          JSON.stringify({
            agentEvidence: row.candidate.evidence,
            limitations: row.candidate.limitations,
            fetch: row.fetchEvidence ? summarizeFetch(row.fetchEvidence) : null,
          }),
          JSON.stringify({ decision: row.decision.reason }),
          row.decision.status,
        ],
      );
      if (row.decision.status === 'selected') {
        await client.query(
          `insert into in_depth_candidates (discovery_candidate_id, review_status)
            values ($1::uuid, 'pending')
            on conflict (discovery_candidate_id) do nothing`,
          [row.id],
        );
      }
    }
    const selectedCount = rows.filter((row) => row.decision.status === 'selected').length;
    await updateDiscoveryBranchExecutionState(client, runId, 'd3', {
      status: 'completed',
      endReason: selectedCount > 0 ? 'candidates_found' : 'no_candidates',
      completedAt: new Date().toISOString(),
      errorSummary: null,
    });
    await client.query('commit');
    return {
      discoveredCount: rows.length,
      selectedCount,
      rejectedCount: rows.filter((row) => row.decision.status === 'rejected').length,
      unverifiableCount: rows.filter((row) => row.decision.status === 'unverifiable').length,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function completeEmptyD3(pool: Pool, runId: string): Promise<void> {
  await updateDiscoveryBranchExecutionState(pool, runId, 'd3', {
    status: 'completed',
    endReason: 'no_candidates',
    completedAt: new Date().toISOString(),
    errorSummary: null,
  });
}

async function loadDuplicateUrls(pool: Pool, runId: string, urls: string[]): Promise<Set<string>> {
  if (urls.length === 0) return new Set();
  const result = await pool.query<{ normalized_url: string }>(
    `select distinct normalized_url
      from discovery_candidates
      where normalized_url = any($1::text[])
        and (run_id <> $2::uuid or discovery_path <> 'topic')`,
    [urls, runId],
  );
  return new Set(result.rows.map((row) => row.normalized_url));
}

async function loadD3Counts(pool: Pool, runId: string): Promise<D3Counts> {
  const result = await pool.query<{ status: string; count: string }>(
    `select status, count(*)::text as count
      from discovery_candidates
      where run_id = $1::uuid and discovery_path = 'topic'
      group by status`,
    [runId],
  );
  const counts = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
  const selectedCount = counts.get('selected') ?? 0;
  const rejectedCount = counts.get('rejected') ?? 0;
  const unverifiableCount = counts.get('unverifiable') ?? 0;
  return {
    discoveredCount: [...counts.values()].reduce((sum, count) => sum + count, 0),
    selectedCount,
    rejectedCount,
    unverifiableCount,
  };
}

function readTopicLeads(run: DiscoveryRunRecord): DiscoveryTopicLead[] {
  const selection = run.selectionOutput as DiscoverySelectionOutput;
  if (!Array.isArray(selection.leads)) throw new Error('D2 selection_output.leads is invalid.');
  return selection.leads.filter(
    (lead): lead is DiscoveryTopicLead =>
      !!lead && typeof lead === 'object' && lead.kind === 'topic',
  );
}

function readD3ConfigSnapshot(run: DiscoveryRunRecord): DiscoveryD3RuntimeConfig | null {
  const value = run.configSnapshot?.d3;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const config = value as Record<string, unknown>;
  if (
    config.provider !== 'codex' ||
    config.apiMode !== 'responses' ||
    typeof config.model !== 'string' ||
    typeof config.baseUrl !== 'string' ||
    !isPositiveInteger(config.timeoutMs) ||
    !isPositiveInteger(config.fetchTimeoutMs) ||
    !isPositiveInteger(config.maxTurns)
  ) {
    throw new Error('Persisted D3 config snapshot is invalid.');
  }
  return {
    provider: 'codex',
    apiMode: 'responses',
    model: config.model,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    fetchTimeoutMs: config.fetchTimeoutMs,
    maxTurns: config.maxTurns,
  };
}

async function persistDiscoveryD3Config(
  pool: Pool,
  runId: string,
  config: DiscoveryD3RuntimeConfig,
): Promise<void> {
  await pool.query(
    `update discovery_runs
      set config_snapshot = case
            when coalesce(config_snapshot, '{}'::jsonb) ? 'd3' then config_snapshot
            else jsonb_set(
              coalesce(config_snapshot, '{}'::jsonb),
              '{d3}',
              $2::jsonb,
              true
            )
          end,
          updated_at = now()
      where id = $1::uuid`,
    [
      runId,
      JSON.stringify({
        ...config,
        promptVersion: DISCOVERY_D3_PROMPT_VERSION,
        editorialPromptVersion: DISCOVERY_EDITORIAL_PROMPT_VERSION,
      }),
    ],
  );
}

function completedResult(
  skipped: boolean,
  topicCount: number,
  counts: D3Counts,
  config: DiscoveryD3RuntimeConfig,
): RunDiscoveryD3Result {
  return {
    skipped,
    topicCount,
    ...counts,
    endReason: counts.selectedCount > 0 ? 'candidates_found' : 'no_candidates',
    config,
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    elapsedMs: 0,
    traceIds: [],
    traceFlushed: true,
  };
}

function emptyCounts(): D3Counts {
  return { discoveredCount: 0, selectedCount: 0, rejectedCount: 0, unverifiableCount: 0 };
}

function parsePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`D3 candidate has invalid publishedAt: ${value}`);
  return new Date(timestamp).toISOString();
}

function parseExtraInfo(value: string): Record<string, unknown> {
  if (value.length > 16_000) throw new Error('D3 candidate extra_info exceeds 16000 characters.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}');
  } catch {
    throw new Error('D3 candidate extra_info must be a JSON object string.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('D3 candidate extra_info must decode to a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function summarizeFetch(fetchResult: DiscoveryFetchResult): Record<string, unknown> {
  return {
    url: fetchResult.url,
    status: fetchResult.status,
    contentLength: fetchResult.content_length,
    returnedContentLength: fetchResult.returned_content_length,
    contentComplete: fetchResult.content_complete,
    truncated: fetchResult.truncated,
    contentType: fetchResult.content_type,
    metadata: fetchResult.metadata,
  };
}

function classifyD3Error(error: unknown): DiscoveryD3ExecutionError {
  if (error instanceof DiscoveryD3ExecutionError) return error;
  if (error instanceof MaxTurnsExceededError) {
    return new DiscoveryD3ExecutionError('budget_exhausted', error.message, { cause: error });
  }
  if (
    error instanceof ModelTimeoutError ||
    (error instanceof Error && (error.name === 'AbortError' || /timed?\s*out/i.test(error.message)))
  ) {
    return new DiscoveryD3ExecutionError('timeout', safeError(error), { cause: error });
  }
  return new DiscoveryD3ExecutionError('error', safeError(error), { cause: error });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***')
    .slice(0, 2_000);
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
