/** Durable Gmail intake. No credentials, attachment downloads or Pipeline invocation. */
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { header, parseMessage, type GmailMessage } from './mail.js';
import { newsletterSource } from './newsletter-source.js';
import { NEWSLETTER_SOURCE_NAMES } from './sources.js';
import { newsletterRawArticles } from './adapter.js';
import { SOURCE_RULE_VERSION } from './source-guided-selection.js';
import { persistNewsletterArticlesInTransaction } from '../newsletter.js';
import type { NormalizedRawArticle } from '../raw-articles.js';
export type EmailStatus =
  'collected' | 'success' | 'skipped' | 'unsupported' | 'conflict' | 'failed';
export type ModuleMapping = { unit_id: string; raw_id: string; fingerprint: string };
export type StoredEmail = {
  gmail_message_id: string;
  raw_message: GmailMessage;
  subject: string | null;
  sender: string | null;
  received_at: Date | string | null;
  collected_at: Date | string;
  source_id: string | null;
  source_name: string | null;
  parse_status: EmailStatus;
  parser_version: number | null;
  module_mapping: ModuleMapping[];
  error_stage: string | null;
  error_message: string | null;
  parsed_at: Date | string | null;
  imported_at: Date | string | null;
};
export class NewsletterIntakeError extends Error {
  constructor(
    readonly status: 'unsupported' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}
export const safeIntakeError = (error: unknown) =>
  error instanceof NewsletterIntakeError
    ? error.message
    : error instanceof Error &&
        /^(gmail_[a-z_]+|No source-guided units:|Incomplete source-guided unit:)/.test(
          error.message,
        )
      ? error.message.slice(0, 300)
      : `operation_failed${typeof (error as { code?: unknown })?.code === 'string' ? `_${(error as { code: string }).code}` : ''}`;
function safeHeader(raw: GmailMessage, name: string) {
  return Array.isArray(raw.payload?.headers)
    ? header(
        {
          ...raw.payload,
          headers: raw.payload.headers.filter(
            (h) => h && typeof h.name === 'string' && typeof h.value === 'string',
          ),
        },
        name,
      )
    : null;
}
/** Preserve the first successful fetch, including complete inline MIME bodies, before decoding. */
export async function saveFetchedEmail(db: Pick<Pool, 'query'>, id: string, raw: GmailMessage) {
  if (raw.id !== id) throw new Error('gmail_message_id_mismatch');
  const ms = Number(raw.internalDate),
    date =
      raw.internalDate && Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime())
        ? new Date(ms)
        : null;
  const result = await db.query(
    `insert into newsletter_emails(gmail_message_id,raw_message,subject,sender,received_at,parse_status,error_stage,error_message) values($1,$2::jsonb,$3,$4,$5,$6,$7,$8) on conflict(gmail_message_id) do nothing`,
    [
      id,
      JSON.stringify(raw),
      safeHeader(raw, 'subject'),
      safeHeader(raw, 'from'),
      date,
      date ? 'collected' : 'unsupported',
      date ? null : 'receive',
      date ? null : 'gmail_received_at_missing',
    ],
  );
  return result.rowCount === 1;
}
export async function getStoredEmail(db: Pick<Pool, 'query'>, id: string) {
  return (
    (await db.query<StoredEmail>('select * from newsletter_emails where gmail_message_id=$1', [id]))
      .rows[0] ?? null
  );
}
export async function listStoredEmails(db: Pick<Pool, 'query'>, source: string, status: string) {
  return (
    await db.query<Omit<StoredEmail, 'raw_message'>>(
      `with ranked_emails as (
        select gmail_message_id,subject,sender,received_at,collected_at,source_id,source_name,parse_status,parser_version,module_mapping,error_stage,error_message,parsed_at,imported_at,
          row_number() over (partition by coalesce(source_name,'Unknown') order by received_at desc nulls last,gmail_message_id) as source_rank
        from newsletter_emails
        where ($1='' or coalesce(source_name,'Unknown')=$1) and ($2='' or parse_status=$2)
      ) select * from ranked_emails where source_rank <= 5
        order by received_at desc nulls last,gmail_message_id`,
      [source, status],
    )
  ).rows;
}
export function moduleFingerprint(article: NormalizedRawArticle) {
  const meta = article.metadata?.newsletter as
    | { content_type?: string; source_range?: { start_offset: number; end_offset: number } }
    | undefined;
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: article.title,
        url: article.url,
        body: article.contentText,
        publishedAt: article.publishedAt?.toISOString() ?? null,
        type: meta?.content_type,
        start: meta?.source_range?.start_offset,
        end: meta?.source_range?.end_offset,
      }),
    )
    .digest('hex');
}
type Existing = {
  id: string;
  source_id: string;
  source_item_origin_id: string;
  title: string;
  url: string | null;
  content_text: string | null;
  published_at: Date | string | null;
  metadata: Record<string, unknown> | null;
};
export function matchExistingModules(
  sourceId: string,
  articles: NormalizedRawArticle[],
  existing: Existing[],
): ModuleMapping[] | null {
  if (articles.length !== existing.length) return null;
  const available = [...existing],
    mappings: ModuleMapping[] = [];
  for (const article of articles) {
    const fingerprint = moduleFingerprint(article);
    const index = available.findIndex(
      (row) =>
        row.source_id === sourceId &&
        moduleFingerprint({
          sourceItemOriginId: row.source_item_origin_id,
          title: row.title,
          url: row.url,
          contentText: row.content_text,
          publishedAt: row.published_at ? new Date(row.published_at) : null,
          metadata: row.metadata,
          author: null,
          imageUrl: null,
          sourceTags: null,
        }) === fingerprint,
    );
    if (index < 0) return null;
    const row = available.splice(index, 1)[0];
    mappings.push({
      unit_id: (article.metadata!.newsletter as { unit_id: string }).unit_id,
      raw_id: row.id,
      fingerprint,
    });
  }
  return mappings;
}
async function rawModules(client: PoolClient, id: string) {
  return (
    await client.query<Existing>(
      `select id,source_id,source_item_origin_id,title,url,content_text,published_at,metadata from raw_articles where metadata->'newsletter'->>'gmail_message_id'=$1 or left(source_item_origin_id,length($2))=$2 for update`,
      [id, `gmail:${id}:`],
    )
  ).rows;
}
/** Email row lock serializes collectors/reparses. Raw and its manifest commit together. */
export async function processStoredEmail(
  pool: Pool,
  id: string,
  options: { window?: { startAt: string; endAt: string } } = {},
) {
  const client = await pool.connect();
  let stage = 'mime';
  try {
    await client.query('begin');
    await client.query("set local lock_timeout='5s'");
    const email = (
      await client.query<StoredEmail>(
        'select * from newsletter_emails where gmail_message_id=$1 for update',
        [id],
      )
    ).rows[0];
    if (!email) throw new Error('gmail_saved_email_missing');
    if (
      ['success', 'skipped', 'conflict'].includes(email.parse_status) ||
      (options.window &&
        (!email.received_at ||
          new Date(email.received_at) < new Date(options.window.startAt) ||
          new Date(email.received_at) > new Date(options.window.endAt)))
    ) {
      await client.query('commit');
      return {
        status: email.parse_status,
        inserted: 0,
        skipped: email.module_mapping.length,
        units: 0,
      };
    }

    await client.query('savepoint processing');
    let hadRaw = false;
    let identifiedSource: string | null = null,
      identifiedSourceId: string | null = null;
    try {
      hadRaw = (await rawModules(client, id)).length > 0 || email.module_mapping.length > 0;
      let mail: Awaited<ReturnType<typeof parseMessage>>;
      try {
        mail = await parseMessage(email.raw_message);
      } catch {
        throw new NewsletterIntakeError(
          'unsupported',
          'MIME decode failed: invalid Gmail MIME structure',
        );
      }
      const sourceName = newsletterSource(mail);
      identifiedSource = sourceName;
      await client.query('update newsletter_emails set source_name=$2 where gmail_message_id=$1', [
        id,
        sourceName,
      ]);
      if (mail.parseStatus !== 'success' || !mail.html)
        throw new NewsletterIntakeError(
          'unsupported',
          `MIME unavailable: ${mail.errors.join(',') || 'html_missing'}`,
        );
      if (!mail.receivedAt)
        throw new NewsletterIntakeError('unsupported', 'Gmail received_at missing or invalid');
      stage = 'source';
      const expected = NEWSLETTER_SOURCE_NAMES[sourceName];
      if (!expected)
        throw new NewsletterIntakeError('unsupported', 'Newsletter source is not supported');
      const sources = await client.query<{ id: string }>(
        `select id from sources where enabled=true and lower(btrim(collection_method))='email' and name=$1 and lower(btrim(url))=$2`,
        [expected.name, expected.address],
      );
      if (sources.rows.length !== 1)
        throw new NewsletterIntakeError(
          'unsupported',
          'Newsletter Source mapping missing or ambiguous',
        );
      const sourceId = sources.rows[0].id;
      identifiedSourceId = sourceId;
      await client.query('update newsletter_emails set source_id=$2 where gmail_message_id=$1', [
        id,
        sourceId,
      ]);
      stage = 'parse';
      let articles: NormalizedRawArticle[];
      try {
        articles = newsletterRawArticles(mail);
      } catch (error) {
        throw new NewsletterIntakeError('unsupported', safeIntakeError(error));
      }
      stage = 'persist';
      await client.query('savepoint raw_modules');
      try {
        const existing = await rawModules(client, id);
        let mapping = matchExistingModules(sourceId, articles, existing),
          inserted = 0;
        if (existing.length || email.module_mapping.length) {
          if (
            !mapping ||
            email.module_mapping.some((m) => !existing.some((r) => r.id === m.raw_id))
          )
            throw new NewsletterIntakeError(
              'conflict',
              'Existing Raw modules differ from current parser output; automatic writes stopped',
            );
        } else {
          const result = await persistNewsletterArticlesInTransaction(client, sourceId, articles);
          inserted = result.inserted;
          mapping = matchExistingModules(sourceId, articles, await rawModules(client, id));
          if (!mapping) throw new Error('gmail_raw_mapping_incomplete');
        }
        const status = articles.length ? 'success' : 'skipped';
        await client.query(
          `update newsletter_emails set parse_status=$2,parser_version=$3,module_mapping=$4::jsonb,error_stage=null,error_message=null,parsed_at=now(),imported_at=now(),updated_at=now() where gmail_message_id=$1`,
          [id, status, SOURCE_RULE_VERSION, JSON.stringify(mapping)],
        );
        await client.query('commit');
        return {
          status: status as EmailStatus,
          inserted,
          skipped: articles.length - inserted,
          units: articles.length,
        };
      } catch (error) {
        await client.query('rollback to savepoint raw_modules');
        throw error;
      }
    } catch (error) {
      await client.query('rollback to savepoint processing');
      const status =
        error instanceof NewsletterIntakeError ? (hadRaw ? 'conflict' : error.status) : 'failed';
      await client.query(
        `update newsletter_emails set parse_status=$2,parser_version=$3,error_stage=$4,error_message=$5,source_name=coalesce($6,source_name),source_id=coalesce($7::uuid,source_id),parsed_at=now(),updated_at=now() where gmail_message_id=$1`,
        [
          id,
          status,
          SOURCE_RULE_VERSION,
          stage,
          safeIntakeError(error),
          identifiedSource,
          identifiedSourceId,
        ],
      );
      await client.query('commit');
      return { status, inserted: 0, skipped: 0, units: 0, error: safeIntakeError(error), stage };
    }
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      console.error('[gmail] rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}
