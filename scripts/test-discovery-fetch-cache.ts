import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents';
import { getOrFetchArticle, normalizedFetchUrl } from '../src/lib/article-fetch-cache.js';
import {
  fetchDiscoveryArticle,
  fetchDiscoveryContent,
  createDiscoveryFetchContentTool,
} from '../src/discovery/fetch-content.js';
import { ArticleStore, article, articleUrl, articleText } from './fixtures/article-cache.js';

const store = new ArticleStore();
let requests = 0;
const fetchDocument = async () => {
  requests++;
  await Promise.resolve();
  return article({ markdown: articleText.repeat(30) });
};
const [first, concurrent] = await Promise.all([
  getOrFetchArticle(store.db, articleUrl + '?utm_source=one#x', { fetchDocument }),
  getOrFetchArticle(store.db, articleUrl + '?utm_source=two', { fetchDocument }),
]);
assert.equal(
  requests,
  1,
  'Concurrent normalized URLs share a DB lock and recheck the committed cache.',
);
assert.equal(store.cache.size, 1);
assert.ok(first.markdown.length > 20_000);
assert.equal(concurrent.origin, 'cache');
assert.equal((await getOrFetchArticle(store.db, articleUrl, { fetchDocument })).origin, 'cache');
assert.equal(requests, 1, 'A new Run must reuse the paid body even without any Candidate.');
assert.equal(store.released, 2);
assert.equal(normalizedFetchUrl(articleUrl + '?b=2&utm_medium=x&a=1#x'), articleUrl + '?a=1&b=2');
assert.throws(() => normalizedFetchUrl('file:///private/data'));
assert.throws(() => normalizedFetchUrl('https://user:pass@example.test/article'));

const dailyStore = new ArticleStore();
dailyStore.daily.push({
  url: articleUrl,
  full_content_text: articleText,
  title: 'Daily title',
  author: 'Daily author',
  collected_at: '2026-10-19T00:00:00Z',
  source_name: 'Daily source',
  source_content_id: 'content-id',
});
assert.equal(
  (await getOrFetchArticle(dailyStore.db, articleUrl, { fetchDocument })).origin,
  'daily',
);
assert.equal(requests, 1, 'Daily full text must not cause another Firecrawl request.');
assert.equal(dailyStore.cache.size, 0, 'Do not copy Daily full text into a second store.');
dailyStore.seed(article({ markdown: 'Preferred cached article' }));
assert.equal(
  (await getOrFetchArticle(dailyStore.db, articleUrl, { fetchDocument })).markdown,
  'Preferred cached article',
);
const shortDaily = new ArticleStore();
shortDaily.daily.push({
  url: articleUrl,
  full_content_text: null,
  content_text: 'Daily 的完整短正文',
  metadata: {
    content_completion: { status: 'success', content_type: 'article_body', full_content_length: 0 },
  },
  title: 'Short body',
  collected_at: '2026-10-19T00:00:00Z',
  source_name: 'Daily source',
});
assert.equal(
  (
    await getOrFetchArticle(shortDaily.db, articleUrl, {
      fetchDocument: async () => {
        throw new Error('Already-paid complete short Daily body must be reused.');
      },
    })
  ).markdown,
  'Daily 的完整短正文',
);
(
  shortDaily.daily[0]!.metadata as { content_completion: Record<string, unknown> }
).content_completion.content_type = 'abstract';
let abstractRefetched = false;
await getOrFetchArticle(shortDaily.db, articleUrl, {
  fetchDocument: async () => {
    abstractRefetched = true;
    return article();
  },
});
assert.equal(
  abstractRefetched,
  true,
  'A Daily abstract must not be mistaken for complete article text.',
);
const partial = new ArticleStore();
await getOrFetchArticle(partial.db, articleUrl, {
  fetchDocument: async () => article({ isComplete: false }),
});
assert.equal(partial.cache.get(articleUrl)?.is_complete, false);
let partialRefetched = false;
await getOrFetchArticle(partial.db, articleUrl, {
  fetchDocument: async () => {
    partialRefetched = true;
    return article();
  },
});
assert.equal(partialRefetched, true);
assert.equal(partial.cache.get(articleUrl)?.is_complete, true);
const failed = new ArticleStore();
await getOrFetchArticle(failed.db, articleUrl, {
  fetchDocument: async () =>
    article({ status: 'error', markdown: '', isComplete: false, error: 'Unavailable' }),
});
assert.equal(failed.cache.size, 0);
const badStore = new ArticleStore();
badStore.failWrite = true;
const warn = await getOrFetchArticle(badStore.db, articleUrl, {
  fetchDocument: async () => article(),
});
assert.equal(warn.markdown, articleText);
assert.ok(warn.cacheWarning);
assert.equal(badStore.cache.size, 0);
badStore.failLookup = true;
await assert.rejects(
  getOrFetchArticle(badStore.db, articleUrl, {
    fetchDocument: async () => {
      throw new Error('Should not pay while cache unavailable');
    },
  }),
  /missing cache/,
);

