import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPreview } from './review-preview.js';
import { createSourceGuidance } from './source-guided-selection.js';
import { createReviewStore, type EditableUnit } from './review-data.js';
import { createReviewServer } from './review-server.js';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const analyze = (
  source: string,
  body: string,
  subject = 'Test newsletter',
  senderName = source,
) => {
  const html = `<!doctype html><html><body>${body}</body></html>`;
  const result = createSourceGuidance(html, source, createPreview(html), '', {
    subject,
    senderName,
  });
  assert.deepEqual(
    result,
    createSourceGuidance(html, source, createPreview(html), '', { subject, senderName }),
  );
  assert.deepEqual(result.warnings, []);
  return result;
};
const ti = analyze(
  'The Information Briefing',
  `<p>Greetings!</p><p>First factual sentence. Second sentence with <a href="https://example.test/a">evidence</a> and <a href="https://example.test/b">Read more</a>.</p><h3>Analysis</h3><p>Full analysis.</p><h3>Today on The Information’s TITV</h3><p>Excluded TV</p><h2>New From Our Reporters</h2><a href="https://example.test/reporter"><h4>Reporter title</h4></a><h2>Upcoming Events</h2>`,
);
assert.equal(ti.units[0].title, 'First factual sentence.');
assert.equal(
  ti.units[0].primary_url,
  'https://example.test/a',
  'Briefing uses the first link, even when a later link is a CTA',
);
assert.equal(
  ti.units[2].primary_url,
  'https://example.test/reporter',
  'An anchor wrapping h4 is retained',
);
const reuters = analyze(
  'Reuters Daily Briefing',
  `<h2>Today's Top News</h2><p>Picture. REUTERS/Example</p><h3>Main feature</h3><p>Actual full story.</p><h3>In other news</h3><p>Other stories.</p><h2>Business &amp; Markets</h2><p>Business stories.</p><h2>Feature</h2><p>Feature body.</p><table><tr><td><a href="https://example.test/read">Read more</a></td></tr></table><h2>And Finally...</h2><p>Excluded ending</p>`,
  'Mail subject',
);
assert.deepEqual(
  reuters.units.map((u) => u.title),
  ['Mail subject', 'In other news', 'Business & Markets', 'Feature'],
);
assert.ok(reuters.units[0].content_text.includes('Actual full story'));
assert.ok(reuters.units.every((u) => !u.content_text.includes('Excluded ending')));
assert.equal(reuters.units.at(-1)!.primary_url, 'https://example.test/read');
const full = analyze(
  'Reuters Daily Briefing',
  `<h2>Today's Top News</h2><ul><li>${'Full actual news item. '.repeat(20)}</li></ul><h2>Business &amp; Markets</h2><p>Separate business.</p><h2>And Finally...</h2>`,
);
assert.equal(full.units.length, 2, 'Substantial top news must not merge with Business');
assert.ok(!full.units[0].content_text.includes('Separate business'));
const beacon = analyze(
  'Reuters Daily Briefing',
  `<p>By Author</p><p>Opening standalone feature.</p><h2>In their own words</h2><p>Related quotation.</p><h2>Another feature</h2><p>Separate body.</p><p>Sponsors are not involved in news.</p>`,
  'Subject of edition',
  'Reuters Beacon',
);
assert.equal(beacon.units.length, 2);
assert.ok(beacon.units[0].content_text.includes('Related quotation'));
const weekendReuters = analyze(
  'Reuters Daily Briefing',
  `<p>By Author</p><p>A long opening introduction that must be excluded from this weekend edition.</p><h2>Main story</h2><p>Kept story.</p><h2>The Week in Pictures</h2><p>Excluded gallery.</p><h2>Another story</h2><p>Kept second story.</p><h2>Before I forget…</h2><p>Excluded reminder.</p><h2>Later section</h2><p>Excluded later content.</p>`,
  'Weekend subject',
  'Reuters Weekend Briefing',
);
assert.equal(weekendReuters.units.length, 2);
assert.ok(weekendReuters.units.every((u) => !/Excluded|introduction/.test(u.content_text)));
const science = analyze(
  'Superhuman',
  `<h4>SCIENCE SUNDAY</h4><h2>Science news</h2><p>Kept science.</p><h4>SUNDAY SCIENCE TRIVIA</h4><p>Excluded quiz.</p><h4>ONLY GOOD NEWS</h4><h2>Good news</h2><p>Kept later news.</p>`,
);
assert.equal(science.units.length, 2);
assert.ok(science.units.every((u) => !u.content_text.includes('Excluded quiz')));
const ap = analyze(
  'The Associated Press',
  `<p>ADVERTISEMENT</p><p>By Author</p><p>Untitled opening discarded.</p><p>POLITICS</p><p>Political headline</p><p>Body.</p><p>RELATED COVERAGE ➤</p><p>Excluded references.</p><p>WORLD NEWS</p><p>World headline</p><p>World body.</p><p>US NEWS</p><p>US headline</p><p>US body.</p><p>ADVERTISEMENT</p><p>Excluded advertisement</p><p>IN OTHER NEWS</p><p>Excluded footer</p><p>SPORTS</p><p>Excluded later section</p>`,
);
assert.equal(ap.units.length, 3);
assert.equal(ap.units[2].title, 'US headline');
assert.ok(
  ap.units.every(
    (u) =>
      u.content_type === 'standalone_content' &&
      !u.content_text.includes('Excluded') &&
      !u.content_text.includes('Untitled opening'),
  ),
);
const am = analyze(
  'The Information AM',
  `<table><tr><td>1.</td><td><a href="https://example.test/one">Numbered title</a></td></tr></table><p>Original article body.</p><p>A message from Mizuho</p><h3>Excluded sponsored story</h3><p>Excluded sponsor body.</p><h2>Popular articles</h2><h4><a href="https://example.test/popular">Popular reference</a></h4><h2>Opportunities</h2>`,
);
assert.equal(am.units.length, 2);
assert.ok(
  am.units.every((u) => !u.content_text.includes('Mizuho') && !u.content_text.includes('Excluded')),
);
const editors = analyze(
  'The Information AM',
  `<p>Greetings Li,</p><p>First body paragraph.</p><p>Second body.</p><p>Follow us</p><p>Excluded footer.</p>`,
  'Editor’s Pick: A story',
  'The Information',
);
assert.equal(editors.template, 'information:editors_pick');
assert.equal(editors.units.length, 1);
assert.ok(
  editors.units[0].content_text.includes('Second body') &&
    !editors.units[0].content_text.includes('Follow us'),
);
const weekend = analyze(
  'The Information AM',
  `<table><tr><td>Welcome, Weekenders!</td></tr><tr><td>Complete editorial.</td></tr></table><h2>Other recommendations</h2>`,
  'The Billionaire Tax Might Fail—for Now',
  'The Information Weekend',
);
assert.equal(weekend.units[0].title, 'The Billionaire Tax Might Fail—for Now');
assert.ok(!weekend.units[0].content_text.includes('Other recommendations'));
const adHtml = '<h2>Pro Subscription</h2><p>Subscribe.</p><h2>Annual Subscription</h2>';
const ad = createSourceGuidance(adHtml, 'The Information AM', createPreview(adHtml));
assert.equal(ad.units.length, 0);
assert.equal(ad.template, 'information:subscription_ad');
// Intentional advertising exclusions are explicit diagnostics, not parser errors.
const superhuman = analyze(
  'Superhuman',
  `<h5>TODAY IN AI</h5><p>Original news.</p><h5>PRESENTED BY VANTA</h5><h2>Excluded sponsor</h2><p>Excluded pitch.</p><h5>TUTORIAL</h5><h2>Full guide</h2><p>Original tutorial.</p><h5>PRODUCTIVITY</h5><p>Tools retained.</p><h5>PROMPT STATION</h5><p>Excluded ending.</p>`,
  'Email title',
);
assert.equal(superhuman.units[0].title, 'Email title');
assert.equal(superhuman.units.length, 3);
assert.equal(superhuman.units[2].content_type, 'non_content');
assert.ok(superhuman.units.every((u) => !u.content_text.includes('Excluded')));
const robotics = analyze(
  'Superhuman',
  `<h4>WHAT’S NEXT</h4><h2>Robotics news</h2><p>News.</p><h4>SPONSORED BY G2</h4><h2>Excluded advertisement</h2><h4>ROBOTS IN ACTION</h4><h2>Robots at work</h2><p>Body.</p><h4>&#x50;RESENTED BY PARTNER</h4><p>Excluded pitch</p><h2>Your opinion matters!</h2>`,
  'Robotics edition',
);
assert.equal(robotics.template, 'superhuman:robotics_h4');
assert.equal(robotics.units.length, 2);
const unknownHtml = '<h4>AN UNRECOGNIZED PRODUCT</h4><h2>A title</h2><p>Unknown layout.</p>';
const unknown = createSourceGuidance(unknownHtml, 'Superhuman', createPreview(unknownHtml));
assert.equal(unknown.template, 'superhuman:unknown');
assert.equal(unknown.units.length, 0);
assert.ok(unknown.warnings.length);
assert.ok(robotics.units.every((u) => !u.content_text.includes('Excluded')));
const upside = analyze(
  'The Daily Upside',
  `<div>MARKETS</div><p>Excluded stock prices.</p><div><span style="font-size:24px">A complete article title</span></div><p>Actual body.</p><p>Written by Reporter</p><div>Extra Upside</div><p>Excluded footer.</p>`,
);
assert.equal(upside.units.length, 1);
assert.ok(upside.units[0].content_text.endsWith('Written by Reporter'));
const feature = analyze(
  'The Daily Upside',
  `<p>Excluded sponsor pitch</p><div><span style="font-size:24px">A weekend feature title</span></div><p>Actual body.</p><p>Written by Reporter</p>`,
);
assert.equal(feature.template, 'daily_upside:feature');
assert.equal(feature.units.length, 1);
assert.ok(!feature.units[0].content_text.includes('Excluded'));
const essential = analyze(
  'Reuters One Essential Read',
  `<h2>Essential report</h2><p>Body.</p><table><tr><td><a href="https://example.test/report">Read our special report</a></td></tr></table><p>Excluded footer</p>`,
);
assert.equal(essential.units[0].primary_url, 'https://example.test/report');
assert.ok(essential.units[0].content_text.endsWith('Read our special report'));
console.log(
  'PASS source-specific boundaries, heading variants, sponsor exclusions, titles, CTA links, non_content tools and bylines',
);

