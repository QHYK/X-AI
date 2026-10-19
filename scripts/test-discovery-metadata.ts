import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  DiscoveryTagsSchema,
  readDiscoveryContentMetadata,
} from '../src/lib/discovery-content-metadata.js';
import { coverFromRawArticle, extractArticleCover } from '../src/discovery/article-cover.js';
import { fetchDiscoveryContent } from '../src/discovery/fetch-content.js';
import {
  DiscoveryD3OutputSchema,
  validateDiscoveryD3Output,
} from '../src/discovery/topic-discovery.js';
import {
  DiscoveryD5OutputSchema,
  validateDiscoveryD5Output,
} from '../src/discovery/open-discovery.js';
import { parseAndValidateDiscoveryD4Output } from '../src/discovery/direct-verification.js';

const tag = { zh: '科学方法', en: 'Scientific Method' };
assert.deepEqual(
  DiscoveryTagsSchema.parse([
    tag,
    { zh: '科学方法', en: 'Science Method' },
    { zh: '科学研究', en: 'scientific method' },
  ]),
  [tag],
);
assert.deepEqual(DiscoveryTagsSchema.parse([]), []);
for (const tags of [
  [{ zh: '科学' }],
  [{ en: 'Science' }],
  [{ zh: 'Science', en: '科学' }],
  [{ zh: '科学', en: '' }],
  Array(4).fill(tag),
]) {
  assert.equal(DiscoveryTagsSchema.safeParse(tags).success, false);
}
// The schemas delivered to Agents must remain convertible to strict Structured Output.
assert.ok(z.toJSONSchema(DiscoveryD3OutputSchema));
assert.ok(z.toJSONSchema(DiscoveryD5OutputSchema));
const work = {
  url: 'https://example.test/work',
  title: 'Work',
  title_zh: '作品',
  author: 'Author',
  publication: 'Source',
  contentType: 'article',
  publishedAt: null,
  estimatedDurationMinutes: 15,
  summary: '摘要',
  whyWorthReading: '理由',
  evidence: '正文证据',
  limitations: '',
  extra_info: '{}',
  tags: [tag],
};
assert.deepEqual(validateDiscoveryD5Output({ candidates: [work] })[0]?.tags, [tag]);
const topicWork = Object.fromEntries(Object.entries(work).filter(([key]) => key !== 'publication'));
const lead = {
  leadId: 'lead-1',
  kind: 'topic' as const,
  question: 'Question',
  newsContext: 'Context',
  rationale: 'Reason',
  sourceContentIds: [],
};
assert.deepEqual(
  validateDiscoveryD3Output({ candidates: [{ ...topicWork, sourceLeadId: lead.leadId }] }, [
    lead,
  ])[0]?.tags,
  [tag],
);
const evaluation = {
  candidateId: 'candidate',
  decision: 'qualified',
  reason: '判断理由',
  title_zh: '中文标题',
  summary: '中文内容概要',
  whyWorthReading: '中文推荐理由',
  evidence: [],
  limitations: [],
  extra_info: '{}',
  tags: [tag],
};
assert.deepEqual(
  parseAndValidateDiscoveryD4Output(JSON.stringify({ evaluations: [evaluation] }), ['candidate'])[0]
    ?.tags,
  [tag],
);
assert.throws(() =>
  parseAndValidateDiscoveryD4Output(
    JSON.stringify({ evaluations: [{ ...evaluation, tags: [{ zh: '科学' }] }] }),
    ['candidate'],
  ),
);