let networkCalls = 0;
const abstract = 'This abstract explains the central scientific question and its evidence. '
  .repeat(4)
  .trim();
const responseBody =
  '# Abstract\n\n' + abstract + '\n\n# Main argument\n\n' + articleText.repeat(30);
const mockFetch: typeof fetch = async () => {
  networkCalls++;
  return Response.json({
    success: true,
    data: {
      markdown: responseBody,
      metadata: {
        url: 'https://example.test/final',
        description: 'Description',
        author: 'Author',
        publisher: { name: 'Publisher' },
      },
      html: '<meta property="og:image" content="/cover.jpg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="800">',
    },
  });
};
const doc = await fetchDiscoveryArticle(articleUrl, {
  apiKey: 'mock',
  maxRetries: 0,
  fetchImpl: mockFetch,
});
assert.equal(
  doc.markdown,
  responseBody,
  'Do not replace the full paid article with its Abstract section.',
);
assert.equal(doc.finalUrl, 'https://example.test/final');
assert.equal(doc.metadata.description, 'Description');
assert.equal(doc.metadata.ogImage, '/cover.jpg');
assert.equal('html' in doc.metadata, false);
const networkStore = new ArticleStore();
const agent = await fetchDiscoveryContent(articleUrl, {
  pool: networkStore.db,
  apiKey: 'mock',
  fetchImpl: mockFetch,
});
assert.equal(agent.content, abstract);
assert.equal(agent.content_type, 'abstract');
assert.equal(agent.truncated, false);
assert.equal(agent.content_complete, false);
assert.equal(networkStore.cache.get(articleUrl)?.markdown, responseBody);
assert.equal(
  networkStore.cache.get(articleUrl)?.is_complete,
  true,
  'Agent delivery truncation must not truncate the persisted original.',
);
const cachedAgent = await fetchDiscoveryContent(articleUrl + '?utm_source=another', {
  pool: networkStore.db,
  apiKey: 'mock',
  fetchImpl: mockFetch,
});
assert.equal(cachedAgent.content, abstract, 'Cache hits preserve the original Agent extraction.');
assert.equal(networkCalls, 2);
const bodyStore = new ArticleStore();
bodyStore.seed(article({ markdown: articleText.repeat(30) }));
const bodyAgent = await fetchDiscoveryContent(articleUrl, { pool: bodyStore.db });
assert.equal(bodyAgent.content_type, 'article_body');
assert.equal(bodyAgent.content.length, 20_000);
assert.equal(bodyAgent.truncated, true);
assert.equal(bodyAgent.content_complete, false);
assert.equal(
  (
    await getOrFetchArticle(networkStore.db, 'https://example.test/final', {
      fetchDocument: async () => {
        throw new Error('Known final URL should hit cache');
      },
    })
  ).origin,
  'cache',
);
for (const data of [
  { markdown: '# Login\nSign in to read', metadata: {} },
  { markdown: articleText, metadata: { contentComplete: false } },
  { markdown: articleText, metadata: { truncated: true } },
  { markdown: '# Abstract\n\n' + articleText.replace('# Article', ''), metadata: {} },
]) {
  const incomplete = await fetchDiscoveryArticle(articleUrl, {
    apiKey: 'mock',
    maxRetries: 0,
    fetchImpl: async () => Response.json({ success: true, data }),
  });
  assert.equal(incomplete.isComplete, false);
}
// Invoke the real Agents Function Tool: cache commits before Candidate selection or Run completion.
const toolStore = new ArticleStore();
const savedFetch = globalThis.fetch;
const savedKey = process.env.FIRECRAWL_API_KEY;
try {
  globalThis.fetch = mockFetch;
  process.env.FIRECRAWL_API_KEY = 'mock';
  const context = { fetches: [] as Awaited<ReturnType<typeof fetchDiscoveryContent>>[] };
  const tool = createDiscoveryFetchContentTool({ timeoutMs: 90_000, pool: toolStore.db });
  await tool.invoke(new RunContext(context), JSON.stringify({ url: articleUrl }));
  assert.equal(toolStore.cache.size, 1);
  assert.equal(context.fetches.length, 1);
  assert.equal(context.fetches[0]?.status, 'success');
  toolStore.failLookup = true;
  await tool.invoke(new RunContext(context), JSON.stringify({ url: articleUrl }));
  assert.equal(
    context.fetches.at(-1)?.status,
    'error',
    'A failed cache read is captured as a failed tool result, never normal empty discovery.',
  );
} finally {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.FIRECRAWL_API_KEY;
  else process.env.FIRECRAWL_API_KEY = savedKey;
}
console.log(
  'Discovery cache: full Markdown, metadata, pre-Candidate persistence, Daily reuse, concurrent dedup, failure recovery and incomplete-content guards passed.',
);
