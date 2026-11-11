import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  collectConfiguredGmail,
  GMAIL_DEFAULT_QUERY,
  GMAIL_DEFAULT_LIMIT,
} from '../src/collectors/gmail/runtime.js';
import { errorType, validateSelection } from '../src/collectors/gmail/client.js';
import { loadPipelineEnvironment } from '../src/lib/pipeline-env.js';
import { databasePoolOptions } from '../src/db/pool-options.js';
export function parseGmailOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      query: { type: 'string', default: GMAIL_DEFAULT_QUERY },
      limit: { type: 'string', default: String(GMAIL_DEFAULT_LIMIT) },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const options = { query: values.query!, limit: Number(values.limit), dryRun: values['dry-run'] };
  validateSelection(options.query, options.limit);
  return options;
}
async function main() {
  const options = parseGmailOptions(process.argv.slice(2));
  loadPipelineEnvironment();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({
    ...databasePoolOptions('cli'),
    max: 2,
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    const report = await collectConfiguredGmail(pool, { ...options, interactive: true });
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      'Gmail collection failed:',
      error instanceof Error &&
        (error.message.startsWith('Newsletter Source mapping missing or ambiguous:') ||
          error.message === 'DATABASE_URL is required')
        ? error.message
        : errorType(error),
    );
    process.exitCode = 1;
  });
