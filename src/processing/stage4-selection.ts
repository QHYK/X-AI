import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import {
  productionPrompt,
  withPromptBindings,
  databasePromptBinder,
} from '../lib/prompts/runtime.js';
import { createLlmClient, resolveStageLlmModel, resolveStageLlmProvider } from './llm-client.js';
import { resolveStageLlmRuntimeConfig } from './stage-llm-runtime-config.js';
import {
  emptyLlmTokenUsage,
  mergeLlmTokenUsage,
  usageFromProvider,
  type LlmTokenUsage,
} from './llm-token-usage.js';
import { loadStage4RecentEvents } from './stage4-event-processing.js';
import { DEFAULT_STAGE4_EVENT_LIMIT } from './stage4-config.js';
import type { Stage4SelectedEvent } from './stage4-persistence.js';

export const STAGE4_SELECTION_POOL_SIZE = 20;
const STAGE4_PUBLISH_LIMIT = DEFAULT_STAGE4_EVENT_LIMIT;
const Candidate = z.object({
  reviewRunId: z.uuid(),
  reviewItemId: z.uuid(),
  eventGroupId: z.uuid(),
  eventHint: z.string(),
  aiRank: z.number().int(),
  displayRank: z.number().int(),
  processedContentIds: z.array(z.uuid()),
});
const Snapshot = z.object({
  candidates: z.array(Candidate).max(STAGE4_SELECTION_POOL_SIZE),
  status: z.enum(['pending', 'success', 'fallback', 'skipped']),
  duplicate_ids: z.array(z.uuid()),
  selected_ids: z.array(z.uuid()).max(STAGE4_PUBLISH_LIMIT),
  calls: z.number().int().min(0).max(3),
  errors: z.array(z.string()),
  reason: z.string().nullable(),
});
export type Stage4SelectionSnapshot = z.infer<typeof Snapshot>;
export const Stage4DedupOutputSchema = z.object({ duplicate_ids: z.array(z.string()) }).strict();
export function pendingStage4Selection(candidates: Stage4SelectedEvent[]): Stage4SelectionSnapshot {
  return readStage4Selection({
    candidates,
    status: 'pending',
    duplicate_ids: [],
    selected_ids: [],
    calls: 0,
    errors: [],
    reason: null,
  });
}
export function readStage4Selection(value: unknown): Stage4SelectionSnapshot {
  const snapshot = Snapshot.parse(value);
  const ids = snapshot.candidates.map((c) => c.eventGroupId);
  const refs = snapshot.candidates.map((c) => c.reviewItemId);
  if (new Set(ids).size !== ids.length || new Set(refs).size !== refs.length)
    throw new Error('Invalid Stage4 selection candidate identities.');
  for (const list of [snapshot.duplicate_ids, snapshot.selected_ids])
    if (new Set(list).size !== list.length || list.some((id) => !ids.includes(id)))
      throw new Error('Invalid Stage4 selection IDs.');
  if (snapshot.status !== 'pending') {
    const expected = ids
      .filter((id) => !snapshot.duplicate_ids.includes(id))
      .slice(0, STAGE4_PUBLISH_LIMIT);
    if (JSON.stringify(expected) !== JSON.stringify(snapshot.selected_ids))
      throw new Error('Invalid Stage4 selection order.');
  }
  return snapshot;
}
export function selectedStage4Candidates(snapshot: Stage4SelectionSnapshot): Stage4SelectedEvent[] {
  if (snapshot.status === 'pending') throw new Error('Stage4 selection has not completed.');
  return snapshot.candidates.filter((c) => snapshot.selected_ids.includes(c.eventGroupId));
}

type Request = ReturnType<typeof createLlmClient>['structured']['create'];
export async function deduplicateStage4Events(
  initial: Stage4SelectionSnapshot,
  recentEvents: Array<{ title: string; summary: string }>,
  options: { model?: string; request?: Request; assertAlive?: () => void } = {},
): Promise<{ snapshot: Stage4SelectionSnapshot; usage: LlmTokenUsage; durationMs: number }> {
  const snapshot = structuredClone(initial);
  let usage = emptyLlmTokenUsage();
  let durationMs = 0;
  if (!recentEvents.length) {
    snapshot.status = 'skipped';
    snapshot.reason = 'no_recent_events';
  } else {
    // Prompt loading/binding errors are configuration failures, not model failures.
    // In particular, never silently fallback when a new Registry has not been activated.
    const prompt = await productionPrompt(
      'daily.stage4.event_dedup',
      JSON.stringify({
        candidates: snapshot.candidates.map((c) => ({
          id: c.eventGroupId,
          event_hint: c.eventHint,
        })),
        recent_events: recentEvents,
      }),
    );
    const config = resolveStageLlmRuntimeConfig('stage4');
    const client = options.request
      ? null
      : createLlmClient({
          provider: resolveStageLlmProvider('stage4'),
          timeoutMs: config.timeoutMs,
          maxRetries: 0,
        });
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        options.assertAlive?.();
        const started = Date.now();
        snapshot.calls++;
        let receivedUsage = false;
        try {
          const response = await (options.request ?? client!.structured.create)({
            model: resolveStageLlmModel('stage4', options.model),
            ...(prompt.instructions ? { instructions: prompt.instructions } : {}),
            input: prompt.input,
            max_output_tokens: 2000,
            store: false,
            text: {
              format: {
                type: 'json_schema',
                name: 'stage4_event_dedup',
                strict: true,
                schema: z.toJSONSchema(Stage4DedupOutputSchema),
              },
            },
          });
          usage = mergeLlmTokenUsage(usage, usageFromProvider(response.usage));
          receivedUsage = true;
          const { duplicate_ids } = Stage4DedupOutputSchema.parse(JSON.parse(response.output_text));
          const ids = new Set(snapshot.candidates.map((c) => c.eventGroupId));
          if (
            new Set(duplicate_ids).size !== duplicate_ids.length ||
            duplicate_ids.some((id) => !ids.has(id))
          )
            throw new Error('Dedup returned duplicate or unknown Event Group IDs.');
          snapshot.duplicate_ids = duplicate_ids;
          snapshot.status = 'success';
          break;
        } catch (error) {
          if (!receivedUsage) usage = mergeLlmTokenUsage(usage, usageFromProvider(undefined));
          const message = error instanceof Error ? error.message : String(error);
          snapshot.errors.push(message);
          console.error('Stage4 Dedup attempt failed.', {
            attempt: snapshot.calls,
            error: message,
          });
        } finally {
          durationMs += Date.now() - started;
          options.assertAlive?.();
        }
      }
    } finally {
      await client?.close();
    }
    if (snapshot.status === 'pending') {
      snapshot.status = 'fallback';
      snapshot.reason = 'dedup_fallback';
    }
  }
  snapshot.selected_ids = snapshot.candidates
    .filter((c) => !snapshot.duplicate_ids.includes(c.eventGroupId))
    .slice(0, STAGE4_PUBLISH_LIMIT)
    .map((c) => c.eventGroupId);
  return { snapshot: readStage4Selection(snapshot), usage, durationMs };
}

