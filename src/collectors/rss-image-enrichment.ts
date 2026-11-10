import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ReadableStream } from 'node:stream/web';
import { JSDOM } from 'jsdom';
import type { Pool } from 'pg';
import { Agent, fetch as undiciFetch } from 'undici';

export type ImageEnrichmentSource = { id: string; name: string; url: string };
export type FeedIdentity = { sourceItemOriginId: string | null; url: string | null };
export type ImageEnrichmentStats = {
  eligible: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failureReasons: Record<string, number>;
};

const SOURCE_RULES: Record<string, { feed: string; articleHost: string }> = {
  TechCrunch: { feed: 'https://techcrunch.com/feed/', articleHost: 'techcrunch.com' },
  'CNBC: World Top News & Analysis': {
    feed: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    articleHost: 'www.cnbc.com',
  },
  'MIT Technology Review': {
    feed: 'https://www.technologyreview.com/feed/',
    articleHost: 'www.technologyreview.com',
  },
};

const PAGE_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_FIELDS = ['og:image', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'];

export function emptyImageEnrichmentStats(): ImageEnrichmentStats {
  return { eligible: 0, attempted: 0, succeeded: 0, failed: 0, skipped: 0, failureReasons: {} };
}

export function imageEnrichmentHost(source: ImageEnrichmentSource): string | null {
  const rule = SOURCE_RULES[source.name];
  return rule?.feed === source.url ? rule.articleHost : null;
}

function failure(stats: ImageEnrichmentStats, reason: string): void {
  stats.failed += 1;
  stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
}

function skip(stats: ImageEnrichmentStats, reason: string): void {
  stats.skipped += 1;
  stats.failureReasons[reason] = (stats.failureReasons[reason] ?? 0) + 1;
}

export function trustedArticleUrl(raw: string, host: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== host ||
      url.port ||
      url.username ||
      url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, ''))
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function publicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export async function resolvePublicIpv4(
  host: string,
  resolve: typeof lookup = lookup,
): Promise<string> {
  const addresses = await resolve(host, { all: true, family: 4 });
  if (!addresses.length || addresses.some(({ address }) => !publicIpv4(address))) {
    throw new Error('unsafe_dns');
  }
  return addresses[0].address;
}

type PageResponse = {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};
export type PageRequest = (
  url: URL,
  signal: AbortSignal,
) => Promise<{ response: PageResponse; close: () => Promise<void> }>;

async function securePageRequest(url: URL, signal: AbortSignal) {
  const address = await resolvePublicIpv4(url.hostname);
  const agent = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address, family: 4 }]);
        else callback(null, address, 4);
      },
    },
  });
  try {
    const response = await undiciFetch(url.href, {
      dispatcher: agent,
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'user-agent': 'Mozilla/5.0 (compatible; X-AI-field RSS image enrichment)',
      },
    });
    return { response, close: () => agent.close() };
  } catch (error) {
    await agent.close();
    throw error;
  }
}

function sameArticle(a: URL, b: URL): boolean {
  const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/';
  return a.origin === b.origin && path(a) === path(b);
}