const url = 'https://example.test/posts/work';
assert.deepEqual(
  extractArticleCover({
    url,
    metadata: { ogImage: '/images/hero.jpg', ogImageWidth: 1200, ogImageHeight: 800 },
  }),
  {
    url: 'https://example.test/images/hero.jpg',
    source: 'og:image',
    width: 1200,
    height: 800,
  },
);
assert.equal(
  extractArticleCover({ url, html: '<meta name="twitter:image" content="../cover.jpg">' })?.url,
  'https://example.test/cover.jpg',
);
assert.equal(
  extractArticleCover({
    url,
    html: '<article><img src="/body.jpg" width="900" height="600"></article>',
  })?.source,
  'article',
);
assert.equal(
  extractArticleCover({
    url,
    html: '<article><img src="/small.jpg" srcset="/medium.jpg 640w, /large.jpg 1280w"></article>',
  })?.url,
  'https://example.test/large.jpg',
);
assert.equal(
  extractArticleCover({
    url,
    html: '<article><img src="https://images.example.test/photo.jpg" width="900" height="600"></article>',
  })?.url,
  'https://images.example.test/photo.jpg',
);
for (const html of [
  '<article>No images</article>',
  '<article><img src="/logo.jpg" width="1200" height="800"></article>',
  '<article><img src="/portrait.jpg" alt="Author avatar" width="1200" height="800"></article>',
  '<article><aside><img src="/recommended.jpg" width="1200" height="800"></aside></article>',
  '<article><div class="related"><img src="/other.jpg" width="1200" height="800"></div></article>',
  '<article><img src="/pixel.png" width="1" height="1"></article>',
  '<article><img src="javascript:alert(1)" width="1200" height="800"></article>',
  '<meta property="og:image" content="data:image/png;base64,AAAA">',
  '<article><img src="/unknown-size.jpg"></article>',
])
  assert.equal(extractArticleCover({ url, html }), null, html);
assert.equal(
  extractArticleCover({
    url,
    metadata: {
      ogImage: '/small.jpg',
      ogImageWidth: 100,
      ogImageHeight: 100,
      twitterImage: '/large.jpg',
    },
  })?.source,
  'twitter:image',
);
assert.equal(coverFromRawArticle('https://user:pass@example.test/image.jpg', url), null);
assert.equal(coverFromRawArticle('/hero.jpg', url)?.source, 'raw_article');

let requests = 0;
const fetched = await fetchDiscoveryContent(url, {
  apiKey: 'mock',
  maxRetries: 0,
  fetchImpl: async (_input, options) => {
    requests++;
    assert.deepEqual(JSON.parse(String(options?.body)).formats, ['markdown', 'html']);
    return Response.json({
      success: true,
      data: {
        markdown: '# Article\n\n' + 'Readable body. '.repeat(100),
        html: '<article><img src="/cover.jpg" width="1000" height="600"></article>',
      },
    });
  },
});
assert.equal(requests, 1, 'Images reuse the content request.');
assert.equal(fetched.status, 'success');
assert.equal(fetched.cover_image?.url, 'https://example.test/cover.jpg');
const withoutImage = await fetchDiscoveryContent(url, {
  apiKey: 'mock',
  maxRetries: 0,
  fetchImpl: async () =>
    Response.json({
      success: true,
      data: {
        markdown: 'Readable body. '.repeat(100),
        html: { malformed: true },
        metadata: { ogImage: 'javascript:bad' },
      },
    }),
});
assert.equal(withoutImage.status, 'success');
assert.equal(withoutImage.cover_image, null);
assert.ok(withoutImage.content.length > 0);
const badMetadata = Object.defineProperty({}, 'ogImage', {
  get() {
    throw new Error('Mock image parser failure');
  },
});
const priorWarn = console.warn;
let warned = false;
console.warn = () => {
  warned = true;
};
try {
  const stillReadable = await fetchDiscoveryContent(url, {
    apiKey: 'mock',
    maxRetries: 0,
    fetchImpl: async () => {
      const response = new Response(null, { status: 200 });
      response.json = async () => ({
        success: true,
        data: { markdown: 'Readable body. '.repeat(100), metadata: badMetadata },
      });
      return response;
    },
  });
  assert.equal(stillReadable.status, 'success');
  assert.equal(stillReadable.cover_image, null);
  assert.equal(warned, true);
} finally {
  console.warn = priorWarn;
}

