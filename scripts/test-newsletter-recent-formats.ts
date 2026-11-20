/** Offline format regression from the November annotation review. No mailbox or DB access. */
import assert from 'node:assert/strict';
import {
  createSourceGuidance,
  isExplicitNewsletterSkip,
} from '../src/collectors/gmail/source-guided-selection.js';
import { createContentReferences } from '../src/collectors/gmail/html.js';
import { newsletterSource } from '../src/collectors/gmail/newsletter-source.js';
const analyze = (html: string, source = 'The Information AM') =>
  createSourceGuidance(html, source, createContentReferences(html));
for (const heading of ['Monday Readout', 'Big Tech News', 'Finance News', 'Anthropic IPO Live']) {
  assert.ok(
    isExplicitNewsletterSkip(
      analyze(
        `<h1>${heading}</h1><p>Black Friday: lock in 25% off.</p><a href="https://example.test/subscribe">Subscribe</a>`,
      ),
    ),
  );
  assert.equal(
    isExplicitNewsletterSkip(
      analyze(`<h1>${heading}</h1><p>Actual reporting without sales markers.</p>`),
    ),
    false,
  );
}
assert.equal(isExplicitNewsletterSkip(analyze('<p>Unknown template</p>')), false);
const numbered = analyze(
  '<table><tr><td>1.</td></tr></table><p>Useful report.</p><p>Cut through the noise. Subscribe now.</p><p>Excluded sales footer</p>',
);
assert.equal(numbered.units.length, 1);
assert.ok(!/noise|Excluded/.test(numbered.units[0].content_text));
const growth =
  '<h3>Opening promotional quote</h3><p>OK，以下是本周正刊内容，Enjoy——</p>' +
  Array.from(
    { length: 6 },
    (_, i) => `<h3><a href="https://example.test/${i}">Story ${i}</a></h3><p>Full content ${i}</p>`,
  ).join('') +
  '<h3>随便看看：</h3><ul>' +
  Array.from(
    { length: 5 },
    (_, i) =>
      `<li><p><a href="https://example.test/ref${i}">Reference ${i}</a> Commentary.</p></li>`,
  ).join('') +
  '</ul><h3>适合个人上手的教程/评测/资源：</h3><ul><li>Excluded tools</li></ul><h3>更多链接 / 推荐：</h3><p>Excluded promotion</p>';
const result = analyze(growth, '增长黑客AI周报');
assert.equal(result.units.length, 11);
assert.equal(result.units.filter((u) => u.content_type === 'standalone_content').length, 6);
assert.equal(result.units.filter((u) => u.content_type === 'external_reference').length, 5);
assert.ok(result.units.every((u) => !/Opening|Excluded/.test(u.content_text) && u.primary_url));
assert.equal(analyze(growth.replace('随便看看：', 'unknown'), '增长黑客AI周报').units.length, 0);
assert.equal(
  newsletterSource({
    gmailMessageId: 'test',
    html: '',
    from: [{ address: 'ghacker@substack.com', name: 'Changed display name' }],
  }),
  '增长黑客AI周报',
);
console.log(
  'PASS recent sales/live promotion, unknown-template guard, footer cutoff and growth weekly 6+5 segmentation.',
);

const subject = 'Did JPMorgan and Citi miss the warning signs on a data center loan?';
const thematicHtml =
  '<p>Hi there,</p><p>Original reporting introduction.</p>' +
  '<p>Get early access to our Black Friday sale and lock in 25% off.</p><a href="https://example.test/subscribe">Subscribe now</a>' +
  '<p>Here are eight stories on financing the AI boom.</p><h4>Lenders in the Crosshairs</h4>' +
  '<p>Useful reporting.</p><h4>How Money Moves</h4><p>Final analysis.</p>' +
  '<p>Cut through the noise. Subscribe now.</p><h4>Excluded promotion</h4><p>Excluded sales copy</p>';
const thematic = createSourceGuidance(
  thematicHtml,
  'The Information AM',
  createContentReferences(thematicHtml),
  '',
  { subject },
);
assert.equal(thematic.template, 'information:thematic_digest');
assert.equal(thematic.units.length, 1);
assert.equal(thematic.units[0].title, subject);
assert.equal(thematic.units[0].content_type, 'standalone_content');
assert.ok(thematic.units[0].content_text.startsWith('Hi there,'));
assert.ok(thematic.units[0].content_text.endsWith('Final analysis.'));
assert.ok(!/Cut through|Excluded/.test(thematic.units[0].content_text));
assert.equal(isExplicitNewsletterSkip(thematic), false);
const marketing = thematicHtml.replace('Hi there,', 'Hello,');
assert.equal(
  isExplicitNewsletterSkip(
    createSourceGuidance(marketing, 'The Information AM', createContentReferences(marketing), '', {
      subject,
    }),
  ),
  true,
);
console.log(
  'PASS subject-titled thematic digest, cutoff and adjacent marketing-template isolation.',
);
