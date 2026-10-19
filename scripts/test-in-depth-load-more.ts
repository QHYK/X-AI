import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const web = new URL('../../Xfield/apps/web/', import.meta.url);
const require = createRequire(new URL('package.json', web));
const React = require('react') as typeof import('react');
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './work-card')
      return {
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            `import React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)}; export const WorkCard = ({work}) => React.createElement('article', null, work.id);`,
          ),
        shortCircuit: true,
      };
    if (specifier.endsWith('.module.css'))
      return { url: 'data:text/javascript,export default {}', shortCircuit: true };
    if (specifier.startsWith('@/lib/'))
      return next(new URL(specifier.slice(2) + '.ts', web).href, context);
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('data:text/javascript,'))
      return {
        format: 'module',
        source: decodeURIComponent(url.slice('data:text/javascript,'.length)),
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/in-depth' });
Object.assign(globalThis, {
  React,
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { InDepthList } = await import(new URL('app/in-depth/in-depth-list.tsx', web).href);
const work = (id: string) => ({ id, agent: {}, editorial: {}, tags: [] });
let calls = 0;
let respond!: (response: Response) => void;
globalThis.fetch = async (url) => {
  calls++;
  assert.equal(String(url), './ai/api/in-depth?cursor=next');
  return new Promise<Response>((resolve) => {
    respond = resolve;
  });
};
const root = createRoot(document.getElementById('root')!);
await React.act(async () =>
  root.render(
    React.createElement(InDepthList, {
      initial: { items: [work('first')], hasMore: true, nextCursor: 'next' },
    }),
  ),
);
const button = () => document.querySelector('button')!;
await React.act(async () => {
  button().click();
  button().click();
});
assert.equal(calls, 1);
assert.equal(button().disabled, true);
await React.act(async () => respond(Response.json({ error: 'mock' }, { status: 500 })));
assert.match(document.body.textContent!, /加载失败/);
assert.equal(document.querySelectorAll('article').length, 1);
await React.act(async () => button().click());
await React.act(async () =>
  respond(
    Response.json({
      items: [work('first'), work('second'), work('second')],
      hasMore: false,
      nextCursor: null,
    }),
  ),
);
assert.equal(document.querySelectorAll('article').length, 2);
assert.deepEqual(
  Array.from(document.querySelectorAll('article'), (article) => article.textContent),
  ['first', 'second'],
  'Load more appends older works after the existing latest works without reversing either batch.',
);
assert.equal(document.querySelector('button'), null);
assert.match(document.body.textContent!, /已显示全部/);
await React.act(async () => root.unmount());
dom.window.close();
console.log(
  'X-field Load more DOM: relative URL, loading, duplicate submit, retry after error, append/dedup and last page passed.',
);
