import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { databasePoolOptions } from '../src/db/pool-options.js';
import { processStoredEmail, safeIntakeError } from '../src/collectors/gmail/email-store.js';
const { values } = parseArgs({
  options: {
    id: { type: 'string', multiple: true },
    limit: { type: 'string', default: '20' },
  },
});
const limit = Number(values.limit);
if (
  !Number.isInteger(limit) ||
  limit < 1 ||
  limit > 200 ||
  !values.id?.length ||
  values.id?.some((id) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
)
  throw new Error('Use --id <saved-message-id> (repeatable) with --limit 1..200');
loadPipelineEnvironment();
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({
  ...databasePoolOptions('cli'),
  max: 2,
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
try {
  const ids = values.id!;
  for (const id of [...new Set(ids)].slice(0, limit)) {
    try {
      const result = await processStoredEmail(pool, id);
      console.log(JSON.stringify({ id, ...result }));
      if ('error' in result || result.status === 'conflict') process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ id, error: safeIntakeError(error) }));
      process.exitCode = 1;
    }
  }
} finally {
  await pool.end();
}