assert.deepEqual(readDiscoveryContentMetadata({ evaluation: null, evidence: null }), {
  tags: [],
  cover: null,
});
assert.deepEqual(
  readDiscoveryContentMetadata({
    evaluation: { tags: [tag] },
    evidence: { fetch: { coverImage: fetched.cover_image } },
  }),
  { tags: [tag], cover: fetched.cover_image },
);
assert.deepEqual(
  readDiscoveryContentMetadata({
    evaluation: { tags: [{ en: 'English only' }] },
    evidence: { coverImage: { url: 'javascript:bad' } },
  }),
  { tags: [], cover: null },
);
console.log(
  'Discovery bilingual Tags, verified Cover extraction, one-request Fetch and legacy compatibility passed.',
);

// Shared Source precedence, safe legacy fallback and same-response metadata extraction.
const { resolveDiscoveryPublication, publicationFromMetadata } =
  await import('../src/lib/discovery-source.js');
const { extractPublication } = await import('../src/discovery/source-metadata.js');
assert.equal(publicationFromMetadata({ ogSiteName: '  IEEE   Spectrum ' }), 'IEEE Spectrum');
assert.equal(extractPublication({ publisher: { name: 'IMF' } }), 'IMF');
assert.equal(
  extractPublication(
    {},
    '<script type="application/ld+json">{"@graph":[{"@type":"Article","publisher":{"name":"Distill"},"author":{"name":"Not publisher"}}]}</script>',
  ),
  'Distill',
);
assert.equal(
  extractPublication(
    {},
    '<script type="application/ld+json">invalid</script><meta property="og:site_name" content="IEEE Spectrum">',
  ),
  'IEEE Spectrum',
);
assert.equal(
  extractPublication(
    { ogSiteName: 'Unknown' },
    '<script type="application/ld+json">{"publisher":{"name":"IMF"}}</script>',
  ),
  'IMF',
);
assert.equal(
  extractPublication(
    {},
    '<script type="application/ld+json">{"author":{"name":"Not publisher"}}</script>',
  ),
  null,
);
const sourceInput = {
  url: 'https://www.example.test/article',
  dailySource: 'Daily source',
  publication: 'Model source',
  sources: [{ url: 'https://example.test/rss', name: 'Configured source' }],
};
assert.equal(
  resolveDiscoveryPublication({ ...sourceInput, metadata: { ogSiteName: 'Verified source' } }),
  'Verified source',
);
assert.equal(
  resolveDiscoveryPublication({
    ...sourceInput,
    metadata: { ogSiteName: 'Just another WordPress site' },
  }),
  'Daily source',
);
assert.equal(
  resolveDiscoveryPublication({ ...sourceInput, dailySource: 'Unknown' }),
  'Model source',
);
assert.equal(
  resolveDiscoveryPublication({ ...sourceInput, dailySource: '', publication: null }),
  'Configured source',
);
assert.equal(
  resolveDiscoveryPublication({ ...sourceInput, dailySource: null, publication: 'example.test' }),
  'Configured source',
);
assert.equal(
  resolveDiscoveryPublication({ url: 'https://www.imf.org/work', publication: 'Unknown' }),
  'imf.org',
);
assert.equal(
  resolveDiscoveryPublication({ url: 'javascript:alert(1)', publication: 'Unknown' }),
  'Unknown',
);
assert.equal(resolveDiscoveryPublication({ url: 'broken' }), 'Unknown');
const withPublisher = await fetchDiscoveryContent(url, {
  apiKey: 'mock',
  maxRetries: 0,
  fetchImpl: async () =>
    Response.json({
      success: true,
      data: {
        markdown: 'Article text. '.repeat(100),
        html: '<meta property="og:site_name" content="IMF">',
      },
    }),
});
assert.equal(withPublisher.metadata.publication, 'IMF');
assert.equal(withPublisher.status, 'success');
