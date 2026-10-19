// D5 Open Discovery. It deliberately reuses D3's fetch, tracing and candidate
// persistence boundary while keeping the no-Lead output contract explicit.
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
import {
  DiscoveryTagsSchema,
  DiscoveryTagsTransportSchema,
} from '../lib/discovery-content-metadata.js';
import {
  buildDiscoveryD5Instructions,
  buildDiscoveryD5UserPrompt,
  DISCOVERY_D5_PROMPT_VERSION,
  DISCOVERY_EDITORIAL_PROMPT_VERSION,
} from '../prompts/discovery-open-agent.js';
import { PostgresDiscoveryTracingProcessor } from './agent-tracing.js';
import {
  buildDiscoveryStageState,
  emptyDiscoveryStageUsage,
  initialDiscoveryStageState,
  stageHasHistoricConfig,
} from './execution-diagnostics.js';
import {
  createDiscoveryFetchContentTool,
  type DiscoveryAgentContext,
  type DiscoveryFetchResult,
} from './fetch-content.js';
import { getDiscoveryRun, updateDiscoveryBranchExecutionState } from './run-service.js';
import {
  validateAndPersistDiscoveryAgentCandidates,
  type DiscoveryAgentCandidate,
  type DiscoveryAgentCandidateCounts,
  type DiscoveryD3EndReason,
  type DiscoveryD3RuntimeConfig,
  type DiscoveryD3Usage,
} from './topic-discovery.js';

const D5CandidateTransportSchema = z
  .object({
    url: z.string().min(1),
    title: z.string().min(1),
    title_zh: z.string().min(1),
    author: z.string(),
    publication: z.string(),
    contentType: z.enum(['article', 'video', 'podcast']),
    publishedAt: z.string().nullable(),
    estimatedDurationMinutes: z.number().int().positive().nullable(),
    summary: z.string().min(1),
    whyWorthReading: z.string().min(1),
    evidence: z.string().min(1),
    limitations: z.string(),
    tags: DiscoveryTagsTransportSchema,
    extra_info: z.string(),
  })
  .strict();

export const DiscoveryD5OutputSchema = z
  .object({ candidates: z.array(D5CandidateTransportSchema).max(3) })
  .strict();

export type DiscoveryD5RuntimeConfig = DiscoveryD3RuntimeConfig;
export type DiscoveryD5RuntimeResult = {
  output: unknown;
  fetches: DiscoveryFetchResult[];
  usage: DiscoveryD3Usage;
  elapsedMs: number;
  traceIds: string[];
  traceFlushed: boolean;
};
export type DiscoveryD5Runtime = (input: {
  runId: string;
  memory: unknown;
  manualContext?: string;
  config: DiscoveryD5RuntimeConfig;
}) => Promise<DiscoveryD5RuntimeResult>;

export type RunDiscoveryD5Result = {
  skipped: boolean;
  discoveredCount: number;
  selectedCount: number;
  rejectedCount: number;
  unverifiableCount: number;
  endReason: 'candidates_found' | 'no_candidates';
  config: DiscoveryD5RuntimeConfig;
  usage: DiscoveryD3Usage;
  elapsedMs: number;
  traceIds: string[];
  traceFlushed: boolean;
};

