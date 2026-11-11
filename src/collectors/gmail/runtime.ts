/** Shared CLI / Daily entry. Credentials stay server-side; unattended Daily never opens OAuth UI. */
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { gmailAuth } from './auth.js';
import { collectGmailNewsletters, gmailReader } from './collector.js';
export const GMAIL_DEFAULT_QUERY = 'label:news-letter newer_than:3d';
export const GMAIL_DEFAULT_LIMIT = 20;
export async function collectConfiguredGmail(
  pool: Pool,
  options: { query?: string; limit?: number; dryRun?: boolean; interactive?: boolean } = {},
) {
  const auth = await gmailAuth(
    resolve(process.env.GMAIL_OAUTH_CLIENT_PATH ?? 'gmail-oauth-client.json'),
    resolve(process.env.GMAIL_OAUTH_TOKEN_PATH ?? 'runtime/spikes/gmail/oauth-token.json'),
    { interactive: options.interactive ?? false },
  );
  try {
    return await collectGmailNewsletters(pool, gmailReader(auth.client), {
      query: options.query ?? GMAIL_DEFAULT_QUERY,
      limit: options.limit ?? GMAIL_DEFAULT_LIMIT,
      dryRun: options.dryRun,
    });
  } finally {
    await auth.save();
  }
}
