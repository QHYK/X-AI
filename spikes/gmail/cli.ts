import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gmailAuth } from './auth.js';
import {
  analyze,
  collect,
  DEFAULT_QUERY,
  errorType,
  gmailReader,
  validateSelection,
} from './collector.js';
import { loadPipelineEnvironment } from '../../src/lib/pipeline-env.js';

export function options(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      query: { type: 'string', default: DEFAULT_QUERY },
      limit: { type: 'string', default: '20' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['auth', 'collect', 'analyze'].includes(command))
    throw new Error(
      'Usage: spike:gmail:auth | spike:gmail:collect -- [--query QUERY] [--limit 20] | spike:gmail:analyze',
    );
  const limit = Number(values.limit);
  validateSelection(values.query!, limit);
  return { command, query: values.query!, limit };
}

async function main() {
  const config = options(process.argv.slice(2));
  loadPipelineEnvironment();
  const directory = resolve('runtime/spikes/gmail');
  if (config.command === 'analyze') {
    // No OAuth or Gmail access is required, even if credentials have been removed.
    console.log(JSON.stringify(await analyze(directory), null, 2));
    return;
  }
  const tokenPath = join(directory, 'oauth-token.json');
  const authorization = await gmailAuth(
    resolve(process.env.GMAIL_OAUTH_CLIENT_PATH ?? 'gmail-oauth-client.json'),
    tokenPath,
  );
  const auth = authorization.client;
  if (config.command === 'auth') {
    console.log(
      'Gmail readonly authorization ready. Token stored in ignored runtime/spikes/gmail/oauth-token.json.',
    );
    return;
  }
  try {
    const summary = await collect(gmailReader(auth), directory, config.query, config.limit);
    console.log(JSON.stringify(summary, null, 2));
    if (summary.listError || summary.apiFailed || summary.parseFailed) process.exitCode = 1;
  } finally {
    // Preserve automatically refreshed credentials without logging any token values.
    await authorization.save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Google errors may contain request URLs, tokens or message details; never dump them.
    console.error(`Gmail Spike failed: ${errorType(error)}`);
    process.exitCode = 1;
  });
}
