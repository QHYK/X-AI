import type { Pool } from 'pg';
import { Message, parseMessage } from './mail.js';
import { gmailReader, validateSelection, errorType, type GmailReader } from './client.js';
import { newsletterRawArticles } from './adapter.js';
import { newsletterSource } from './newsletter-source.js';
import { NEWSLETTER_SOURCE_NAMES } from './sources.js';
import { saveFetchedEmail, processStoredEmail } from './email-store.js';

export { gmailReader };
export type GmailCollectionWarning = {
  type: 'unsupported_template';
  gmail_message_id: string;
  stage: string;
  message: string;
};

/** Bounded manual intake. No Pipeline invocation, attachment fetch or external article requests. */
export async function collectGmailNewsletters(
  pool: Pool,
  reader: GmailReader,
  options: { query: string; limit: number; dryRun?: boolean; now?: Date },
) {
  validateSelection(options.query, options.limit);

  const now = options.now ?? new Date();
  const window = {
    startAt: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
    endAt: now.toISOString(),
  };
  let selectionQuery = options.query;
  let labelError: unknown;
  try {
    if (selectionQuery.split(/\s/, 1)[0] === 'label:news-letter' && reader.labels) {
      const labels = (await reader.labels()).filter(
        (l) => l.name.replace(/[\s_-]+/g, '').toLowerCase() === 'newsletter',
      );
      if (labels.length !== 1) throw new Error('gmail_newsletter_label_missing_or_ambiguous');
      selectionQuery = `label:${JSON.stringify(labels[0].name)}${selectionQuery.slice('label:news-letter'.length)}`;
    }
  } catch (error) {
    labelError = error;
  }
  const query = `(${selectionQuery}) after:${Math.floor(new Date(window.startAt).getTime() / 1000) - 1} before:${Math.ceil(new Date(window.endAt).getTime() / 1000) + 1}`;
  const summary = {
    window,
    retried: 0,
    query: query.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi, '[email-redacted]'),
    limit: options.limit,
    listRequests: 0,
    fetched: 0,
    savedEmails: 0,
    newEmails: 0,
    outcomes: { collected: 0, success: 0, unsupported: 0, skipped: 0, failed: 0, conflict: 0 },
    warning_count: 0,
    warnings: [] as GmailCollectionWarning[],
    unsupported: 0,
    conflicts: 0,
    parsed: 0,
    units: 0,
    planned: 0,
    inserted: 0,
    skipped: 0,
    ignoredMessages: 0,
    failures: [] as { id: string | null; stage: string; error: string }[],
  };
  if (labelError) summary.failures.push({ id: null, stage: 'label', error: errorType(labelError) });
  const observed = new Set<string>();
  const ids = new Set<string>(),
    pages = new Set<string>();
  let page: string | undefined;
  if (!labelError)
    do {
      let response: Awaited<ReturnType<GmailReader['list']>>;
      try {
        summary.listRequests++;
        response = await reader.list(query, page, Math.min(100, options.limit - ids.size));
      } catch (error) {
        summary.failures.push({ id: null, stage: 'list', error: errorType(error) });
        break;
      }
      for (const message of response.messages ?? []) {
        if (!message.id || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.id)) {
          summary.failures.push({ id: null, stage: 'list', error: 'gmail_invalid_message_id' });
          continue;
        }
        ids.add(message.id);
        if (ids.size >= options.limit) break;
      }
      page = response.nextPageToken;
      if (page && (pages.has(page) || pages.size >= options.limit * 2)) {
        summary.failures.push({
          id: null,
          stage: 'list',
          error: 'gmail_pagination_limit_or_cycle',
        });
        break;
      }
      if (page) pages.add(page);
    } while (page && ids.size < options.limit);
  for (const id of ids) {
    let stage = 'fetch';
    try {
      const raw = await reader.get(id);
      summary.fetched++;
      if (!raw || typeof raw !== 'object' || (raw as { id?: string }).id !== id)
        throw new Error('gmail_message_id_mismatch');
      if (!options.dryRun) {
        stage = 'save_email';
        if (await saveFetchedEmail(pool, id, raw as import('./mail.js').GmailMessage))
          summary.newEmails++;
        observed.add(id);
        summary.savedEmails++;
        continue;
      }
      stage = 'parse';
      const mail = await parseMessage(Message.parse(raw));
      if (mail.parseStatus !== 'success') throw new Error('gmail_mime_incomplete');
      if (!NEWSLETTER_SOURCE_NAMES[newsletterSource(mail)])
        throw new Error('gmail_unsupported_source');
      const articles = newsletterRawArticles(mail);
      summary.parsed++;
      summary.units += articles.length;
      summary.planned += articles.length;
      if (!articles.length) summary.ignoredMessages++;
    } catch (error) {
      // Never dump Google/PG Error objects: request details may contain credentials or email bodies.
      const diagnostic =
        stage === 'fetch'
          ? errorType(error)
          : error instanceof Error &&
              /^(gmail_[a-z_]+|No source-guided units:.*|Incomplete source-guided unit:.*|Newsletter.*|An enabled Email Source is required)$/.test(
                error.message,
              )
            ? error.message.slice(0, 300)
            : `${stage}_failed${typeof (error as { code?: unknown })?.code === 'string' ? `_${(error as { code: string }).code}` : ''}`;
      summary.failures.push({ id, stage, error: diagnostic });
    }
  }
  if (!options.dryRun) {
    const pending = await pool.query<{ gmail_message_id: string }>(
      `select gmail_message_id from newsletter_emails where received_at >= $1::timestamptz and received_at <= $2::timestamptz and imported_at is null and parse_status in ('collected','unsupported','failed') order by received_at,gmail_message_id`,
      [window.startAt, window.endAt],
    );
    for (const { gmail_message_id: id } of pending.rows) {
      observed.add(id);
      try {
        const result = await processStoredEmail(pool, id, { window });
        summary.retried++;
        summary.units += result.units;
        summary.planned += result.units;
        summary.inserted += result.inserted;
        summary.skipped += result.skipped;
        if (result.status === 'success' || result.status === 'skipped') summary.parsed++;
        if (result.status === 'skipped') summary.ignoredMessages++;
        if (result.status === 'unsupported') summary.unsupported++;
        if (result.status === 'conflict') summary.conflicts++;
        if ('error' in result) {
          // Only a safely persisted message with unsupported source/template is informational.
          // MIME, Source configuration, unit validation and persistence errors remain failures.
          const unsupportedTemplate =
            result.status === 'unsupported' &&
            ((result.stage === 'parse' && result.error?.startsWith('No source-guided units:')) ||
              (result.stage === 'source' && result.error === 'Newsletter source is not supported'));
          if (unsupportedTemplate)
            summary.warnings.push({
              type: 'unsupported_template',
              gmail_message_id: id,
              stage: result.stage!,
              message: result.error!,
            });
          else
            summary.failures.push({
              id,
              stage: result.stage ?? 'parse',
              error: result.error ?? 'parse_failed',
            });
        }
      } catch (error) {
        summary.failures.push({ id, stage: 'process', error: errorType(error) });
      }
    }
  }
  if (!options.dryRun && observed.size) {
    const states = await pool.query<{ parse_status: keyof typeof summary.outcomes; count: number }>(
      `select parse_status,count(*)::int as count from newsletter_emails where gmail_message_id=any($1::text[]) group by parse_status`,
      [[...observed]],
    );
    for (const state of states.rows) summary.outcomes[state.parse_status] = state.count;
  }
  summary.warning_count = summary.warnings.length;
  return summary;
}
