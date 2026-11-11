import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import type { EventReviewData } from '../src/lib/review.js';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url,context,nextLoad){if(url.endsWith('.module.css'))return {format:'module',source:'export default new Proxy({}, {get:(_,k)=>k});',shortCircuit:true};return nextLoad(url,context);}`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/review/events' });
let reloads = 0;
const window = new Proxy(dom.window, {
  get(target, key) {
    if (key === 'location')
      return {
        ...target.location,
        reload: () => {
          reloads++;
        },
      };
    return Reflect.get(target, key);
  },
});
Object.assign(globalThis, {
  window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  FormData: dom.window.FormData,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { EventRankingReview } = await import('../src/app/(admin)/review/ranking-review-client.js');
const { PATCH } = await import('../src/app/api/admin/review/events/ranking/route.js');
assert.equal(
  (
    await PATCH(
      new Request('http://localhost:3000/ai/api/admin/review/events/ranking', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publishId: 'unauthorized' }),
      }),
    )
  ).status,
  401,
  'Publish retains the existing Admin authentication gate',
);
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const data: EventReviewData = {
  dailyDate: '2026-11-11',
  reviewRunId: uid(100),
  cutoff: 15,
  items: Array.from({ length: 16 }, (_, i) => ({
    id: uid(i + 1),
    eventTempId: `E${i + 1}`,
    eventHint: `Hint ${i + 1}`,
    aiRank: i + 1,
    displayRank: i + 1,
    candidates: [
      {
        id: uid(i + 1000),
        eventId: null,
        source: 'Source',
        title: `Evidence ${i + 1}`,
        titleZh: null,
        summaryZh: 'Source summary',
        tags: [],
        entities: [],
        entitiesZh: [],
        url: null,
      },
    ],
    finalEvent:
      i === 1 || i === 15
        ? null
        : {
            id: uid(i + 2000),
            publicationStatus: 'published',
            titleZh: `Published ${i + 1}`,
            summaryZh: 'Saved',
            tags: [],
            tagsZh: [],
            entities: [],
            entitiesZh: [],
          },
  })),
};
const root = createRoot(document.getElementById('root')!);
const buttons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => b.textContent === 'Publish',
  );
let key = 0;
const render = async (next = data) =>
  act(async () => {
    root.render(createElement(EventRankingReview, { data: next, key: ++key }));
  });
const requests: unknown[] = [];
let finish: ((value: Response) => void) | undefined;
globalThis.fetch = async (_url, init) => {
  assert.equal(_url, '../api/admin/review/events/ranking');
  assert.equal(init?.method, 'PATCH');
  requests.push(JSON.parse(String(init?.body)));
  return new Promise<Response>((resolve) => {
    finish = resolve;
  });
};
await render();
assert.equal(buttons().length, 1, 'Only skipped Top-15 Events have Publish');
assert.match(buttons()[0]!.closest('article')!.textContent!, /Evidence 2/);
await act(async () => {
  buttons()[0]!.click();
  buttons()[0]!.click();
});
assert.equal(requests.length, 1, 'Double clicks cannot submit twice');
assert.ok(buttons()[0]!.disabled);
assert.deepEqual(requests[0], {
  date: data.dailyDate,
  reviewRunId: data.reviewRunId,
  publishId: uid(2),
});
await act(async () => {
  finish!(Response.json({ error: 'Stage4 enrichment failed.' }, { status: 502 }));
});
assert.match(document.body.textContent!, /Stage4 enrichment failed/);
assert.ok(!buttons()[0]!.disabled, 'Failure retains the item and allows retry');
await act(async () => {
  buttons()[0]!.click();
});
await act(async () => {
  finish!(Response.json({ status: 'saved' }));
});
assert.equal(reloads, 1, 'Success reloads the current Review/Brief state');
await render();
const firstForm = document.querySelector<HTMLFormElement>('article form')!;
firstForm.querySelector('input')!.value = '3';
await act(async () => {
  firstForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
});
assert.ok(
  buttons().every((button) => button.disabled),
  'Unsaved ranking edits must not be lost by Publish',
);
const completed = structuredClone(data);
completed.items[1]!.finalEvent = {
  ...data.items[0]!.finalEvent!,
  id: uid(2222),
  publicationStatus: 'published',
};
await render(completed);
assert.equal(buttons().length, 0);
const archived = structuredClone(completed);
archived.items[1]!.finalEvent!.publicationStatus = 'archived';
await render(archived);
assert.equal(buttons().length, 1, 'Archived Top-15 Event can be restored');
const beyondCutoff = structuredClone(data);
beyondCutoff.items[15]!.finalEvent = {
  ...data.items[0]!.finalEvent!,
  id: uid(2216),
  titleZh: 'Published 16',
  publicationStatus: 'published',
};
beyondCutoff.items.push({
  ...structuredClone(beyondCutoff.items[15]!),
  id: uid(17),
  eventTempId: 'E17',
  aiRank: 17,
  displayRank: 17,
  finalEvent: { ...beyondCutoff.items[15]!.finalEvent!, id: uid(2217), titleZh: 'Published 17' },
});
await render(beyondCutoff);
for (const title of ['Published 16', 'Published 17']) {
  const heading = [...document.querySelectorAll('h2')].find((node) => node.textContent === title)!;
  assert.ok(heading, 'Published content must display beyond the ranking cutoff');
  const article = heading.closest('article')!;
  assert.ok(article.querySelector('.itemMeta')!.textContent!.includes('Published'));
  assert.equal(article.querySelector('.fallback'), null);
  assert.ok(
    ![...article.querySelectorAll('button')].some((button) => button.textContent === 'Publish'),
  );
}
await act(async () => root.unmount());
dom.window.close();
console.log(
  'Event Publish UI: skipped-only action, association visibility, single PATCH, failure/retry, refresh and unsaved-rank protection passed.',
);
