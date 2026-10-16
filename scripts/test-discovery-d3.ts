import { Pool } from 'pg';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import {
  finishDiscoveryRun,
  getDiscoveryRun,
  resumeDiscoveryBranchRun,
  startDiscoveryRun,
} from '../src/discovery/run-service.js';
import { DiscoveryD3ExecutionError, runDiscoveryD3 } from '../src/discovery/topic-discovery.js';

loadPipelineEnvironment();

async function main(): Promise<void> {
  const { runId, confirmPaid } = parseArguments(process.argv.slice(2));
  if (!confirmPaid) {
    throw new Error(
      'This command calls paid Codex and Firecrawl APIs. Re-run with --confirm-paid.',
    );
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  try {
    let run = await getDiscoveryRun(pool, runId);
    if (!run) throw new Error(`Discovery Run not found: ${runId}`);
    if (!run.selectionOutput) throw new Error('D3 requires persisted D2 selection_output.');
    if (run.executionState.d3?.status !== 'completed') {
      run =
        run.status === 'pending'
          ? await startDiscoveryRun(pool, runId)
          : run.status === 'running'
            ? run
            : await resumeDiscoveryBranchRun(pool, runId);
    }

    const result = await runDiscoveryD3(pool, runId);
    const current = await getDiscoveryRun(pool, runId);
    if (!result.skipped && current?.status === 'running') {
      if (current.executionState.d4?.status === 'completed') {
        await finishDiscoveryRun(pool, runId, {
          status: 'completed',
          hasCandidates: await hasReviewCandidates(pool, runId),
        });
      } else {
        await finishDiscoveryRun(pool, runId, {
          status: 'partial',
          endReason: 'error',
          errorSummary: 'D3 completed, but D4 is not durably marked completed in execution_state.',
        });
      }
    }

    console.log(
      JSON.stringify(
        {
          runId,
          branch: 'd3',
          status: 'completed',
          skipped: result.skipped,
          endReason: result.endReason,
          topics: result.topicCount,
          counts: {
            discovered: result.discoveredCount,
            selected: result.selectedCount,
            rejected: result.rejectedCount,
            unverifiable: result.unverifiableCount,
          },
          agent: {
            provider: result.config.provider,
            model: result.config.model,
            apiMode: result.config.apiMode,
            timeoutMs: result.config.timeoutMs,
            fetchTimeoutMs: result.config.fetchTimeoutMs,
            maxTurns: result.config.maxTurns,
            elapsedMs: result.elapsedMs,
            usage: result.usage,
            traceIds: result.traceIds,
            traceFlushed: result.traceFlushed,
          },
          candidates: await loadD3Candidates(pool, runId),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    const reason = error instanceof DiscoveryD3ExecutionError ? error.endReason : 'error';
    const current = await getDiscoveryRun(pool, runId).catch(() => null);
    if (current?.status === 'running') {
      await finishDiscoveryRun(pool, runId, {
        status: current.executionState.d4?.status === 'completed' ? 'partial' : 'failed',
        endReason: reason === 'timeout' || reason === 'budget_exhausted' ? reason : 'error',
        errorSummary: safeError(error),
      }).catch(() => undefined);
    }
    console.error(
      JSON.stringify(
        { runId, branch: 'd3', status: 'failed', endReason: reason, error: safeError(error) },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function parseArguments(args: string[]): { runId: string; confirmPaid: boolean } {
  let runId: string | null = null;
  let confirmPaid = false;
  for (const argument of args) {
    if (argument === '--confirm-paid') {
      confirmPaid = true;
    } else if (argument.startsWith('--run-id=')) {
      runId = argument.slice('--run-id='.length).trim();
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) {
    throw new Error('--run-id=UUID is required.');
  }
  return { runId, confirmPaid };
}

async function hasReviewCandidates(pool: Pool, runId: string): Promise<boolean> {
  const result = await pool.query(
    `select 1
      from in_depth_candidates idc
      join discovery_candidates dc on dc.id = idc.discovery_candidate_id
      where dc.run_id = $1::uuid
      limit 1`,
    [runId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function loadD3Candidates(pool: Pool, runId: string) {
  const result = await pool.query(
    `select
        dc.id, dc.source_lead_id, dc.url, dc.title, dc.title_zh, dc.author,
        dc.content_type, dc.published_at, dc.estimated_duration_minutes,
        dc.summary, dc.why_worth_reading, dc.evidence, dc.evaluation, dc.status,
        exists (
          select 1 from in_depth_candidates idc
          where idc.discovery_candidate_id = dc.id
        ) as submitted_for_review
      from discovery_candidates dc
      where dc.run_id = $1::uuid and dc.discovery_path = 'topic'
      order by dc.created_at asc, dc.id asc`,
    [runId],
  );
  return result.rows;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_.-]+/g, 'sk-***')
    .slice(0, 2_000);
}

main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
