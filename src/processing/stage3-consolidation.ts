import type { Pool, PoolClient } from 'pg';
import { productionPrompt } from '../lib/prompts/runtime.js';
import { readSystemFragmentFile } from '../lib/prompts/run-file.js';
import { resolveStageLlmProvider } from './llm-client.js';
import { lockDigestOrder } from '../lib/digest-order.js';
import { sameFragmentSnapshot } from './stage3-digest-recovery.js';
import {
  stage3Checkpoints,
  writeStage3Step,
  restoreStage3Prompt,
  stage3Error,
  stage3Hash,
  type Stage3Step,
} from './stage3-progress.js';
import {
  CONSOLIDATION_KEY,
  validateConsolidation,
  runStage3Consolidation,
  ConsolidationCallError,
  type ConsolidationInput,
  type ConsolidationResult,
  type ConsolidationOutput,
} from './stage3-consolidation-llm.js';

export class ConsolidationPersistenceError extends Error {
  constructor(
    message: string,
    readonly step: Stage3Step,
    readonly metrics: Omit<ConsolidationResult, 'output'>,
  ) {
    super(message);
  }
}
export async function consolidateDigestCategory(
  pool: Pool,
  options: {
    runId: string;
    dailyDate: string;
    reviewRunId: string;
    path: string;
    model: string;
    input: ConsolidationInput;
    invoke?: typeof runStage3Consolidation;
  },
): Promise<{
  success: boolean;
  error: string | null;
  metrics: Omit<ConsolidationResult, 'output'>;
}> {
  const { input, runId, dailyDate, reviewRunId } = options;
  const zero = { calls: 0, retries: 0, durationMs: 0, tokenUsage: null };
  let state: Stage3Step = {
    status: 'running',
    input_hash: stage3Hash(input),
    event_review_run_id: reviewRunId,
    category: input.category,
    candidate_count: input.candidates.length,
    model: options.model,
    provider: resolveStageLlmProvider('stage3'),
    llm_calls: 0,
    retries: 0,
    duration_ms: 0,
    error: null,
  };
  if (input.category === 'Science') {
    await writeStage3Step(pool, runId, 'consolidation', input.category, {
      ...state,
      status: 'skipped',
      reason: 'science_excluded',
    });
    return { success: true, error: null, metrics: zero };
  }
  // Hash the remaining input as well: successful routing changes remove matched candidates from future reads.
  for (const prior of await stage3Checkpoints(pool, dailyDate, 'consolidation', input.category)) {
    const d = prior.detail;
    if (d.event_review_run_id !== reviewRunId || d.remaining_hash !== stage3Hash(input)) continue;
    let output: ConsolidationOutput;
    try {
      output = validateConsolidation(
        { matches: d.matches },
        {
          ...input,
          candidates: (d.input_ids as string[]).map((id) => ({
            id,
            title: '',
            summary: '',
            source: '',
          })),
        },
      );
    } catch {
      continue;
    }
    const matches = output.matches.flatMap((m) =>
      m.digest_content_ids.map((id) => ({ id, group: m.event_group_id })),
    );
    const valid = await pool.query<{ id: string; event_group_id: string }>(
      `select pc.id, egi.event_group_id from processed_contents pc join event_group_items egi on egi.processed_content_id=pc.id
       where pc.daily_date=$1::date and pc.routing='event' and pc.id=any($2::uuid[])`,
      [dailyDate, matches.map((m) => m.id)],
    );
    if (
      !matches.every((m) => valid.rows.some((r) => r.id === m.id && r.event_group_id === m.group))
    )
      continue;
    await restoreStage3Prompt(pool, options.path, CONSOLIDATION_KEY, d);
    const snapshot = await readSystemFragmentFile(options.path);
    const prompt = await productionPrompt(CONSOLIDATION_KEY, JSON.stringify(input));
    if (
      prompt.versionId !== d.prompt_version_id ||
      !sameFragmentSnapshot(snapshot ?? null, d.system_fragment_versions)
    )
      continue;
    await writeStage3Step(pool, runId, 'consolidation', input.category, {
      ...d,
      status: 'skipped',
      source_run_id: prior.id,
      llm_calls: 0,
      retries: 0,
      duration_ms: 0,
      token_usage: null,
    });
    return { success: true, error: null, metrics: zero };
  }
  if (!input.events.length || !input.candidates.length) {
    await writeStage3Step(pool, runId, 'consolidation', input.category, {
      ...state,
      status: 'skipped',
      reason: input.events.length ? 'no_digest' : 'no_events',
    });
    return { success: true, error: null, metrics: zero };
  }
  const prompt = await productionPrompt(CONSOLIDATION_KEY, JSON.stringify(input));
  state = {
    ...state,
    prompt_version_id: prompt.versionId,
    system_fragment_versions: (await readSystemFragmentFile(options.path)) ?? null,
  };
  await writeStage3Step(pool, runId, 'consolidation', input.category, state);
  let result: ConsolidationResult;
  let observed: Omit<ConsolidationResult, 'output'> = zero;
  try {
    result = await (options.invoke ?? runStage3Consolidation)(input, { model: options.model });
    observed = result;
    result.output = validateConsolidation(result.output, input);
  } catch (error) {
    const metrics = error instanceof ConsolidationCallError ? error.metrics : observed;
    const message = stage3Error(error);
    await writeStage3Step(pool, runId, 'consolidation', input.category, {
      ...state,
      status: 'failed',
      error: message,
      llm_calls: metrics.calls,
      retries: metrics.retries,
      duration_ms: metrics.durationMs,
      token_usage: metrics.tokenUsage,
    });
    return { success: false, error: message, metrics };
  }
  const matched = new Set(result.output.matches.flatMap((m) => m.digest_content_ids));
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('begin');
    await lockDigestOrder(client);
    const groups = await client.query<{ id: string; event_hint: string }>(
      'select id,event_hint from event_groups where daily_date=$1::date and id=any($2::uuid[]) for share',
      [dailyDate, input.events.map((e) => e.event_group_id)],
    );
    if (
      groups.rows.length !== input.events.length ||
      !input.events.every((e) =>
        groups.rows.some((g) => g.id === e.event_group_id && g.event_hint === e.hint),
      )
    )
      throw new Error('Consolidation Event Group snapshot changed.');
    const candidates = await client.query(
      `select id from processed_contents where daily_date=$1::date and category=$2 and routing='digest' and id=any($3::uuid[]) for update`,
      [dailyDate, input.category, input.candidates.map((c) => c.id)],
    );
    if (candidates.rows.length !== input.candidates.length)
      throw new Error('Consolidation Digest membership changed.');
    for (const match of result.output.matches)
      for (const id of match.digest_content_ids) {
        const changed = await client.query(
          `update processed_contents set routing='event',updated_at=now() where id=$1::uuid and daily_date=$2::date and routing='digest'`,
          [id, dailyDate],
        );
        if (changed.rowCount !== 1)
          throw new Error('Consolidation routing update did not affect one Digest.');
        const inserted = await client.query(
          `insert into event_group_items(event_group_id,processed_content_id) values($1::uuid,$2::uuid) on conflict do nothing`,
          [match.event_group_id, id],
        );
        await client.query(
          `insert into feedback(target_type,target_id,feedback_type,before_value,after_value) values('processed_content',$1::uuid,'routing_error',$2::jsonb,$3::jsonb)`,
          [
            id,
            JSON.stringify({ routing: 'digest', daily_date: dailyDate, category: input.category }),
            JSON.stringify({
              routing: 'event',
              event_group_id: match.event_group_id,
              daily_date: dailyDate,
              review_run_id: reviewRunId,
              pipeline_run_id: runId,
              source: 'stage3_consolidation',
              membership_added: inserted.rowCount === 1,
            }),
          ],
        );
      }
    await writeStage3Step(client, runId, 'consolidation', input.category, {
      ...state,
      status: 'success',
      input_ids: input.candidates.map((c) => c.id),
      matches: result.output.matches,
      matched_count: matched.size,
      matched_content_ids: [...matched],
      remaining_hash: stage3Hash({
        ...input,
        candidates: input.candidates.filter((c) => !matched.has(c.id)),
      }),
      llm_calls: result.calls,
      retries: result.retries,
      duration_ms: result.durationMs,
      token_usage: result.tokenUsage,
    });
    await client.query('commit');
  } catch (error) {
    if (client) await client.query('rollback');
    const message = stage3Error(error);
    throw new ConsolidationPersistenceError(
      message,
      {
        ...state,
        status: 'failed',
        error: message,
        failure_phase: 'persistence',
        llm_calls: result.calls,
        retries: result.retries,
        duration_ms: result.durationMs,
        token_usage: result.tokenUsage,
      },
      result,
    );
  } finally {
    client?.release();
  }
  return { success: true, error: null, metrics: result };
}