// Unclassified source proposals can be saved as pending; ordinary manual units still require a title/type.
const root = await realpath(await mkdtemp(join(tmpdir(), 'gmail-guidance-')));
try {
  await mkdir(join(root, 'parsed'));
  const html =
    '<h5>TODAY IN AI</h5><p>Pending original content.</p><h5>PROMPT STATION</h5><p>Excluded</p>';
  await writeFile(
    join(root, 'parsed', 'sample.json'),
    JSON.stringify({ gmailMessageId: 'sample', from: [{ name: 'Superhuman – Test' }], html }),
  );
  const store = createReviewStore(root),
    detail = await store.detail('sample'),
    proposal = detail.guidance.units[0];
  const unit: EditableUnit = {
    manual_id: proposal.id,
    status: 'uncertain',
    content_type: null,
    corrections: { title: '' },
    boundary: proposal.boundary,
    text_evidence: '',
    notes: 'Pending',
  };
  const saved = await store.save('sample', {
    revision: null,
    baseline: detail.baseline,
    added_units: [unit],
  });
  assert.equal(saved.value!.added_units[0].source_guidance?.review_label, 'superhuman_standalone');
  assert.equal(saved.value!.added_units[0].status, 'uncertain');
  await assert.rejects(
    store.save('sample', {
      revision: saved.revision,
      baseline: detail.baseline,
      added_units: [{ ...unit, status: 'accepted' }],
    }),
    /需要选择内容类型/,
  );
  const content = await readFile(join(root, 'annotations', 'sample.json'), 'utf8');
  await store.detail('sample');
  assert.equal(
    await readFile(join(root, 'annotations', 'sample.json'), 'utf8'),
    content,
    'Reading/recomputing proposals never overwrites human annotations',
  );
  await rm(join(root, 'annotations'), { recursive: true });
  const { server } = await createReviewServer(root);
  let browser: JSDOM | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await (await fetch(origin)).text();
    browser = new JSDOM(page, { url: origin, runScripts: 'outside-only' });
    const win = browser.window;
    win.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), origin);
      assert.equal(url.origin, origin);
      return fetch(url, { ...init, headers: { ...init?.headers, Origin: origin } });
    };
    const source = await readFile(new URL('./review-client.ts', import.meta.url), 'utf8');
    Object.assign(win, { exports: {} });
    win.eval(
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText,
    );
    async function waitFor(check: () => boolean) {
      for (let i = 0; i < 150; i++) {
        if (check()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('Client timeout');
    }
    const button = win.document.getElementById('load-guidance') as HTMLButtonElement;
    await waitFor(() => !button.disabled && !!win.document.getElementById('progress')!.textContent);
    button.click();
    button.click();
    assert.equal(
      win.document.querySelectorAll('#units button').length,
      1,
      'Repeated import is idempotent',
    );
    assert.equal(win.document.getElementById('selected-only'), null); // Unreviewed records remain visible.
    assert.match(win.document.getElementById('units')!.textContent!, /未审核/);
    (win.document.getElementById('save') as HTMLButtonElement).click();
    await waitFor(() => win.document.getElementById('save-status')!.textContent === '已保存');
    assert.equal((await store.detail('sample')).annotations!.added_units.length, 1);
    console.log(
      'PASS actual UI imports source regions once, keeps unreviewed candidates visible and saves pending unknown fields',
    );
  } finally {
    browser?.window.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  'PASS pending proposals persist without invented title/type, accepted validation remains strict, and original annotations remain separate',
);