/** One session lock per Run, with no database transaction across model I/O.
 * Direct PostgreSQL / session pooling is required, as for the existing Worker locks.
 * Competing executors fail explicitly; completed snapshots are reused on retry.
 */
export async function resolveStage4Selection(
  pool: Pool,
  runId: string,
  dailyDate: string,
  model?: string,
) {
  const url = pool.options?.connectionString ? new URL(pool.options.connectionString) : null;
  if (
    url &&
    (url.searchParams.get('pgbouncer') === 'true' ||
      (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543'))
  )
    throw new Error('Stage4 Dedup requires direct PostgreSQL or session pooling.');
  const client = await pool.connect();
  const lockKey = `stage4-selection:${runId.toLowerCase()}`;
  let locked = false;
  let pending = false;
  let lost: Error | undefined;
  const onError = (error: Error) => {
    lost = error;
  };
  client.on('error', onError);
  try {
    locked =
      (
        await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
          [lockKey],
        )
      ).rows[0]?.locked === true;
    if (!locked)
      throw new Error('Stage4 selection is already executing; retry after it completes.');
    const stored = await client.query<{ selection_snapshot: unknown; daily_date: string }>(
      'select selection_snapshot, daily_date::text from stage4_runs where id=$1::uuid',
      [runId],
    );
    if (!stored.rows[0] || stored.rows[0].daily_date !== dailyDate)
      throw new Error('Stage4 Run/date mismatch.');
    if (stored.rows[0].selection_snapshot == null) return null; // Historical / independent manual Run.
    const snapshot = readStage4Selection(stored.rows[0].selection_snapshot);
    if (snapshot.status !== 'pending')
      return { snapshot, calls: 0, usage: emptyLlmTokenUsage(), durationMs: 0 };
    pending = true;
    const history = await loadStage4RecentEvents(client, dailyDate);
    // Reuse the lock session for the binder's short transactions; never acquire
    // a second Pool client while holding this one across model I/O.
    const bindingDb = {
      connect: async () => ({ query: client.query.bind(client), release() {} }) as PoolClient,
    };
    const result = await withPromptBindings(
      client,
      databasePromptBinder(bindingDb, 'stage4', runId),
      () =>
        deduplicateStage4Events(snapshot, history, {
          model,
          assertAlive: () => {
            if (lost) throw lost;
          },
        }),
    );
    if (lost) throw lost;
    const saved = await client.query(
      `update stage4_runs set selection_snapshot=$2::jsonb, expected_count=$3, status='running', completed_at=null where id=$1::uuid and selection_snapshot->>'status'='pending' and status <> 'success'`,
      [runId, JSON.stringify(result.snapshot), result.snapshot.selected_ids.length],
    );
    if (saved.rowCount !== 1)
      throw new Error('Stage4 selection changed before save; retry without overwriting it.');
    return { ...result, calls: result.snapshot.calls };
  } catch (error) {
    // Destroy sessions with uncertain ownership after connection/query failures.
    if (!locked) lost ??= error instanceof Error ? error : new Error(String(error));
    if (locked && pending && !lost) {
      try {
        await client.query(
          "update stage4_runs set status='failed', completed_at=now() where id=$1::uuid and status <> 'success' and selection_snapshot->>'status'='pending'",
          [runId],
        );
      } catch (statusError) {
        console.error('Stage4 selection failure status could not be saved.', statusError);
      }
    }
    throw error;
  } finally {
    try {
      if (locked && !lost) {
        const result = await client.query<{ unlocked: boolean }>(
          'select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked',
          [lockKey],
        );
        if (!result.rows[0]?.unlocked) lost = new Error('Stage4 selection lock was lost.');
      }
    } catch (error) {
      lost = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (lost) console.error('Stage4 selection lock session discarded.', { error: lost.message });
      client.release(lost);
      client.removeListener('error', onError);
    }
  }
}
