import assert from 'node:assert/strict';
import type { LookupAddress } from 'node:dns';
import { ReadableStream } from 'node:stream/web';
import type { Pool } from 'pg';
import { collectRssSources } from '../src/collectors/rss.js';
import {
  enrichRssImages,
  extractArticleHeadImage,
  imageEnrichmentHost,
  readArticleHeadImage,
  resolvePublicIpv4,
  trustedArticleUrl,
  type PageRequest,
} from '../src/collectors/rss-image-enrichment.js';

const techCrunch = {
  id: 'techcrunch-id',
  name: 'TechCrunch',
  url: 'https://techcrunch.com/feed/',
};
const article = 'https://techcrunch.com/2026/11/08/story/';
const image = 'https://techcrunch.com/wp-content/uploads/story.jpg?w=1200&h=800';
assert.equal(imageEnrichmentHost(techCrunch), 'techcrunch.com');
assert.equal(
  imageEnrichmentHost({
    id: 'information-id',
    name: 'The Information · RSS',
    url: 'https://example.com/feed',
  }),
  null,
);
assert.equal(imageEnrichmentHost({ ...techCrunch, url: 'https://example.com/feed' }), null);

function head(meta: string, url = article): string {
  return `<html><head><link rel="canonical" href="${url}"><meta property="og:url" content="${url}">${meta}</head><body>ignored</body></html>`;
}

function pageRequest(
  status: number,
  html: string,
  extraHeaders: Record<string, string> = {},
): PageRequest {
  return async () => ({
    response: {
      status,
      headers: new Headers({ 'content-type': 'text/html', ...extraHeaders }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(html));
          controller.close();
        },
      }),
    },
    close: async () => undefined,
  });
}

const parsed = (html: string) => extractArticleHeadImage(html, new URL(article));
assert.equal(parsed(head(`<meta property="og:image" content="${image}">`)).image, image);
assert.equal(
  parsed(
    head(
      `<meta property="og:image" content="${image}"><meta property="og:image" content="${image}">`,
    ),
  ).image,
  image,
);
assert.equal(
  parsed(
    head(
      `<meta property="og:image" content="https://wp.technologyreview.com/wp-content/uploads/mit.jpg">`,
    ),
  ).image,
  'https://wp.technologyreview.com/wp-content/uploads/mit.jpg',
);
assert.equal(
  parsed(head('<meta property="og:image" content="/cover.jpg?a=1&amp;b=2">')).image,
  'https://techcrunch.com/cover.jpg?a=1&b=2',
);
assert.equal(
  parsed(head('<meta property="twitter:image" content="/fallback.jpg">')).image,
  'https://techcrunch.com/fallback.jpg',
);
assert.equal(parsed(head('')).reason, 'no_image');
assert.equal(
  parsed(head(`<meta property="og:image" content="${image}">`, 'https://techcrunch.com/other/'))
    .reason,
  'canonical_mismatch',
);
assert.equal(
  parsed(
    head(
      '<meta property="og:image" content="/logo.png"><meta property="og:image" content="/real.jpg">',
    ),
  ).image,
  'https://techcrunch.com/real.jpg',
);
assert.equal(parsed(head('<meta property="og:image" content="/pixel?width=1">')).image, null);
assert.equal(parsed(head(`<meta property="og:image" content="${article}">`)).image, null);

