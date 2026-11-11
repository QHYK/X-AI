/** Offline examples plus optional local, human-annotated PostgreSQL snapshots. Never connects to a DB. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPreview, digest } from '../src/collectors/gmail/preview.js';
import {
  createSourceGuidance,
  isExplicitNewsletterSkip,
} from '../src/collectors/gmail/source-guided-selection.js';
import { newsletterRawArticles } from '../src/collectors/gmail/adapter.js';
import { parseMessage, type GmailMessage } from '../src/collectors/gmail/mail.js';
import { saveFetchedEmail, processStoredEmail } from '../src/collectors/gmail/email-store.js';
import { newsletterDetail } from '../src/lib/newsletter-parser.js';
import { newsletterStore } from './fixtures/newsletter-store.js';
const analyze = (html: string) =>
  createSourceGuidance(html, 'The Information AM', createPreview(html), '', {
    subject: 'Article notification',
  });
const html =
  '<table><tr><td>Nov 10, 2026</td></tr></table><p>Article introduction.</p><p>More reporting.</p><table><tr><td><a href="https://example.test/article">Read the full article</a></td></tr></table><h1><a href="https://example.test/article">Article headline</a></h1><p>By Reporter</p><p>A message from Sponsor</p><p>Excluded ad</p><h2>Related articles</h2><h4>Excluded related story</h4>';
const article = analyze(html);
assert.equal(article.template, 'information:article_teaser');
assert.equal(article.units.length, 1);
assert.equal(article.units[0].title, 'Article headline');
assert.equal(article.units[0].content_type, 'standalone_content');
assert.equal(article.units[0].primary_url, 'https://example.test/article');
assert.match(article.units[0].content_text, /By Reporter/);
assert.ok(!/Sponsor|Excluded/.test(article.units[0].content_text));
for (const invalid of [
  html.replace('<p>By Reporter</p>', ''),
  html.replace('<h1>', '<h2>').replace('</h1>', '</h2>'),
  html.replace('Read the full article', 'Subscribe now'),
])
  assert.equal(
    analyze(invalid).units.length,
    0,
    'Missing structural markers must remain unsupported',
  );
const promo = analyze(
  '<p>Hello Reader</p><p>Personal episode recommendation.</p><table><tr><td>Watch the episode</td></tr></table><p>About AI Deep Dive</p><p>This episode was produced in partnership with Example. AI Deep Dive is supported by Example.</p>',
);
assert.equal(promo.template, 'information:episode_promotion');
assert.equal(isExplicitNewsletterSkip(promo), true);
assert.equal(
  isExplicitNewsletterSkip(analyze('<p>Hello Reader</p><p>Other personal recommendation.</p>')),
  false,
  'Do not skip arbitrary personal recommendations',
);
const realCases = [
  ['1a1c1f21a5b32c4f', 'success'],
  ['1a1c2e64754a88b1', 'success'],
  ['1a1c393320e05c89', 'success'],
  ['1a1c39c6a0795bcf', 'success'],
  ['1a1c528cbdcd69f5', 'success'],
  ['1a1c3300fa467bf9', 'skipped'],
  ['1a1c247a07a0bfd9', 'unsupported'],
  ['1a1c2a6c1da9fb8a', 'unsupported'],
] as const;
const store = newsletterStore();
let validated = 0;
for (const [id, expected] of realCases) {
  let raw: GmailMessage;
  try {
    raw = JSON.parse(
      await readFile(`runtime/gmail-parser-regression/${id}.json`, 'utf8'),
    ).raw_message;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
    throw error;
  }
  const mail = await parseMessage(raw),
    preview = createPreview(mail.html!);
  const guidance = createSourceGuidance(
    mail.html!,
    'The Information AM',
    preview,
    mail.plainText ?? '',
    { subject: mail.subject ?? undefined, senderName: mail.from[0]?.name },
  );
  await saveFetchedEmail(store.pool, id, raw);
  const result = await processStoredEmail(store.pool, id);
  assert.equal(result.status, expected, id);
  validated++;
  if (expected === 'success') {
    assert.equal(guidance.units.length, 1);
    assert.equal(result.inserted, 1);
    assert.equal((await processStoredEmail(store.pool, id)).inserted, 0);
    assert.ok(guidance.units[0].primary_url);
  }
  const detail = await newsletterDetail(store.emails.get(id)!, store.pool);
  assert.equal(detail.template, guidance.template);
  if (expected === 'skipped') assert.equal(detail.previewError, null);
  if (id === '1a1c528cbdcd69f5') {
    const annotation = JSON.parse(await readFile(`${id}.json`, 'utf8'));
    assert.equal(preview.html_sha256, annotation.source.html_sha256);
    assert.equal(digest(JSON.stringify(preview.blocks)), annotation.source.blocks_sha256);
    const unit = guidance.units[0],
      human = annotation.added_units[0];
    assert.deepEqual(unit.boundary, human.boundary);
    assert.equal(unit.title, human.corrections.title);
    assert.equal(unit.content_type, human.content_type);
    const doc = new JSDOM(mail.html!);
    try {
      const a = human.boundary_references.start.start_offset,
        b = human.boundary_references.end.end_offset;
      assert.equal(unit.source_range.start_offset, a);
      assert.equal(unit.source_range.end_offset, b);
      assert.ok(doc.window.document.body.textContent?.includes('Read the full article'));
    } finally {
      doc.window.close();
    }
  }
  if (id === '1a1c3300fa467bf9') {
    const annotation = JSON.parse(await readFile(`${id}.json`, 'utf8'));
    assert.equal(annotation.email_review.skip, true);
    assert.deepEqual(newsletterRawArticles(mail), []);
  }
  console.log(
    JSON.stringify({
      id,
      template: guidance.template,
      units: guidance.units.length,
      status: result.status,
    }),
  );
}
console.log(
  `PASS article teaser and explicit episode-promotion rules; ${validated}/8 optional real examples verified offline; no database, Gmail or LLM calls.`,
);