function imageCandidate(raw: string, page: URL): string | null {
  try {
    const url = new URL(raw.trim(), page);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
      /(^|\.)(localhost|local|internal)$/i.test(url.hostname) ||
      /(?:logo|emoji|smiley|pixel|tracker|tracking|favicon|placeholder|default)/i.test(
        url.pathname,
      ) ||
      /(?:^|[?&])(?:w|width|h|height)=1(?:&|$)/i.test(url.search) ||
      sameArticle(url, page)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function extractArticleHeadImage(
  head: string,
  finalUrl: URL,
): { image: string | null; reason: string | null } {
  const document = new JSDOM(head).window.document;
  const canonical = document.querySelector('link[rel~="canonical"]')?.getAttribute('href');
  const meta = [...document.head.querySelectorAll('meta')];
  const values = (field: string) =>
    meta
      .filter(
        (element) =>
          (element.getAttribute('property') ?? element.getAttribute('name') ?? '').toLowerCase() ===
          field,
      )
      .map((element) => element.getAttribute('content'))
      .filter((value): value is string => Boolean(value?.trim()));
  const identities = [canonical, ...values('og:url')].filter((value): value is string =>
    Boolean(value),
  );
  if (!identities.length) return { image: null, reason: 'missing_article_identity' };
  if (
    identities.some((value) => {
      try {
        return !sameArticle(new URL(value, finalUrl), finalUrl);
      } catch {
        return true;
      }
    })
  )
    return { image: null, reason: 'canonical_mismatch' };

  for (const field of IMAGE_FIELDS) {
    for (const raw of values(field)) {
      const image = imageCandidate(raw, finalUrl);
      if (image) return { image, reason: null };
    }
  }
  return { image: null, reason: 'no_image' };
}

export async function readArticleHeadImage(
  rawUrl: string,
  host: string,
  request: PageRequest = securePageRequest,
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<{ image: string | null; reason: string | null }> {
  const initial = trustedArticleUrl(rawUrl, host);
  if (!initial) return { image: null, reason: 'unsafe_url' };
  let url: URL = initial;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.timeoutMs ?? PAGE_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const { response, close } = await request(url, controller.signal);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          let next: URL | null = null;
          try {
            next = location ? trustedArticleUrl(new URL(location, url).href, host) : null;
          } catch {
            /* invalid Location */
          }
          if (!next) return { image: null, reason: 'unsafe_redirect' };
          if (redirects === MAX_REDIRECTS) return { image: null, reason: 'redirect_limit' };
          url = next;
          continue;
        }
        if (response.status !== 200) return { image: null, reason: `http_${response.status}` };
        if (!/html/i.test(response.headers.get('content-type') ?? '')) {
          return { image: null, reason: 'non_html' };
        }
        if (!response.body) return { image: null, reason: 'empty_body' };
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let html = '';
        let bytes = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > (limits.maxBytes ?? MAX_PAGE_BYTES))
              return { image: null, reason: 'size_limit' };
            html += decoder.decode(chunk.value, { stream: true });
            const end = html.search(/<\/head\s*>/i);
            if (end >= 0) {
              html = html.slice(0, end + 7);
              return extractArticleHeadImage(html, url);
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        return { image: null, reason: 'no_head' };
      } finally {
        await response.body?.cancel().catch(() => undefined);
        await close();
      }
    }
    return { image: null, reason: 'redirect_limit' };
  } catch (error) {
    const reason = controller.signal.aborted
      ? 'timeout'
      : error instanceof Error && error.message === 'unsafe_dns'
        ? 'unsafe_dns'
        : 'request_error';
    if (reason === 'request_error') {
      console.warn('RSS image enrichment request failed.', {
        host,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { image: null, reason };
  } finally {
    clearTimeout(timeout);
  }
}

type QueueItem<T> = {
  host: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};
const queue: QueueItem<unknown>[] = [];
const activeHosts = new Set<string>();
let activeCount = 0;

function drainQueue(): void {
  for (let index = 0; activeCount < 3 && index < queue.length;) {
    const item = queue[index];
    if (activeHosts.has(item.host)) {
      index += 1;
      continue;
    }
    queue.splice(index, 1);
    activeCount += 1;
    activeHosts.add(item.host);
    void item
      .task()
      .then(item.resolve, item.reject)
      .finally(() => {
        activeCount -= 1;
        activeHosts.delete(item.host);
        drainQueue();
      });
  }
}

function schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({ host, task, resolve, reject } as QueueItem<unknown>);
    drainQueue();
  });
}

export async function enrichRssImages(
  pool: Pool,
  source: ImageEnrichmentSource,
  identities: FeedIdentity[],
  options: { dryRun?: boolean; limit?: number; request?: PageRequest } = {},
): Promise<ImageEnrichmentStats> {
  const stats = emptyImageEnrichmentStats();
  const host = imageEnrichmentHost(source);
  if (!host || !identities.length) return stats;
  const ids = [
    ...new Set(
      identities.map((item) => item.sourceItemOriginId).filter((id): id is string => Boolean(id)),
    ),
  ];
  const urls = [
    ...new Set(identities.map((item) => item.url).filter((url): url is string => Boolean(url))),
  ];
  const result = await pool.query<{ id: string; url: string | null }>(
    `select id, url from raw_articles where source_id = $1 and image_url is null
       and (source_item_origin_id = any($2::text[]) or url = any($3::text[]))`,
    [source.id, ids, urls],
  );
  stats.eligible = result.rows.length;
  stats.skipped = Math.max(0, identities.length - stats.eligible);
  const candidates =
    options.limit === undefined ? result.rows : result.rows.slice(0, options.limit);
  stats.skipped += result.rows.length - candidates.length;
  await Promise.all(
    candidates.map(async (article) => {
      if (!article.url || !trustedArticleUrl(article.url, host)) {
        skip(stats, 'unsafe_url');
        return;
      }
      stats.attempted += 1;
      try {
        const found = await schedule(host, () =>
          readArticleHeadImage(article.url!, host, options.request),
        );
        if (!found.image) {
          failure(stats, found.reason ?? 'no_image');
          return;
        }
        if (options.dryRun) {
          stats.succeeded += 1;
          return;
        }
        const updated = await pool.query(
          'update raw_articles set image_url = $1 where id = $2 and source_id = $3 and image_url is null',
          [found.image, article.id, source.id],
        );
        if (updated.rowCount === 1) stats.succeeded += 1;
        else skip(stats, 'already_filled');
      } catch {
        failure(stats, 'unexpected_error');
      }
    }),
  );
  return stats;
}
