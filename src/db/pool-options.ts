import type { PoolConfig } from 'pg';

/** Per-process budgets, not a claim about the database server's connection allowance. */
export function databasePoolOptions(profile: 'web' | 'worker' | 'cli' | 'submission'): PoolConfig {
  return {
    // Agent executors retain pg's existing 10-client budget: one execution-lock session
    // plus business queries and concurrent Fetch Cache transactions spanning network I/O.
    // Web has a bounded request budget; Scheduled submission only needs one transaction.
    max: { web: 5, worker: 10, cli: 10, submission: 1 }[profile],
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  };
}
