import { Pool } from 'pg';
import { runDiscoveryD4 } from '../src/discovery/direct-verification.js';
import {
  validateDiscoveryDailyDates,
  type DiscoveryDailyDatePair,
} from '../src/discovery/daily-read-adapter.js';
import { recordDiscoveryDiagnostic } from '../src/discovery/diagnostics.js';
import {
  createRegularDiscoveryRun,
  finishDiscoveryRun,
  getDiscoveryRun,
  resumeDiscoveryRun,
  startDiscoveryRun,
  type DiscoveryRunRecord,
} from '../src/discovery/run-service.js';
import { runDiscoveryD2, type DiscoverySelectionOutput } from '../src/discovery/topic-selection.js';
import type { DiscoveryInputContentIds } from '../src/db/schema.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import type { LlmResponse } from '../src/processing/llm-client.js';

loadPipelineEnvironment();

type CandidateReviewRow = {
  id: string;
  url: string;
  title: string | null;
  evaluation: Record<string, unknown> | null;
  evidence: Record<string, unknown> | null;
  submitted_for_review: boolean;
};

type CliOptions = {
  confirmPaid: boolean;
  dailyDates?: DiscoveryDailyDatePair;
  runId?: string;
};

type LeadSourceSummary = {
  id: string;
  kind: 'event' | 'digest' | 'long_form';
  dailyDate: string;
  title: string;
  titleZh: string | null;
};

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (!options.confirmPaid) {
    throw new Error(
      'This command calls the configured paid LLM provider. Re-run with --confirm-paid.',
    );
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      process.env.DATABASE_SSL === 'true'
        ? {
            rejectUnauthorized: false,
          }
        : undefined,
  });
  const totalStartedAt = Date.now();
  let runId: string | null = null;
  let phase: 'create_run' | 'd2' | 'd4' | 'finish' = 'create_run';
  let d2Leads: Array<Record<string, unknown>> = [];
  let d2Provider: string | null = null;
  let d2Model: string | null = null;
  let d2ApiMode: LlmResponse['api_mode'] | null = null;
  let d2RequestElapsedMs = 0;
  let d2TimeoutMs: number | undefined;
  let d2TokenUsage: LlmResponse['usage'] | null = null;
  let d2ElapsedMs = 0;
  let d4Provider: string | null = null;
  let d4Model: string | null = null;
  let d4ApiModes: LlmResponse['api_mode'][] = [];
  let d4RequestElapsedMs = 0;
  let d4TimeoutMs: number | undefined;
  let d4TokenUsage: LlmResponse['usage'] | null = null;
  let d4TokenUsageComplete = false;
  let d4ElapsedMs = 0;
  let d4RequestSummary = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    successfulElapsedMs: 0,
    failedElapsedMs: 0,
  };
  let d4Failures: Array<{
    candidateId: string;
    leadId: string;
    error: string;
    requestElapsedMs: number;
  }> = [];

  try {
    let run: DiscoveryRunRecord;
    let selection: DiscoverySelectionOutput;

    if (options.runId) {
      runId = options.runId;
      const existingRun = await getDiscoveryRun(pool, runId);
      if (!existingRun) throw new Error(`Discovery Run not found: ${runId}`);
      if (!existingRun.selectionOutput) {
        throw new Error('D4 retry requires persisted D2 selection_output.');
      }
      selection = parsePersistedSelectionForReport(existingRun.selectionOutput);
      run = await resumeDiscoveryRun(pool, runId);
      console.log(`[Discovery Provider Test] Run ID: ${runId}`);
      const d2Config = existingRun.configSnapshot?.d2;
      const persistedD2Config =
        d2Config && typeof d2Config === 'object' && !Array.isArray(d2Config)
          ? (d2Config as Record<string, unknown>)
          : null;
      d2Model = readOptionalString(persistedD2Config?.model);
      d2Provider = readOptionalString(persistedD2Config?.provider);
      d2TimeoutMs = readOptionalTimeout(persistedD2Config?.timeoutMs);
    } else {
      const dailyDates = options.dailyDates ?? (await loadLatestCompletedDailyDates(pool));
      const created = await createRegularDiscoveryRun(pool, {
        dailyDates,
        triggerSource: 'manual',
        configSnapshot: {
          integrationTest: {
            command: 'test:discovery-provider',
            dailyDates,
          },
        },
      });
      runId = created.run.id;
      if (created.run.status !== 'pending') {
        throw new Error(created.run.errorSummary ?? 'Discovery Run was not executable.');
      }
      run = await startDiscoveryRun(pool, runId);
      console.log(`[Discovery Provider Test] Run ID: ${runId}`);

      phase = 'd2';
      const d2StartedAt = Date.now();
      const d2 = await runDiscoveryD2(pool, runId);
      selection = d2.selection;
      d2Model = d2.model;
      d2Provider = d2.provider;
      d2ApiMode = d2.apiMode;
      d2RequestElapsedMs = d2.requestElapsedMs;
      d2TimeoutMs = d2.timeoutMs;
      d2TokenUsage = d2.tokenUsage;
      d2ElapsedMs = Date.now() - d2StartedAt;
    }

    const sourceSummaries = await loadLeadSourceSummaries(pool, requireInputContentIds(run));
    d2Leads = formatLeads(selection, sourceSummaries);

    phase = 'd4';
    const d4StartedAt = Date.now();
    const d4 = await runDiscoveryD4(pool, runId);
    d4ElapsedMs = Date.now() - d4StartedAt;
    d4Provider = d4.provider;
    d4Model = d4.model;
    d4ApiModes = d4.apiModes;
    d4RequestElapsedMs = d4.requestElapsedMs;
    d4TimeoutMs = d4.timeoutMs;
    d4TokenUsage = d4.tokenUsage;
    d4TokenUsageComplete = d4.tokenUsageComplete;
    d4RequestSummary = {
      attempted: d4.requestCount,
      succeeded: d4.successfulRequestCount,
      failed: d4.failedRequestCount,
      successfulElapsedMs: d4.successfulRequestElapsedMs,
      failedElapsedMs: d4.failedRequestElapsedMs,
    };
    d4Failures = d4.failures;

    phase = 'finish';
    const runStatus = d4.failures.length > 0 ? 'partial' : 'completed';
    const d4ErrorSummary = d4.failures.length > 0 ? summarizeD4Failures(d4.failures) : null;
    await finishDiscoveryRun(
      pool,
      runId,
      runStatus === 'partial'
        ? { status: 'partial', endReason: 'error', errorSummary: d4ErrorSummary! }
        : { status: 'completed', hasCandidates: d4.submittedForReview > 0 },
    );
    const candidates = await loadCandidateReviews(pool, runId);
    const combinedUsage = sumTokenUsage(d2TokenUsage, d4.tokenUsage);

    console.log(
      JSON.stringify(
        {
          runId,
          status: runStatus,
          d2Leads,
          d4Evaluations: candidates.map(toCandidateReview),
          llm: {
            d2: {
              provider: d2Provider,
              model: d2Model,
              apiMode: d2ApiMode,
              timeout: formatTimeout(d2TimeoutMs),
              requestElapsedMs: d2RequestElapsedMs,
            },
            d4: {
              provider: d4Provider,
              model: d4Model,
              apiModes: d4ApiModes,
              timeout: formatTimeout(d4TimeoutMs),
              requestElapsedMs: d4RequestElapsedMs,
              requests: d4RequestSummary,
              failures: d4Failures,
            },
          },
          usage: {
            d2: d2TokenUsage,
            d4: d4TokenUsage,
            d4Complete: d4TokenUsageComplete,
            total: combinedUsage,
          },
          elapsedMs: {
            d2: d2ElapsedMs,
            d4: d4ElapsedMs,
            total: Date.now() - totalStartedAt,
          },
          errorSummary: d4ErrorSummary,
        },
        null,
        2,
      ),
    );
    if (runStatus === 'partial') process.exitCode = 1;
  } catch (error) {
    const errorSummary = toErrorSummary(error);
    const persistenceWarnings = runId
      ? await preserveFailureDiagnostics(pool, runId, phase, errorSummary)
      : [];
    const d4Evaluations = runId
      ? await safelyLoadCandidateReviews(pool, runId, persistenceWarnings)
      : [];
    if (runId) {
      console.error(`[Discovery Provider Test] Run ID: ${runId}`);
    }
    console.error(
      JSON.stringify(
        {
          runId,
          status: 'failed',
          d2Leads,
          d4Evaluations,
          llm: {
            d2: {
              provider: d2Provider,
              model: d2Model,
              apiMode: d2ApiMode,
              timeout: formatTimeout(d2TimeoutMs),
              requestElapsedMs: d2RequestElapsedMs,
            },
            d4: {
              provider: d4Provider,
              model: d4Model,
              apiModes: d4ApiModes,
              timeout: formatTimeout(d4TimeoutMs),
              requestElapsedMs: d4RequestElapsedMs,
              requests: d4RequestSummary,
              failures: d4Failures,
            },
          },
          usage: {
            d2: d2TokenUsage,
            d4: d4TokenUsage,
            d4Complete: d4TokenUsageComplete,
            total: sumTokenUsage(d2TokenUsage, d4TokenUsage),
          },
          elapsedMs: {
            d2: d2ElapsedMs,
            d4: d4ElapsedMs,
            total: Date.now() - totalStartedAt,
          },
          errorSummary: {
            phase,
            message: errorSummary,
            persistenceWarnings,
          },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function parseArguments(args: string[]): CliOptions {
  let confirmPaid = false;
  let dailyDates: DiscoveryDailyDatePair | undefined;
  let runId: string | undefined;

  for (const argument of args) {
    if (argument === '--confirm-paid') {
      confirmPaid = true;
      continue;
    }
    if (argument.startsWith('--dates=')) {
      if (dailyDates) throw new Error('--dates may only be provided once.');
      const values = argument.slice('--dates='.length).split(',');
      if (values.length !== 2 || !values[0] || !values[1]) {
        throw new Error('--dates requires two comma-separated YYYY-MM-DD values.');
      }
      dailyDates = validateDiscoveryDailyDates([values[0], values[1]]);
      continue;
    }
    if (argument.startsWith('--run-id=')) {
      if (runId) throw new Error('--run-id may only be provided once.');
      runId = argument.slice('--run-id='.length).trim();
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)
      ) {
        throw new Error('--run-id must be a UUID.');
      }
      continue;
    }
    throw new Error(
      `Unsupported argument "${argument}". Use --confirm-paid with optional --dates=YYYY-MM-DD,YYYY-MM-DD or --run-id=UUID.`,
    );
  }

  if (dailyDates && runId) throw new Error('--dates and --run-id cannot be used together.');
  return { confirmPaid, dailyDates, runId };
}

async function loadLatestCompletedDailyDates(pool: Pool): Promise<DiscoveryDailyDatePair> {
  const result = await pool.query<{ daily_date: string }>(
    `select daily_date::text as daily_date
      from pipeline_runs
      where step in ('daily', 'stage4')
        and status = 'success'
        and daily_date is not null
      group by daily_date
      order by daily_date desc
      limit 2`,
  );
  if (result.rows.length !== 2) {
    throw new Error('At least two successfully completed Daily dates are required.');
  }
  const descending = result.rows.map((row) => row.daily_date);
  return validateDiscoveryDailyDates([descending[1]!, descending[0]!]);
}

function requireInputContentIds(run: DiscoveryRunRecord): DiscoveryInputContentIds {
  if (!run.inputContentIds) throw new Error('Discovery Run does not have saved input membership.');
  return run.inputContentIds;
}

function parsePersistedSelectionForReport(
  value: Record<string, unknown>,
): DiscoverySelectionOutput {
  if (!Array.isArray(value.leads)) {
    throw new Error('Persisted D2 selection_output.leads is invalid.');
  }
  return value as DiscoverySelectionOutput;
}

async function loadLeadSourceSummaries(
  pool: Pool,
  inputContentIds: DiscoveryInputContentIds,
): Promise<Map<string, LeadSourceSummary>> {
  const eventMembership = new Map(inputContentIds.event.map((item) => [item.id, item.dailyDate]));
  const processedMembership = new Map(
    [...inputContentIds.digest, ...inputContentIds.longForm].map((item) => [
      item.id,
      {
        dailyDate: item.dailyDate,
        kind: inputContentIds.digest.some((digest) => digest.id === item.id)
          ? ('digest' as const)
          : ('long_form' as const),
      },
    ]),
  );
  const [events, processed] = await Promise.all([
    eventMembership.size === 0
      ? Promise.resolve({
          rows: [] as Array<{ id: string; title: string; title_zh: string | null }>,
        })
      : pool.query<{ id: string; title: string; title_zh: string | null }>(
          'select id, title, title_zh from events where id = any($1::uuid[])',
          [[...eventMembership.keys()]],
        ),
    processedMembership.size === 0
      ? Promise.resolve({
          rows: [] as Array<{ id: string; title: string; title_zh: string | null }>,
        })
      : pool.query<{ id: string; title: string; title_zh: string | null }>(
          `select pc.id, ra.title, pc.title_zh
            from processed_contents pc
            join raw_articles ra on ra.id = pc.raw_article_id
            where pc.id = any($1::uuid[])`,
          [[...processedMembership.keys()]],
        ),
  ]);

  const summaries = new Map<string, LeadSourceSummary>();
  for (const row of events.rows) {
    summaries.set(row.id, {
      id: row.id,
      kind: 'event',
      dailyDate: eventMembership.get(row.id) ?? '',
      title: row.title,
      titleZh: row.title_zh,
    });
  }
  for (const row of processed.rows) {
    const membership = processedMembership.get(row.id);
    if (!membership) continue;
    summaries.set(row.id, {
      id: row.id,
      kind: membership.kind,
      dailyDate: membership.dailyDate,
      title: row.title,
      titleZh: row.title_zh,
    });
  }
  return summaries;
}

function formatLeads(
  selection: DiscoverySelectionOutput,
  sources: Map<string, LeadSourceSummary>,
): Array<Record<string, unknown>> {
  return selection.leads.map((lead) => {
    if (lead.kind === 'direct') {
      return {
        leadId: lead.leadId,
        kind: lead.kind,
        sourceContent: sources.get(lead.sourceContentId) ?? { id: lead.sourceContentId },
        rationale: lead.rationale,
        url: lead.url,
      };
    }
    return {
      leadId: lead.leadId,
      kind: lead.kind,
      sourceContents: lead.sourceContentIds.map(
        (sourceContentId) => sources.get(sourceContentId) ?? { id: sourceContentId },
      ),
      question: lead.question,
      newsContext: lead.newsContext,
      rationale: lead.rationale,
    };
  });
}

async function loadCandidateReviews(pool: Pool, runId: string): Promise<CandidateReviewRow[]> {
  const result = await pool.query<CandidateReviewRow>(
    `select
        dc.id,
        dc.url,
        dc.title,
        dc.evaluation,
        dc.evidence,
        exists (
          select 1
          from in_depth_candidates idc
          where idc.discovery_candidate_id = dc.id
        ) as submitted_for_review
      from discovery_candidates dc
      where dc.run_id = $1::uuid
        and dc.discovery_path = 'direct'
      order by dc.created_at asc, dc.id asc`,
    [runId],
  );
  return result.rows;
}

function toCandidateReview(row: CandidateReviewRow) {
  const decision = readOptionalString(row.evaluation?.decision);
  const reason = readOptionalString(row.evaluation?.reason);
  const evidence = readStringArray(row.evidence?.details);
  const limitations = readStringArray(row.evidence?.limitations ?? row.evaluation?.limitations);
  return {
    candidateId: row.id,
    url: row.url,
    title: row.title,
    decision,
    reason,
    evidence,
    limitations,
    submittedForReview: row.submitted_for_review,
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readOptionalTimeout(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function formatTimeout(timeoutMs: number | undefined): number | 'SDK default' {
  return timeoutMs ?? 'SDK default';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function preserveFailureDiagnostics(
  pool: Pool,
  runId: string,
  phase: string,
  errorSummary: string,
): Promise<string[]> {
  const warnings: string[] = [];
  let run: DiscoveryRunRecord | null;
  try {
    run = await getDiscoveryRun(pool, runId);
  } catch (readError) {
    warnings.push(`Could not reload Run: ${toErrorSummary(readError)}`);
    return warnings;
  }
  if (run?.status !== 'running') return warnings;

  try {
    await recordDiscoveryDiagnostic(pool, {
      runId,
      name: 'd2_d4_provider_integration',
      status: 'failed',
      payload: { phase, error: errorSummary },
    });
  } catch (diagnosticError) {
    warnings.push(`Could not persist diagnostic: ${toErrorSummary(diagnosticError)}`);
  }

  try {
    const candidateCount = await loadCandidateCount(pool, runId);
    await finishDiscoveryRun(pool, runId, {
      status: candidateCount > 0 ? 'partial' : 'failed',
      endReason: 'error',
      errorSummary,
    });
  } catch (finishError) {
    warnings.push(`Could not finalize Run: ${toErrorSummary(finishError)}`);
  }
  return warnings;
}

async function safelyLoadCandidateReviews(
  pool: Pool,
  runId: string,
  warnings: string[],
): Promise<ReturnType<typeof toCandidateReview>[]> {
  try {
    return (await loadCandidateReviews(pool, runId)).map(toCandidateReview);
  } catch (error) {
    warnings.push(`Could not load D4 evaluations: ${toErrorSummary(error)}`);
    return [];
  }
}

async function loadCandidateCount(pool: Pool, runId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'select count(*)::text as count from discovery_candidates where run_id = $1::uuid',
    [runId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

function sumTokenUsage(
  d2: LlmResponse['usage'] | null,
  d4: LlmResponse['usage'] | null,
): LlmResponse['usage'] | null {
  if (!d2 && !d4) return null;
  return {
    input_tokens: (d2?.input_tokens ?? 0) + (d4?.input_tokens ?? 0),
    output_tokens: (d2?.output_tokens ?? 0) + (d4?.output_tokens ?? 0),
    total_tokens: (d2?.total_tokens ?? 0) + (d4?.total_tokens ?? 0),
  };
}

function toErrorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000) || 'Unknown Discovery integration error.';
}

function summarizeD4Failures(
  failures: Array<{ candidateId: string; leadId: string; error: string }>,
): string {
  return failures
    .map((failure) => `${failure.leadId}/${failure.candidateId}: ${failure.error}`)
    .join('; ')
    .slice(0, 2_000);
}

await main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        runId: null,
        status: 'failed',
        d2Leads: [],
        d4Evaluations: [],
        llm: {
          d2: {
            provider: null,
            model: null,
            apiMode: null,
            timeout: 'SDK default',
            requestElapsedMs: 0,
          },
          d4: {
            provider: null,
            model: null,
            apiModes: [],
            timeout: 'SDK default',
            requestElapsedMs: 0,
            requests: {
              attempted: 0,
              succeeded: 0,
              failed: 0,
              successfulElapsedMs: 0,
              failedElapsedMs: 0,
            },
            failures: [],
          },
        },
        usage: {
          d2: null,
          d4: null,
          d4Complete: false,
          d4KnownUsage: null,
          d4UsageComplete: false,
          total: null,
        },
        elapsedMs: { d2: 0, d4: 0, total: 0 },
        errorSummary: {
          phase: 'startup',
          message: toErrorSummary(error),
          persistenceWarnings: [],
        },
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
