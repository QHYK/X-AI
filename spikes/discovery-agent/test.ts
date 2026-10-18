import assert from 'node:assert/strict';
import { fetchContent } from './firecrawl-tool.js';
import { sanitizeSpanData } from './jsonl-tracing.js';

async function main(): Promise<void> {
  const success = await fetchContent('https://example.com/article', {
    apiKey: 'test-key',
    maxRetries: 0,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { markdown: `# Article\n\n${'Evidence paragraph. '.repeat(20)}` },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
  assert.equal(success.status, 'success');
  assert.ok(success.content.includes('Evidence paragraph.'));

  const failure = await fetchContent('https://example.com/unavailable', {
    apiKey: 'test-key',
    maxRetries: 0,
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, error: 'blocked' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  });
  assert.deepEqual(failure, {
    url: 'https://example.com/unavailable',
    status: 'error',
    content: '',
    content_length: 0,
    returned_content_length: 0,
    truncated: false,
    content_type: null,
    error: 'blocked',
  });

  const sanitized = sanitizeSpanData({
    type: 'function',
    name: 'fetch_content',
    input: JSON.stringify({ url: 'https://example.com/article' }),
    output: JSON.stringify({
      url: 'https://example.com/article',
      status: 'success',
      content: 'full webpage body must not enter trace',
      content_length: 999,
      returned_content_length: 999,
      truncated: false,
      content_type: 'article_body',
      error: null,
    }),
  });
  assert.equal(JSON.stringify(sanitized).includes('full webpage body'), false);
  assert.equal(JSON.stringify(sanitized).includes('https://example.com/article'), true);

  console.log('Discovery Agent spike unit tests passed.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