export async function runDiscoveryD5(
  pool: Pool,
  runId: string,
  options: { runtime?: DiscoveryD5Runtime; environment?: NodeJS.ProcessEnv } = {},
): Promise<RunDiscoveryD5Result> {
  const run = await getDiscoveryRun(pool, runId);
  if (!run) throw new Error(`Discovery Run not found: ${runId}`);
  const config =
    readD5ConfigSnapshot(run.configSnapshot) ??
    resolveDiscoveryD5RuntimeConfig(options.environment);
  if (run.executionState.d5?.status === 'completed') {
    return result(true, await loadD5Counts(pool, runId), config, run.executionState.d5.usage);
  }
  if (run.status !== 'running') throw new Error('D5 requires a running Discovery Run.');

  const prior = initialDiscoveryStageState(
    run.executionState.d5,
    stageHasHistoricConfig(run.configSnapshot, 'd5'),
  );
  const metadata = { provider: config.provider, model: config.model, apiMode: config.apiMode };
  await persistDiscoveryD5Config(pool, runId, config);
  const startedAt = Date.now();
  await updateDiscoveryBranchExecutionState(
    pool,
    runId,
    'd5',
    buildDiscoveryStageState({
      status: 'running',
      endReason: null,
      errorSummary: null,
      metadata,
      prior,
    }),
  );

  let attemptUsage: DiscoveryD3Usage | null = null;
  let attemptElapsedMs: number | null = null;
  try {
    const manualContext = readManualOpenContext(run.configSnapshot);
    const runtimeInput = {
      runId,
      memory: run.configSnapshot?.memory ?? null,
      manualContext,
      config,
    };
    const runtimeResult = options.runtime
      ? await options.runtime(runtimeInput)
      : await runDiscoveryD5Agent({ ...runtimeInput, pool });
    attemptUsage = runtimeResult.usage;
    attemptElapsedMs = runtimeResult.elapsedMs;
    const candidates = validateDiscoveryD5Output(runtimeResult.output);
    if (
      candidates.length === 0 &&
      runtimeResult.fetches.length > 0 &&
      runtimeResult.fetches.every((fetchResult) => fetchResult.status === 'error')
    ) {
      throw new DiscoveryD5ExecutionError(
        'tool_failure',
        'D5 could not complete because every fetch_content call failed.',
      );
    }
    const counts = await validateAndPersistDiscoveryAgentCandidates(pool, {
      runId,
      stage: 'd5',
      discoveryPath: 'open',
      candidates,
      fetches: runtimeResult.fetches,
      executionState: buildDiscoveryStageState({
        status: 'completed',
        endReason: candidates.length > 0 ? 'candidates_found' : 'no_candidates',
        errorSummary: null,
        metadata,
        prior,
        attemptUsage: runtimeResult.usage,
        attemptElapsedMs: runtimeResult.elapsedMs,
        completedAt: new Date().toISOString(),
      }),
    });
    return {
      ...result(false, counts, config, runtimeResult.usage),
      elapsedMs: runtimeResult.elapsedMs,
      traceIds: runtimeResult.traceIds,
      traceFlushed: runtimeResult.traceFlushed,
    };
  } catch (error) {
    const classified = classifyD5Error(error);
    const diagnostics = readD5ErrorDiagnostics(error);
    await updateDiscoveryBranchExecutionState(
      pool,
      runId,
      'd5',
      buildDiscoveryStageState({
        status: 'failed',
        endReason: classified.endReason,
        errorSummary: classified.message,
        metadata,
        prior,
        ...(diagnostics || attemptUsage
          ? {
              attemptUsage: diagnostics?.usage ?? attemptUsage!,
              attemptElapsedMs: diagnostics?.elapsedMs ?? attemptElapsedMs!,
            }
          : { attemptElapsedMs: Date.now() - startedAt }),
        completedAt: new Date().toISOString(),
      }),
    );
    throw classified;
  }
}

export function validateDiscoveryD5Output(output: unknown): DiscoveryAgentCandidate[] {
  const parsed = DiscoveryD5OutputSchema.parse(output);
  return parsed.candidates.map((candidate) => ({
    url: candidate.url,
    title: candidate.title,
    titleZh: candidate.title_zh,
    author: candidate.author,
    publication: candidate.publication || null,
    contentType: candidate.contentType,
    publishedAt: parsePublishedAt(candidate.publishedAt),
    estimatedDurationMinutes: candidate.estimatedDurationMinutes,
    summary: candidate.summary,
    whyWorthReading: candidate.whyWorthReading,
    evidence: candidate.evidence,
    limitations: candidate.limitations,
    tags: DiscoveryTagsSchema.parse(candidate.tags),
    extraInfo: parseExtraInfo(candidate.extra_info),
  }));
}

