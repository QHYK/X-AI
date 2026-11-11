import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { GuidedUnit } from '../src/collectors/gmail/source-guided-selection.js';
register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,nextLoad){if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};return nextLoad(url,context);}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', {
  url: 'http://localhost:3000/ai/newsletter-parser',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  DOMParser: dom.window.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { NewsletterParser, highlightNewsletterUnit } =
  await import('../src/app/(admin)/newsletter-parser/newsletter-parser.js');
const unit = (id: string, title: string): GuidedUnit => ({
  id,
  title,
  content_type: 'standalone_content',
  review_label: 'standalone_content',
  boundary: { start_node_id: 'n1', end_node_id: 'n2' },
  source_range: { html_sha256: 'test', start_offset: 0, end_offset: 100 },
  content_text: 'Full body',
  urls: [],
  primary_url: null,
  notes: '',
});
const units = [
  unit('11111111-1111-4111-8111-111111111111', 'First unit'),
  unit('22222222-2222-4222-8222-222222222222', 'Second unit'),
];
const calls: string[] = [];
let downloaded: Blob | null = null;
URL.createObjectURL = (blob: Blob) => {
  downloaded = blob;
  return 'blob:annotation';
};
URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function () {};
globalThis.fetch = async (input, init) => {
  assert.ok(!init?.method || init.method === 'GET');
  const url = new URL(String(input), window.location.href);
  calls.push(url.pathname);
  assert.equal(url.pathname, '/ai/api/admin/newsletter-parser');
  return Response.json(
    url.searchParams.has('id')
      ? {
          id: url.searchParams.get('id'),
          source: 'Reuters Daily Briefing',
          subject: 'Sample',
          receivedAt: '2026-10-28T00:00:00Z',
          html: '<p data-review-node="n1">First</p><p data-review-node="n2">Last</p>',
          units,
          warnings: [],
          template: 'test',
          html_sha256: 'a'.repeat(64),
          status: 'success',
          importedCount: 2,
          collectedAt: new Date().toISOString(),
          storedParserVersion: 2,
          currentParserVersion: 2,
          blocks_sha256: 'b'.repeat(64),
          differsFromImported: false,
          error: 'parse: Duplicate historical parser detail',
          previewError: '当前预览：模板待支持',
          blocks: [
            { node_id: 'n1', tag: 'p', excerpt: 'First', start_offset: 0, end_offset: 45 },
            { node_id: 'n2', tag: 'p', excerpt: 'Last', start_offset: 46, end_offset: 100 },
          ],
          links: [],
        }
      : {
          sources: ['Reuters Daily Briefing', 'Superhuman'],
          items: [
            {
              id: 'sample',
              source: 'Reuters Daily Briefing',
              subject: 'Sample',
              receivedAt: '2026-10-28T00:00:00Z',
              status: 'success',
            },
            {
              id: 'sample2',
              source: 'Reuters Daily Briefing',
              subject: 'Second mail',
              receivedAt: '2026-10-27T00:00:00Z',
              status: 'unsupported',
            },
          ],
          hasMore: false,
        },
  );
};
const root = createRoot(document.getElementById('root')!);
try {
  await act(async () => {
    root.render(createElement(NewsletterParser));
    await new Promise((r) => setTimeout(r, 30));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.ok(document.body.textContent?.includes('First unit'));
  assert.equal(document.querySelector('code')?.textContent, 'sample');
  assert.ok(document.body.textContent?.includes('Second unit'));
  assert.ok(document.querySelectorAll('textarea,input').length >= 5);
  assert.ok(document.querySelectorAll('select').length > 2);
  const frame = document.querySelector('iframe')!;
  assert.equal(frame.getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.ok(!frame.getAttribute('sandbox')!.includes('allow-scripts'));
  const buttons = Array.from(document.querySelectorAll('button'));
  assert.ok(buttons.some((b) => b.textContent === '下载本封标注'));
  assert.ok(buttons.some((b) => b.textContent === '新增遗漏内容'));
  assert.ok(!buttons.some((b) => /重新载入/.test(b.textContent ?? '')));
  await act(async () => {
    buttons.find((b) => b.textContent?.endsWith('Second unit'))!.click();
  });
  assert.equal(
    buttons.find((b) => b.textContent?.endsWith('Second unit'))?.getAttribute('aria-pressed'),
    'true',
  );
  assert.ok(!document.body.textContent?.includes('Duplicate historical parser detail'));
  assert.equal(
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === '上一封')
      ?.disabled,
    true,
  );
  await act(async () => {
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click();
  });
  const title = document.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      title,
      'Human title',
    );
    title.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const button = (text: string) =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text)!;
  await act(async () => {
    button('下载本封标注').click();
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.ok(downloaded);
  const annotation = JSON.parse(await (downloaded as unknown as Blob).text());
  assert.equal(annotation.schema_version, 1);
  assert.equal(annotation.email_review.skip, true);
  assert.equal(annotation.added_units[1].corrections.title, 'Human title');
  assert.equal(annotation.gmail_message_id, 'sample');
  assert.match(document.body.textContent ?? '', /已下载标注文件/);
  await act(async () => button('新增遗漏内容').click());
  assert.equal(document.querySelectorAll('nav[aria-label="内容模块"] button').length, 3);
  dom.window.confirm = () => false;
  await act(async () => button('下一封').click());
  assert.equal(
    (document.querySelector('select[aria-label="Newsletter 邮件"]') as HTMLSelectElement).value,
    'sample',
  );
  dom.window.confirm = () => true;
  await act(async () => {
    button('下一封').click();
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(
    (document.querySelector('select[aria-label="Newsletter 邮件"]') as HTMLSelectElement).value,
    'sample2',
  );
  assert.equal(button('下一封').disabled, true);
  assert.equal(
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
    false,
  );
  await act(async () => {
    button('上一封').click();
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(
    (document.querySelector('select[aria-label="Newsletter 邮件"]') as HTMLSelectElement).value,
    'sample',
  );

  const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, 'files', {
    configurable: true,
    value: [new File([JSON.stringify(annotation)], 'sample.json', { type: 'application/json' })],
  });
  await act(async () => {
    fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
  });
  assert.equal(
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked,
    true,
    'Imported Skip flag is restored',
  );
  const preview = new JSDOM('<p data-review-node="n1">First</p><p data-review-node="n2">Last</p>');
  assert.equal(highlightNewsletterUnit(preview.window.document, units[0]), true);
  assert.equal(preview.window.document.querySelectorAll('[data-review-range]').length, 2);
  assert.equal(
    highlightNewsletterUnit(preview.window.document, {
      ...units[0],
      boundary: { start_node_id: 'missing', end_node_id: 'n2' },
    }),
    false,
  );
  preview.window.close();
  assert.ok(calls.length >= 2);
  console.log(
    'PASS actual React Newsletter review dual-pane UI, relative protected API, unit selection, original-node range highlight, missing boundary fallback, sandbox, editable modules, annotation download and manual additions.',
  );
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
