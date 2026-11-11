import assert from 'node:assert/strict';
import { inspectUrl, plainAlternativeTarget } from '../../src/collectors/gmail/link-tools.js';
const target = 'https://publisher.example/story?utm_source=mail';
assert.equal(
  inspectUrl(`https://track.example/click?url=${encodeURIComponent(target)}`)?.resolved_url,
  target,
);
assert.equal(
  inspectUrl(
    `https://newslink.reuters.com/click/campaign/${Buffer.from(target).toString('base64url')}/recipient`,
  )?.resolved_url,
  target,
);
const jsonTarget = Buffer.from(
  JSON.stringify({ email_id: 'synthetic', href: target, internal: false }),
).toString('base64url');
assert.equal(inspectUrl(`https://e.customeriomail.com/e/c/${jsonTarget}`)?.resolved_url, target);
for (const value of [
  'javascript:alert(1)',
  'data:text/html,hi',
  'https://user:password@example.test/a',
  '/relative',
])
  assert.equal(inspectUrl(value), null);
const opaque = inspectUrl('https://link.mail.beehiiv.com/ss/c/u001.opaque-token');
assert.equal(opaque?.resolved_url, null);
assert.equal(opaque?.target_url, null);
const ambiguous = inspectUrl(
  `https://track.example/click?url=${encodeURIComponent(target)}&target=https%3A%2F%2Fother.example%2Fstory`,
);
assert.equal(ambiguous?.static_resolution, 'ambiguous');
assert.equal(
  plainAlternativeTarget(
    'A reliable article title [https://publisher.example/story]',
    'A reliable article title',
  )?.url,
  'https://publisher.example/story',
);
assert.equal(
  plainAlternativeTarget(
    '[A reliable article title](https://publisher.example/story)',
    'A reliable article title',
  )?.url,
  'https://publisher.example/story',
);
assert.equal(
  plainAlternativeTarget(
    'A reliable article title [https://a.example/one] A reliable article title [https://b.example/two]',
    'A reliable article title',
  ),
  null,
);
assert.equal(
  plainAlternativeTarget(
    'A reliable article title then unrelated prose https://a.example/one',
    'A reliable article title',
  ),
  null,
);
console.log(
  'PASS conservative URL/query/base64/JSON decoding, opaque and ambiguous targets, exact plain-alternative evidence',
);
