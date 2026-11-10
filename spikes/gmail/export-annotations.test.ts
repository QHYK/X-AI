import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportAnnotations, sanitizeUrl, createRedactor } from './export-annotations.js';
import { createPreview, digest } from './review-preview.js';
import type { Annotation } from './review-data.js';

assert.equal(
  sanitizeUrl('https://example.test/a?user_email=SECRET#token'),
  'https://example.test/a',
);
assert.equal(sanitizeUrl('https://user:SECRET@example.test/a'), 'https://example.test/a');
assert.equal(
  sanitizeUrl('https://newslink.reuters.com/click/campaign/SECRET'),
  'https://newslink.reuters.com/[tracking-path-redacted]',
);
const readable =
  'https://www.reuters.com/world/us/a-long-readable-public-news-headline-about-markets-and-trade-2026-11-06/';
assert.equal(sanitizeUrl(readable), readable);
assert.equal(sanitizeUrl('javascript:alert(1)'), null);
const redact = createRedactor(['Private Recipient']);
assert.doesNotMatch(
  redact('private recipient a@private.test https://example.test/story?token=SECRET'),
  /private recipient|a@private.test|SECRET/i,
);
assert.doesNotMatch(redact('Authorization: Bearer UNIQUE_SECRET'), /UNIQUE_SECRET/);
const root = await realpath(await mkdtemp(join(tmpdir(), 'gmail-export-')));
try {
  for (const dir of ['parsed', 'annotations']) await mkdir(join(root, dir));
  const html =
    '<html><body><h2>Previous heading</h2><p>Private Recipient contact a@private.test https://example.test/before?token=BEFORE_SECRET</p><h3>Business &amp; Markets</h3><p>One complete paragraph with multiple facts.</p><p>Second complete paragraph <a href="https://example.test/article?user_email=TRACKING_SECRET">Public reference</a>.</p><h2>Next heading</h2><p>After context https://example.test/after?token=AFTER_SECRET</p></body></html>';
  const preview = createPreview(html);
  await writeFile(
    join(root, 'parsed', 'sample.json'),
    JSON.stringify({
      gmailMessageId: 'sample',
      from: [{ name: 'Reuters Daily Briefing', address: 'sender@private.test' }],
      to: [{ name: 'Private Recipient', address: 'a@private.test' }],
      subject: 'Review subject',
      receivedAt: '2026-11-06T00:00:00Z',
      html,
      plainText: null,
    }),
  );
  const blocks = preview.blocks;
  const annotation: Annotation = {
    schema_version: 1,
    gmail_message_id: 'sample',
    source: {
      html_sha256: preview.html_sha256,
      blocks_sha256: digest(JSON.stringify(blocks)),
    },
    updated_at: '2026-11-06T00:00:00Z',
    added_units: [
      {
        manual_id: 'ea898290-d52c-4a95-8096-25aff88e3778',
        status: 'uncertain',
        content_type: null,
        corrections: { title: 'Business & Markets' },
        boundary: { start_node_id: blocks[2].node_id, end_node_id: blocks[4].node_id },
        boundary_references: { start: blocks[2], end: blocks[4] },
        source_guidance: { version: 1, review_label: 'mixed_section_pending' },
        text_evidence: '',
        notes: 'Contact a@private.test',
      },
    ],
  };
  const path = join(root, 'annotations', 'sample.json');
  await writeFile(path, JSON.stringify(annotation));
  await writeFile(join(root, 'token.json'), 'DO_NOT_READ_OR_EXPORT_AUTH');
  const before = await readFile(path, 'utf8'),
    output = join(root, 'export');
  const result = await exportAnnotations(root, output, join(root, 'no-guidance'));
  assert.equal(result.summary.messages, 1);
  assert.equal(result.summary.current_added_status_counts.uncertain, 1);
  const json = await readFile(join(output, 'newsletter-annotations-export.json'), 'utf8'),
    report = await readFile(join(output, 'newsletter-annotation-review.md'), 'utf8');
  assert.doesNotMatch(
    json + report,
    /TRACKING_SECRET|URL_SECRET|BEFORE_SECRET|AFTER_SECRET|DO_NOT_READ_OR_EXPORT_AUTH|a@private.test|sender@private.test|Private Recipient/,
  );
  assert.doesNotMatch(json + report, /<html>|<body>|<table>/);
  assert.match(report, /One complete paragraph with multiple facts/);
  assert.match(report, /Second complete paragraph/);
  const data = JSON.parse(json),
    unit = data.messages[0].units.find((u: { status: string }) => u.status === 'uncertain');
  assert.equal(unit.source_trace, 'verified_saved_boundary');
  assert.equal(unit.original_paragraphs.length, 3);
  assert.equal(unit.preliminary_review.previous_heading.title, 'Previous heading');
  assert.equal(unit.preliminary_review.next_heading.title, 'Next heading');
  assert.equal(unit.preliminary_review.only_summarizes_following_items, 'unknown');
  assert.equal(await readFile(path, 'utf8'), before);
  assert.match(report, /```json/);
  console.log(
    'PASS read-only export, complete uncertain paragraphs/context, provenance, unknown semantics, redaction and token-file exclusion',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