export function resolveDiscoveryD5RuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DiscoveryD5RuntimeConfig {
  return {
    provider: 'codex',
    model:
      configured(environment.DISCOVERY_AGENT_MODEL) ??
      configured(environment.CODEX_MODEL) ??
      'gpt-5.6-terra',
    apiMode: 'responses',
    baseUrl: configured(environment.CODEX_BASE_URL) ?? 'http://127.0.0.1:8317/v1',
    timeoutMs: positiveInteger(
      environment.DISCOVERY_D5_TIMEOUT_MS ?? environment.DISCOVERY_D3_TIMEOUT_MS,
      8 * 60_000,
      'DISCOVERY_D5_TIMEOUT_MS',
    ),
    fetchTimeoutMs: positiveInteger(
      environment.DISCOVERY_FETCH_CONTENT_TIMEOUT_MS,
      90_000,
      'DISCOVERY_FETCH_CONTENT_TIMEOUT_MS',
    ),
    maxTurns: positiveInteger(
      environment.DISCOVERY_D5_MAX_TURNS ?? environment.DISCOVERY_D3_MAX_TURNS,
      8,
      'DISCOVERY_D5_MAX_TURNS',
    ),
  };
}

export async function runDiscoveryD5Agent(input: {
  pool?: Pool;
  runId: string;
  memory: unknown;
  manualContext?: string;
  config: DiscoveryD5RuntimeConfig;
}): Promise<DiscoveryD5RuntimeResult> {
  if (!input.pool) throw new Error('D5 Agent runtime requires a PostgreSQL pool for tracing.');
  const apiKey = process.env.CODEX_API_KEY;
  if (!apiKey) throw new Error('CODEX_API_KEY is required for D5 Open Discovery.');
  const context: DiscoveryAgentContext = { fetches: [] };
  const processor = new PostgresDiscoveryTracingProcessor(input.pool, input.runId);
  setTraceProcessors([processor]);
  setDefaultOpenAIClient(new OpenAI({ apiKey, baseURL: input.config.baseUrl, maxRetries: 0 }));
  setOpenAIAPI('responses');
  const runner = new Runner({
    workflowName: 'x-field-discovery-d5',
    traceIncludeSensitiveData: true,
  });
  const agent = new Agent<DiscoveryAgentContext, typeof DiscoveryD5OutputSchema>({
    name: 'X-field Open Discovery Agent',
    model: input.config.model,
    instructions: buildDiscoveryD5Instructions(),
    tools: [
      webSearchTool({ searchContextSize: 'medium' }),
      createDiscoveryFetchContentTool({ timeoutMs: input.config.fetchTimeoutMs, pool: input.pool }),
    ],
    outputType: DiscoveryD5OutputSchema,
  });
  const startedAt = Date.now();
  try {
    const agentResult = await runner.run(
      agent,
      buildDiscoveryD5UserPrompt(input.memory, input.manualContext),
      {
        context,
        maxTurns: input.config.maxTurns,
        signal: AbortSignal.timeout(input.config.timeoutMs),
      },
    );
    if (!agentResult.finalOutput) throw new Error('D5 Agent returned no final output.');
    return {
      output: agentResult.finalOutput,
      fetches: context.fetches,
      usage: processor.getUsage(),
      elapsedMs: Date.now() - startedAt,
      traceIds: [...processor.traceIds],
      traceFlushed: true,
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    Object.assign(failure, {
      discoveryD5Diagnostics: { usage: processor.getUsage(), elapsedMs: Date.now() - startedAt },
    });
    throw failure;
  } finally {
    await getGlobalTraceProvider().forceFlush();
    await processor.shutdown();
  }
}

export class DiscoveryD5ExecutionError extends Error {
  constructor(
    readonly endReason: Exclude<DiscoveryD3EndReason, 'candidates_found' | 'no_candidates'>,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DiscoveryD5ExecutionError';
  }
}

async function loadD5Counts(pool: Pool, runId: string): Promise<DiscoveryAgentCandidateCounts> {
  const query = await pool.query<{ status: string; count: string }>(
    `select status, count(*)::text as count from discovery_candidates
      where run_id = $1::uuid and discovery_path = 'open' group by status`,
    [runId],
  );
  const counts = new Map(query.rows.map((row) => [row.status, Number(row.count)]));
  return {
    discoveredCount: [...counts.values()].reduce((sum, count) => sum + count, 0),
    selectedCount: counts.get('selected') ?? 0,
    rejectedCount: counts.get('rejected') ?? 0,
    unverifiableCount: counts.get('unverifiable') ?? 0,
  };
}

function result(
  skipped: boolean,
  counts: DiscoveryAgentCandidateCounts,
  config: DiscoveryD5RuntimeConfig,
  usage: DiscoveryD3Usage = emptyDiscoveryStageUsage(),
): RunDiscoveryD5Result {
  return {
    skipped,
    ...counts,
    endReason: counts.selectedCount > 0 ? 'candidates_found' : 'no_candidates',
    config,
    usage,
    elapsedMs: 0,
    traceIds: [],
    traceFlushed: true,
  };
}

function readD5ConfigSnapshot(
  snapshot: Record<string, unknown> | null,
): DiscoveryD5RuntimeConfig | null {
  const value = snapshot?.d5;
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
  )
    throw new Error('Persisted D5 config snapshot is invalid.');
  return config as DiscoveryD5RuntimeConfig;
}

