import type { Pool } from 'pg';
import { normalizeArticleUrl } from '../processing/url-normalization.js';
import {
  DiscoveryCoverSchema,
  safeImageUrl,
  type DiscoveryCover,
} from './discovery-content-metadata.js';

export type ArticleDocument = {
  url: string;
  finalUrl: string;
  fetchedAt: string;
  status: 'success' | 'error';
  markdown: string;
  isComplete: boolean;
  metadata: Record<string, unknown>;
  coverImage: DiscoveryCover | null;
  error: string | null;
  origin?: 'cache' | 'candidate' | 'daily' | 'fetch';
  cacheWarning?: string;
};
export type ArticleDatabase = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool, 'query'>;
type CacheRow = {
  original_url: string;
  final_url: string;
  fetched_at: Date | string;
  markdown: string;
  is_complete: boolean;
  metadata: Record<string, unknown>;
};

export function normalizedFetchUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Only HTTP(S) article URLs without credentials are supported.');
  return normalizeArticleUrl(url.toString())!;
}

async function cachedArticle(db: Queryable, normalized: string): Promise<ArticleDocument | null> {
  const result = await db.query<CacheRow>(
    `select original_url, final_url, fetched_at, markdown, is_complete, metadata
       from discovery_fetch_cache
      where (normalized_url = $1 or normalized_final_url = $1) and status = 'success'
        and is_complete = true and length(trim(markdown)) > 0
      order by fetched_at desc, normalized_url limit 1`,
    [normalized],
  );
  const row = result.rows[0];
  if (!row) return null;
  const cover = DiscoveryCoverSchema.safeParse(row.metadata?.coverImage);
  return {
    url: row.original_url,
    finalUrl: row.final_url,
    fetchedAt: new Date(row.fetched_at).toISOString(),
    status: 'success',
    markdown: row.markdown,
    isComplete: row.is_complete,
    metadata: row.metadata ?? {},
    coverImage: cover.success ? cover.data : null,
    error: null,
    origin: 'cache',
  };
}

async function dailyArticle(
  db: Queryable,
  url: string,
  sourceContentId?: string | null,
): Promise<ArticleDocument | null> {
  const result = await db.query<{
    url: string;
    full_content_text: string;
    title: string;
    author: string | null;
    published_at: Date | string | null;
    collected_at: Date | string;
    image_url: string | null;
    metadata: Record<string, unknown> | null;
    source_name: string;
  }>(
    `select ra.url, coalesce(nullif(trim(ra.full_content_text), ''), ra.content_text) as full_content_text, ra.title, ra.author, ra.published_at,
            ra.collected_at, ra.image_url, ra.metadata, s.name as source_name
       from raw_articles ra join sources s on s.id = ra.source_id
      where (length(trim(ra.full_content_text)) > 0 or (
          length(trim(ra.content_text)) > 0
          and ra.metadata->'content_completion'->>'status' = 'success'
          and ra.metadata->'content_completion'->>'content_type' = 'article_body'
          and ra.metadata->'content_completion'->>'full_content_length' = '0'))
        and (ra.url = any($1::text[]) or ra.id = (
          select pc.raw_article_id from processed_contents pc where pc.id = $2::uuid))
      order by ra.collected_at desc, ra.id desc limit 1`,
    [[url, normalizedFetchUrl(url)], sourceContentId ?? null],
  );
  const row = result.rows[0];
  if (!row) return null;
  const image = safeImageUrl(row.image_url, row.url);
  return {
    url,
    finalUrl: row.url,
    fetchedAt: new Date(row.collected_at).toISOString(),
    status: 'success',
    markdown: row.full_content_text.trim(),
    isComplete: true,
    error: null,
    origin: 'daily',
    metadata: {
      title: row.title,
      author: row.author,
      publishedTime: row.published_at,
      publication: row.source_name,
    },
    coverImage: image ? { url: image, source: 'raw_article', width: null, height: null } : null,
  };
}

/** Read-only reuse, also used by manual Generate: never issues a paid Fetch. */
export async function readStoredArticle(
  db: Pick<Pool, 'query'>,
  url: string,
  options: { candidateArticle?: ArticleDocument | null; sourceContentId?: string | null } = {},
): Promise<ArticleDocument | null> {
  const cached = await cachedArticle(db, normalizedFetchUrl(url));
  if (cached) return cached;
  if (
    options.candidateArticle?.status === 'success' &&
    options.candidateArticle.isComplete &&
    options.candidateArticle.markdown.trim()
  )
    return options.candidateArticle;
  return dailyArticle(db, url, options.sourceContentId);
}

/** A URL-keyed cache independent of Candidate selection. Complete Daily content stays in its own table. */
export async function getOrFetchArticle(
  db: ArticleDatabase,
  url: string,
  options: {
    fetchDocument: () => Promise<ArticleDocument>;
    candidateArticle?: ArticleDocument | null;
    sourceContentId?: string | null;
  },
): Promise<ArticleDocument> {
  const normalized = normalizedFetchUrl(url);
  const stored = await readStoredArticle(db, url, options);
  if (stored) return stored;

  const client = await db.connect();
  let fetched: ArticleDocument | undefined;
  let releaseError: Error | undefined;
  // Checked-out pg clients have no Pool idle-error handler. An idle transaction can
  // be terminated while awaiting Firecrawl; keep that diagnostic from crashing the process.
  const connectionLost = (error: Error) => {
    releaseError = error;
    console.error('Discovery Fetch Cache connection lost.', {
      hostname: new URL(url).hostname,
      error,
    });
  };
  client.on?.('error', connectionLost);
  try {
    await client.query('begin');
    await client.query("set local lock_timeout = '120s'");
    // Transaction-scoped locks also work with transaction-pooling PostgreSQL connections.
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [normalized]);
    const afterLock = await cachedArticle(client, normalized);
    if (afterLock) {
      await client.query('commit');
      return afterLock;
    }
    fetched = await options.fetchDocument();
    if (releaseError) throw releaseError;
    if (fetched.status === 'success' && fetched.markdown.trim()) {
      await client.query(
        `insert into discovery_fetch_cache (
           normalized_url, normalized_final_url, original_url, final_url,
           fetched_at, status, markdown, is_complete, metadata
         ) values ($1, $2, $3, $4, $5::timestamptz, 'success', $6, $7, $8::jsonb)
         on conflict (normalized_url) do update set
           normalized_final_url = excluded.normalized_final_url, final_url = excluded.final_url,
           fetched_at = excluded.fetched_at, status = excluded.status, markdown = excluded.markdown,
           is_complete = excluded.is_complete, metadata = excluded.metadata
         where not discovery_fetch_cache.is_complete or excluded.is_complete`,
        [
          normalized,
          normalizedFetchUrl(fetched.finalUrl),
          url,
          fetched.finalUrl,
          fetched.fetchedAt,
          fetched.markdown,
          fetched.isComplete,
          JSON.stringify({ ...fetched.metadata, coverImage: fetched.coverImage }),
        ],
      );
    }
    await client.query('commit');
    return fetched;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      releaseError ??=
        rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      console.error('Discovery Fetch Cache rollback failed.', rollbackError);
    }
    console.error('Discovery Fetch Cache failed.', { hostname: new URL(url).hostname, error });
    // Keep a paid response usable even if its cache write fails. Never hide this failure.
    if (fetched)
      return { ...fetched, cacheWarning: 'Article fetched but Fetch Cache persistence failed.' };
    throw error; // Cache lookup/lock failures must not trigger an unprotected paid fetch.
  } finally {
    client.off?.('error', connectionLost);
    client.release(releaseError);
  }
}
