import { databasePoolOptions } from '../src/db/pool-options.js';
import { Pool } from 'pg';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { submitDiscoveryJob } from '../src/discovery/background-jobs.js';
import { submitScheduledDiscovery } from '../src/discovery/scheduled.js';

loadPipelineEnvironment();

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    await submitScheduledDiscovery(new Date(), async (input) => {
      if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
      pool = new Pool({
        ...databasePoolOptions('submission'),
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
      return submitDiscoveryJob(pool, input);
    });
  } finally {
    await pool?.end();
  }
}

main().catch((error) => {
  console.error('Scheduled Discovery submission failed.', error);
  process.exitCode = 1;
});
