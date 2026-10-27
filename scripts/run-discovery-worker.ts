import { databasePoolOptions } from '../src/db/pool-options.js';
import { Pool } from 'pg';
import { setTimeout } from 'node:timers/promises';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { processNextDiscoveryJob } from '../src/discovery/background-jobs.js';

loadPipelineEnvironment();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = new Pool({
  ...databasePoolOptions('worker'),
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
try {
  while (!stopping) {
    if (!(await processNextDiscoveryJob(pool))) await setTimeout(2000);
  }
} finally {
  await pool.end();
}