assert.equal(
  (await readArticleHeadImage(article, 'techcrunch.com', pageRequest(403, 'forbidden'))).reason,
  'http_403',
);
assert.equal(
  (
    await readArticleHeadImage(
      article,
      'techcrunch.com',
      pageRequest(200, '<html><head>' + 'x'.repeat(100)),
      { maxBytes: 32 },
    )
  ).reason,
  'size_limit',
);
assert.equal(
  (
    await readArticleHeadImage(
      article,
      'techcrunch.com',
      async (_url, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      { timeoutMs: 5 },
    )
  ).reason,
  'timeout',
);
let redirectRequests = 0;
const unsafeRedirect: PageRequest = async () => {
  redirectRequests += 1;
  return pageRequest(302, '', { location: 'http://127.0.0.1/private' })(
    new URL(article),
    new AbortController().signal,
  );
};
assert.equal(
  (await readArticleHeadImage(article, 'techcrunch.com', unsafeRedirect)).reason,
  'unsafe_redirect',
);
assert.equal(redirectRequests, 1);
assert.equal(trustedArticleUrl('http://127.0.0.1/private', 'techcrunch.com'), null);
assert.equal(trustedArticleUrl('https://techcrunch.com.evil.test/story', 'techcrunch.com'), null);
assert.equal(trustedArticleUrl('https://techcrunch.com:444/story', 'techcrunch.com'), null);
assert.equal(trustedArticleUrl('file:///etc/passwd', 'techcrunch.com'), null);
const fakeLookup = async () => [{ address: '127.0.0.1', family: 4 }] as LookupAddress[];
await assert.rejects(
  resolvePublicIpv4(
    'techcrunch.com',
    fakeLookup as unknown as typeof import('node:dns/promises').lookup,
  ),
  /unsafe_dns/,
);

const existing = { id: 'old-id', url: article, image_url: 'https://techcrunch.com/already.jpg' };
let writes = 0;
const existingPool = {
  query: async (sql: string) => {
    if (sql.startsWith('select id, url from raw_articles')) return { rows: [], rowCount: 0 };
    writes += 1;
    return { rows: [], rowCount: 1 };
  },
} as unknown as Pool;
const existingStats = await enrichRssImages(existingPool, techCrunch, [
  { sourceItemOriginId: 'old-guid', url: existing.url },
]);
assert.equal(existingStats.skipped, 1);
assert.equal(existingStats.attempted, 0);
assert.equal(writes, 0);

let conditionalUpdateChecked = false;
const racedPool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('select id, url from raw_articles'))
      return { rows: [{ id: 'raced-id', url: article }], rowCount: 1 };
    assert.match(sql, /where id = \$2 and source_id = \$3 and image_url is null/);
    assert.deepEqual(params, [image, 'raced-id', techCrunch.id]);
    conditionalUpdateChecked = true;
    return { rows: [], rowCount: 0 };
  },
} as unknown as Pool;
const racedStats = await enrichRssImages(
  racedPool,
  techCrunch,
  [{ sourceItemOriginId: 'raced-guid', url: article }],
  { request: pageRequest(200, head(`<meta property="og:image" content="${image}">`)) },
);
assert.equal(conditionalUpdateChecked, true);
assert.equal(racedStats.succeeded, 0);
assert.equal(racedStats.skipped, 1);
assert.equal(racedStats.failureReasons.already_filled, 1);

const rawRows: Array<{ id: string; guid: string; url: string; image: string | null }> = [
  { id: 'duplicate-id', guid: 'duplicate-guid', url: article, image: null },
  {
    id: 'historical-id',
    guid: 'historical-guid',
    url: 'https://techcrunch.com/old-story/',
    image: null,
  },
];
const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>TechCrunch</title><link>https://techcrunch.com</link>
  <item><title>Duplicate article</title><link>${article}</link><guid>duplicate-guid</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
  <item><title>New article</title><link>https://techcrunch.com/2026/11/08/new-story/</link><guid>new-guid</guid><pubDate>${new Date().toUTCString()}</pubDate></item>
</channel></rss>`;
const pool = {
  query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('from sources'))
      return { rows: [{ ...techCrunch, category: 'Technology', sourceType: 'News Platform' }] };
    if (sql.startsWith('select id, url from raw_articles')) {
      const [sourceId, ids, urls] = params as [string, string[], string[]];
      assert.equal(sourceId, techCrunch.id);
      return {
        rows: rawRows.filter(
          (row) => row.image === null && (ids.includes(row.guid) || urls.includes(row.url)),
        ),
        rowCount: 2,
      };
    }
    if (sql.startsWith('update raw_articles')) {
      const [value, id] = params as [string, string];
      const row = rawRows.find((candidate) => candidate.id === id);
      if (row && row.image === null) {
        row.image = value;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  },
  connect: async () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('from raw_articles') && sql.includes('limit 1')) {
        const [sourceId, guid, url] = params;
        assert.equal(sourceId, techCrunch.id);
        const row = rawRows.find((candidate) => candidate.guid === guid || candidate.url === url);
        return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('insert into raw_articles')) {
        rawRows.push({
          id: 'new-id',
          guid: params[1] as string,
          url: params[3] as string,
          image: null,
        });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected client query: ${sql}`);
    },
    release: () => undefined,
  }),
} as unknown as Pool;
const request: PageRequest = async (url, signal) =>
  url.pathname.includes('new-story')
    ? pageRequest(403, 'forbidden')(url, signal)
    : pageRequest(200, head(`<meta property="og:image" content="${image}">`))(url, signal);
const summary = await collectRssSources(pool, {
  fetchFeed: async () => feed,
  imageRequest: request,
});
assert.equal(summary.successSourceCount, 1);
assert.equal(summary.results[0].insertedItemCount, 1);
assert.equal(summary.results[0].skippedDuplicateCount, 1);
assert.deepEqual(summary.results[0].imageEnrichment, {
  eligible: 2,
  attempted: 2,
  succeeded: 1,
  failed: 1,
  skipped: 0,
  failureReasons: { http_403: 1 },
});
assert.equal(rawRows.find((row) => row.id === 'duplicate-id')?.image, image);
assert.equal(rawRows.find((row) => row.id === 'historical-id')?.image, null);

console.log('RSS image enrichment mock tests passed.');
