import type { Pool, PoolClient } from 'pg';
import { setTimeout as delay } from 'node:timers/promises';

export class ReadMoreWaitTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for Read More generation; please retry.');
    this.name = 'ReadMoreWaitTimeoutError';
  }
}

/** Requires a direct PostgreSQL connection or session pooling, never transaction pooling. */
export async function withReadMoreSingleflight<T>(
  pool: Pool,
  contentId: string,
  work: (client: PoolClient, signal: AbortSignal) => Promise<T>,
  waitTimeoutMs = 130_000,
): Promise<T> {
  const connectionString = pool.options?.connectionString;
  if (connectionString) {
    const url = new URL(connectionString);
    if (
      url.searchParams.get('pgbouncer') === 'true' ||
      (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543')
    ) {
      throw new Error('Read More singleflight requires direct PostgreSQL or Session Pooling.');
    }
  }
  const deadline = Date.now() + waitTimeoutMs;
  // UUID spelling must not split the lock namespace (PostgreSQL UUIDs are case insensitive).
  const key = `read-more:${contentId.trim().toLowerCase()}`;
  while (Date.now() < deadline) {
    const client = await pool.connect();
    const controller = new AbortController();
    let connectionError: Error | undefined;
    let locked = false;
    const onError = (error: Error) => {
      connectionError = error;
      controller.abort(error);
    };
    client.on('error', onError);
    try {
      if (Date.now() >= deadline) throw new ReadMoreWaitTimeoutError();
      // No blocking lock query: waiting callers return their client between attempts.
      const lockQuery = {
        text: 'select pg_try_advisory_lock(hashtextextended($1, 0)) as locked',
        values: [key],
        query_timeout: 5000,
      };
      const result = await client.query<{ locked: boolean }>(lockQuery);
      locked = result.rows[0]?.locked === true;
      if (locked) {
        controller.signal.throwIfAborted();
        const value = await work(client, controller.signal);
        controller.signal.throwIfAborted();
        return value;
      }
    } catch (error) {
      // A failed/timed-out query may have acquired a lock without delivering its response.
      // Destroy this session rather than returning unknown lock ownership to the Pool.
      connectionError ??= error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      try {
        if (locked && !connectionError) {
          const unlockQuery = {
            text: 'select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked',
            values: [key],
            query_timeout: 5000,
          };
          const result = await client.query<{ unlocked: boolean }>(unlockQuery);
          if (result.rows[0]?.unlocked !== true) {
            throw new Error('Read More generation lock ownership was lost.');
          }
        }
      } catch (error) {
        connectionError = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(connectionError);
        client.removeListener('error', onError);
      }
    }
    await delay(Math.min(100, Math.max(0, deadline - Date.now())));
  }
  throw new ReadMoreWaitTimeoutError();
}
