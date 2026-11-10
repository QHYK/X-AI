import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gmailAuth, GMAIL_SCOPE, loadClient, saveJson } from './auth.js';
import { parseMessage, type MimePart } from './mail.js';
import {
  analyze,
  collect,
  DEFAULT_QUERY,
  retry,
  validateSelection,
  gmailReader,
} from './collector.js';
import { options } from './cli.js';
import type { OAuth2Client } from 'google-auth-library';

const directory = await mkdtemp(join(tmpdir(), 'gmail-spike-'));
const part = (mimeType: string, body: string): MimePart => ({
  mimeType,
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset=utf-8` }],
  body: { data: Buffer.from(body).toString('base64url') },
});
const message = (id: string, payload: MimePart) => ({
  id,
  threadId: 'thread',
  internalDate: '1700000000000',
  labelIds: ['UNREAD', 'Label_1'],
  payload: {
    ...payload,
    headers: [
      { name: 'From', value: '=?UTF-8?B?5rWL6K+V?= <sender@example.test>' },
      { name: 'To', value: 'Reader <reader@example.test>' },
      { name: 'Subject', value: '=?UTF-8?B?5paw6Ze7?=' },
      { name: 'Date', value: 'Tue, 14 Nov 2023 20:00:00 +0000' },
      { name: 'Message-ID', value: '<independent-id@example.test>' },
      ...(payload.headers ?? []),
    ],
  },
});
try {
  const credentials = join(directory, 'client.json');
  await writeFile(
    credentials,
    JSON.stringify({ installed: { client_id: 'synthetic-id', client_secret: 'synthetic-secret' } }),
  );
  assert.equal((await loadClient(credentials)).client_id, 'synthetic-id');
  const tokenPath = join(directory, 'token.json');
  await saveJson(tokenPath, {
    clientId: 'synthetic-id',
    scope: GMAIL_SCOPE,
    tokens: {
      access_token: 'synthetic-access-token',
      refresh_token: 'synthetic-refresh-token',
      expiry_date: Date.now() + 3_600_000,
    },
  });
  const cached = await gmailAuth(credentials, tokenPath);
  assert.equal(
    cached.client.credentials.access_token,
    'synthetic-access-token',
    'A valid local grant is reused without browser authorization',
  );
  await cached.save();
  assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
  await saveJson(tokenPath, { clientId: 'other-client', scope: GMAIL_SCOPE, tokens: {} });
  await assert.rejects(
    () => gmailAuth(credentials, tokenPath),
    /oauth_token_client_or_scope_mismatch/,
  );

  await assert.rejects(() => loadClient(join(directory, 'absent')), /oauth_client/);
  await writeFile(credentials, '{broken');
  await assert.rejects(() => loadClient(credentials), /oauth_client/);
  await writeFile(credentials, JSON.stringify({ web: { client_id: 'wrong-type' } }));
  await assert.rejects(() => loadClient(credentials), /oauth_desktop/);
  console.log('PASS OAuth credential loading and safe errors');

  const html =
    '<html><body><script>globalThis.mailExecuted=true</script><img src="https://never-request.example.test/pixel"><a href="https://example.test/article?utm_source=mail">Read article</a><a href="https://example.test/unsubscribe">Unsubscribe</a><a href="javascript:alert(1)">bad</a></body></html>';
  const htmlOnly = await parseMessage(message('html', part('text/html', html)));
  assert.equal(htmlOnly.parseStatus, 'success');
  assert.equal(htmlOnly.plainText, null, 'Never fabricate plaintext from HTML');
  assert.equal(htmlOnly.links.length, 2);
  assert.equal(htmlOnly.links[0].anchorText, 'Read article');
  assert.deepEqual(htmlOnly.links[0].hints, ['tracking']);
  assert.equal(htmlOnly.from[0].address, 'sender@example.test');
  assert.equal(htmlOnly.from[0].name, '测试');
  assert.equal(htmlOnly.subject, '新闻');
  assert.equal(htmlOnly.gmailThreadId, 'thread');
  assert.equal(htmlOnly.messageIdHeader, '<independent-id@example.test>');
  assert.notEqual(htmlOnly.messageIdHeader, htmlOnly.gmailMessageId);
  assert.equal((globalThis as Record<string, unknown>).mailExecuted, undefined);
  const textOnly = await parseMessage(
    message('plain', part('text/plain', '你好 https://example.test/plain')),
  );
  assert.equal(textOnly.html, null);
  assert.match(textOnly.plainText!, /你好/);
  const alternative: MimePart = {
    mimeType: 'multipart/alternative',
    parts: [part('text/plain', 'Plain body'), part('text/html', html)],
  };
  const nested = message('nested', {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/related',
        parts: [
          alternative,
          { mimeType: 'image/png', filename: 'inline.png', body: { attachmentId: 'do-not-fetch' } },
        ],
      },
      {
        mimeType: 'application/pdf',
        filename: 'attachment.pdf',
        body: { attachmentId: 'do-not-fetch' },
      },
    ],
  });
  const parsedNested = await parseMessage(nested);
  assert.equal(parsedNested.parseStatus, 'success');
  assert.ok(parsedNested.html && parsedNested.plainText);
  assert.equal(parsedNested.ignoredAttachments, 2);
  assert.equal(parsedNested.mimeTypes['multipart/alternative'], 1);
  const latin = await parseMessage(
    message('latin', {
      mimeType: 'text/plain',
      headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
      body: { data: Buffer.from('caf\xe9', 'latin1').toString('base64url') },
    }),
  );
  assert.equal(latin.plainText?.trim(), 'café');
  const partial = await parseMessage(
    message('partial', {
      mimeType: 'multipart/alternative',
      parts: [
        part('text/plain', 'Available'),
        { mimeType: 'text/html', body: { size: 100, attachmentId: 'large-body' } },
      ],
    }),
  );
  assert.equal(partial.parseStatus, 'partial');
  assert.ok(partial.errors.includes('body_requires_attachment_fetch'));
  const broken = await parseMessage(
    message('broken', { mimeType: 'text/plain', body: { data: '%%%' } }),
  );
  assert.equal(broken.parseStatus, 'failed');
  assert.ok(broken.errors.includes('mime_body_decode_failed'));
  const truncated = await parseMessage(
    message('truncated', {
      mimeType: 'text/plain',
      body: { data: Buffer.from('short').toString('base64url'), size: 100 },
    }),
  );
  assert.equal(truncated.parseStatus, 'failed');
  assert.ok(truncated.errors.includes('mime_body_size_mismatch'));
  console.log(
    'PASS HTML/plain, alternative/nested MIME, encoding, links, missing/invalid bodies, no remote resource/script execution',
  );

  const requests: { url: string; method: string; params: unknown }[] = [];
  const reader = gmailReader({
    request: async (r: (typeof requests)[number]) => {
      requests.push(r);
      return { data: r.url.endsWith('/messages') ? { messages: [{ id: 'one' }] } : nested };
    },
  } as unknown as OAuth2Client);
  await reader.list(DEFAULT_QUERY, undefined, 20);
  await reader.get('one');
  assert.ok(requests.every((r) => r.method === 'GET'));
  assert.deepEqual(requests[1].params, { format: 'full' });
  assert.ok(!requests.some((r) => /attachments|modify|trash/.test(r.url)));
  let attempts = 0;
  await retry(
    async () => {
      if (++attempts < 3) throw { response: { status: 429 } };
      return 'ok';
    },
    async () => {},
  );
  assert.equal(attempts, 3);
  attempts = 0;
  await assert.rejects(() =>
    retry(
      async () => {
        attempts++;
        throw { response: { status: 401 } };
      },
      async () => {},
    ),
  );
  assert.equal(attempts, 1);
  const listFailure = await collect(
    {
      list: async () => {
        throw {
          response: { status: 403, data: { error: { details: [{ reason: 'SERVICE_DISABLED' }] } } },
        };
      },
      get: async () => {
        throw new Error('must not get');
      },
    },
    join(directory, 'list-failure'),
  );
  assert.equal(listFailure.listError, 'gmail_http_403_service_disabled');
  assert.equal(listFailure.apiSuccess, 0);
  await assert.rejects(() => analyze(join(directory, 'absent-samples')), /sample_raw_directory/);
  let pages = 0;
  const sampleDir = join(directory, 'samples');
  const fake = {
    list: async (q: string, token: string | undefined, max: number) => {
      assert.equal(q, DEFAULT_QUERY);
      assert.ok(max <= 20);
      pages++;
      return token
        ? { messages: [{ id: 'api-fails' }, { id: 'parse-fails' }] }
        : { messages: [{ id: 'nested' }, { id: 'nested' }], nextPageToken: 'next' };
    },
    get: async (id: string) => {
      if (id === 'api-fails') throw { response: { status: 503 } };
      if (id === 'parse-fails') return { id };
      return nested;
    },
  };
  const first = await collect(fake, sampleDir);
  assert.equal(pages, 2);
  assert.equal(first.apiSuccess, 2);
  assert.equal(first.apiFailed, 1);
  assert.equal(first.parseFailed, 1);
  assert.equal(first.parseSuccess, 1);
  assert.equal(first.htmlRatio, 0.5, 'Unavailable messages count in the denominator');
  assert.equal(JSON.stringify(first).includes('sender@example.test'), false);
  assert.deepEqual(JSON.parse(await readFile(join(sampleDir, 'raw/nested.json'), 'utf8')), nested);
  assert.equal(
    JSON.parse(await readFile(join(sampleDir, 'parsed/parse-fails.json'), 'utf8')).parseStatus,
    'failed',
  );
  await collect(fake, sampleDir);
  assert.equal(
    (await readdir(join(sampleDir, 'raw'))).length,
    2,
    'Same IDs overwrite the same files',
  );
  assert.equal((await stat(join(sampleDir, 'raw/nested.json'))).mode & 0o777, 0o600);
  await saveJson(join(sampleDir, 'raw/corrupt.json'), { id: 'corrupt' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('Offline analysis must not use network');
  };
  try {
    const offline = await analyze(sampleDir);
    assert.equal(offline.parseSuccess, 1);
    assert.equal(offline.parseFailed, 2);
    assert.equal(offline.apiSuccess, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.throws(() => validateSelection('', 20));
  assert.throws(() => validateSelection('   ', 20));
  assert.throws(() => validateSelection(DEFAULT_QUERY, 201));
  assert.equal(options(['collect']).query, DEFAULT_QUERY);
  assert.equal(options(['collect']).limit, 20);
  assert.equal(options(['collect', '--query', 'label:other', '--limit', '3']).limit, 3);
  assert.throws(() => options(['collect', '--query', '']));
  console.log(
    'PASS Gmail GET-only requests, pagination, bounded retries, failure isolation, idempotent saves, private permissions, offline reparse and CLI bounds',
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