async function persistDiscoveryD5Config(
  pool: Pool,
  runId: string,
  config: DiscoveryD5RuntimeConfig,
): Promise<void> {
  await pool.query(
    `update discovery_runs set config_snapshot = case
       when coalesce(config_snapshot, '{}'::jsonb) ? 'd5' then config_snapshot
       else jsonb_set(coalesce(config_snapshot, '{}'::jsonb), '{d5}', $2::jsonb, true)
     end, updated_at = now() where id = $1::uuid`,
    [
      runId,
      JSON.stringify({
        ...config,
        promptVersion: DISCOVERY_D5_PROMPT_VERSION,
        editorialPromptVersion: DISCOVERY_EDITORIAL_PROMPT_VERSION,
      }),
    ],
  );
}

function readManualOpenContext(snapshot: Record<string, unknown> | null): string | undefined {
  const value = snapshot?.manualOpen;
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as { context?: unknown }).context === 'string'
    ? (value as { context: string }).context
    : undefined;
}

function parsePublishedAt(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp))
    throw new Error(`D5 candidate has invalid publishedAt: ${value}`);
  return new Date(timestamp).toISOString();
}

function parseExtraInfo(value: string): Record<string, unknown> {
  if (value.length > 16_000) throw new Error('D5 candidate extra_info exceeds 16000 characters.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || '{}');
  } catch {
    throw new Error('D5 candidate extra_info must be a JSON object string.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('D5 candidate extra_info must decode to a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function classifyD5Error(error: unknown): DiscoveryD5ExecutionError {
  if (error instanceof DiscoveryD5ExecutionError) return error;
  if (error instanceof MaxTurnsExceededError)
    return new DiscoveryD5ExecutionError('budget_exhausted', error.message, { cause: error });
  if (
    error instanceof ModelTimeoutError ||
    (error instanceof Error && (error.name === 'AbortError' || /timed?\s*out/i.test(error.message)))
  ) {
    return new DiscoveryD5ExecutionError('timeout', safeError(error), { cause: error });
  }
  return new DiscoveryD5ExecutionError('error', safeError(error), { cause: error });
}

function readD5ErrorDiagnostics(
  error: unknown,
): { usage: DiscoveryD3Usage; elapsedMs: number } | null {
  const value =
    error && typeof error === 'object'
      ? (error as { discoveryD5Diagnostics?: unknown }).discoveryD5Diagnostics
      : null;
  if (!value || typeof value !== 'object') return null;
  const diagnostics = value as { usage?: unknown; elapsedMs?: unknown };
  return diagnostics.usage &&
    typeof diagnostics.usage === 'object' &&
    typeof diagnostics.elapsedMs === 'number' &&
    diagnostics.elapsedMs >= 0
    ? { usage: diagnostics.usage as DiscoveryD3Usage, elapsedMs: diagnostics.elapsedMs }
    : null;
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***')
    .slice(0, 2_000);
}
