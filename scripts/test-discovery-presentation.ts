import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import type { InDepthReviewItem } from '../src/lib/in-depth-reads.js';

// Node has no CSS-module loader. Keep class names readable while rendering the real component.
register(
  `data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.module.css')) return { format: 'module', source: 'export default new Proxy({}, { get: (_, key) => key });', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url,
);

const { InDepthReviewClient } = await import('../src/app/(admin)/review/in-depth/review-client.js');
const { AppRouterContext } =
  await import('next/dist/shared/lib/app-router-context.shared-runtime.js');
const css = await readFile(
  new URL('../src/app/(admin)/review/review.module.css', import.meta.url),
  'utf8',
);
const fullTitle = '一个完整展示、不应被省略的候选作品标题'.repeat(8);
const item: InDepthReviewItem = {
  id: '00000000-0000-4000-8000-000000000001',
  candidateId: 'candidate',
  runId: 'run',
  reviewStatus: 'pending',
  editorialNotes: null,
  editorialOverrides: null,
  reviewedAt: null,
  createdAt: '2026-10-19T03:00:00Z',
  candidateCreatedAt: '2026-10-19T03:00:00Z',
  discoveryPath: 'topic',
  url: 'https://example.test/article',
  originalTitle: fullTitle,
  titleZh: fullTitle,
  author: 'Author',
  publication: 'Source',
  contentType: 'article',
  estimatedDurationMinutes: 15,
  summary: 'Summary',
  whyWorthReading: 'Reason',
  extraInfo: {},
  evaluation: { tags: [{ zh: '科学方法', en: 'Scientific Method' }] },
  evidence: {
    fetch: {
      coverImage: {
        url: 'https://example.test/cover.jpg',
        source: 'og:image',
        width: 1200,
        height: 800,
      },
    },
  },
};
function render(value: InDepthReviewItem) {
  const markup = renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: { refresh() {} } as never },
      createElement(InDepthReviewClient, { initialItems: [value], status: 'pending' }),
    ),
  );
  return new JSDOM(`<style>${css}</style>${markup}`);
}
const dom = render(item);
try {
  const doc = dom.window.document;
  assert.equal(doc.querySelector('.inDepthDetailHeader h2')?.textContent, fullTitle);
  const diagnostics = Object.fromEntries(
    Array.from(doc.querySelectorAll('.inDepthMeta dt')).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );
  assert.equal(diagnostics['Discovery Path'], 'Topic');
  assert.equal(diagnostics['Processing Stage'], 'D3');
  assert.equal(diagnostics['Candidate ID'], item.candidateId);
  assert.equal(diagnostics['Run ID'], item.runId);
  assert.equal(doc.querySelector('.inDepthTags strong')?.textContent, '科学方法');
  assert.equal(doc.querySelector('.inDepthTags small')?.textContent, 'Scientific Method');
  assert.equal(
    dom.window.getComputedStyle(doc.querySelector('.inDepthTags')!).justifyContent,
    'flex-start',
  );
  const image = doc.querySelector('.inDepthCover img');
  assert.equal(image?.getAttribute('src'), 'https://example.test/cover.jpg');
  assert.equal(dom.window.getComputedStyle(image!).objectFit, 'contain');
  assert.equal(doc.querySelector('.inDepthBasicInfo input'), null, 'Metadata is read only.');
  assert.doesNotMatch(doc.body.textContent ?? '', /Editorial display/);
  assert.match(doc.body.textContent ?? '', /完善介绍/);
  assert.match(doc.body.textContent ?? '', /Save notes/);
  assert.match(doc.body.textContent ?? '', /Save changes/);
  assert.match(doc.querySelector('.inDepthDetail')?.textContent ?? '', /Review notes/);
  const responsive = Array.from(doc.styleSheets[0]!.cssRules).find(
    (rule) =>
      rule instanceof dom.window.CSSMediaRule && rule.conditionText === '(max-width: 1100px)',
  ) as CSSMediaRule | undefined;
  assert.ok(responsive);
  const infoRule = Array.from(responsive.cssRules).find(
    (rule) => rule instanceof dom.window.CSSStyleRule && rule.selectorText === '.inDepthBasicInfo',
  ) as CSSStyleRule | undefined;
  assert.equal(infoRule?.style.getPropertyValue('grid-template-columns'), 'minmax(0, 1fr)');
} finally {
  dom.window.close();
}
const legacyTitle = render({ ...item, editorialOverrides: { title: 'Legacy editorial title' } });
assert.equal(
  legacyTitle.window.document.querySelector('.inDepthDetailHeader h2')?.textContent,
  fullTitle,
);
legacyTitle.window.close();
const legacy = render({ ...item, evaluation: null, evidence: null });
try {
  assert.match(
    legacy.window.document.querySelector('.inDepthCover')?.textContent ?? '',
    /No cover image/,
  );
  assert.match(legacy.window.document.querySelector('.inDepthTags')?.textContent ?? '', /No tags/);
} finally {
  legacy.window.close();
}
for (const [discoveryPath, stage] of [
  ['direct', 'D4'],
  ['open', 'D5'],
] as const) {
  const result = render({
    ...item,
    discoveryPath,
    publication: 'Unknown',
    titleZh: null,
    summary: null,
    whyWorthReading: null,
    evidence: null,
    evaluation: null,
  });
  const meta = Object.fromEntries(
    Array.from(result.window.document.querySelectorAll('.inDepthMeta dt')).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );
  assert.equal(meta['Processing Stage'], stage);
  assert.equal(meta.Source, 'example.test');
  result.window.close();
}
console.log(
  'In-depth full title, bilingual Tags, read-only metadata, image proportions and legacy empty state passed.',
);
