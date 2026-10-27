import assert from 'node:assert/strict';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';

register(
  `data:text/javascript,${encodeURIComponent(`export async function load(url, context, nextLoad) { if (url.endsWith('.module.css')) return { format:'module',source:'export default new Proxy({}, {get:(_,key)=>key});',shortCircuit:true }; return nextLoad(url,context); }`)}`,
  import.meta.url,
);
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost:3000/ai/review/in-depth' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { IntroductionEditor } =
  await import('../src/app/(admin)/review/in-depth/introduction-editor.js');
const root = createRoot(document.getElementById('root')!);
let confirmations = 0;
let confirm = true;
dom.window.confirm = () => {
  confirmations++;
  return confirm;
};
const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
let resolveResponse: ((response: Response) => void) | null = null;
globalThis.fetch = async (_url, options) => {
  requests.push({ method: String(options?.method), body: JSON.parse(String(options?.body)) });
  return new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
};
const introduction = {
  extra_info: '基于论证细节的原创性与证据评估',
  summary: '## 讲了什么\n生成的中文介绍',
  whyWorthReading: '独特阅读价值',
};
const button = (text: string) =>
  Array.from(document.querySelectorAll('button')).find((button) => button.textContent === text)!;
const textarea = (label: string) =>
  document.querySelector(`textarea[aria-label="${label}"]`) as HTMLTextAreaElement;
async function edit(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea(label),
      value,
    );
    textarea(label).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}
async function click(text: string) {
  await act(async () => {
    button(text).click();
  });
}
async function respond(payload: unknown, status = 200) {
  await act(async () => {
    resolveResponse!(Response.json(payload, { status }));
  });
}
async function render(overrides: Record<string, unknown> | null = null, id = 'candidate') {
  await act(async () => {
    root.render(
      createElement(IntroductionEditor, {
        key: id,
        id,
        overrides,
        apiUrl: () => '/ai/api/admin/review/in-depth',
      }),
    );
  });
}
try {
  await render();
  assert.equal(textarea('讲了什么').value, '');
  await act(async () => {
    const generate = button('Generate');
    generate.click();
    generate.click();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(requests[0]?.body, { id: 'candidate' });
  assert.equal(button('Generating…').disabled, true);
  await respond({ introduction, saved: true });
  assert.equal(textarea('讲了什么').value, introduction.summary);
  assert.equal(button('Save changes').disabled, true);
  assert.equal(textarea('其他具体评估').value, introduction.extra_info);
  await edit('其他具体评估', '人工评估');
  assert.equal(textarea('其他具体评估').value, '人工评估');
  confirm = false;
  await click('Regenerate');
  assert.equal(confirmations, 1);
  assert.equal(requests.length, 1, 'Declined overwrite must not call the model.');
  confirm = true;
  await click('Regenerate');
  assert.equal(confirmations, 2);
  await edit('其他具体评估', '请求之后刚输入的评估');
  await edit('讲了什么', '请求之后刚输入的内容');
  await respond({ introduction, saved: true });
  assert.equal(textarea('讲了什么').value, '请求之后刚输入的内容');
  assert.equal(textarea('本次生成：讲了什么').value, introduction.summary);
  assert.equal(textarea('其他具体评估').value, '请求之后刚输入的评估');
  assert.equal(textarea('本次生成：其他具体评估').value, introduction.extra_info);
  await click('Save changes');
  assert.equal(requests.at(-1)?.method, 'PATCH');
  assert.equal(requests.at(-1)?.body.action, 'editorial');
  assert.equal(requests.at(-1)?.body.extra_info, '请求之后刚输入的评估');
  assert.equal(requests.at(-1)?.body.summary, '请求之后刚输入的内容');
  assert.equal('reviewStatus' in requests.at(-1)!.body, false);
  assert.equal('editorialNotes' in requests.at(-1)!.body, false);
  await edit('讲了什么', '保存期间继续输入');
  await edit('其他具体评估', '保存期间继续修改评估');
  await respond({ item: { editorialOverrides: requests.at(-1)?.body } });
  assert.equal(textarea('讲了什么').value, '保存期间继续输入');
  assert.equal(textarea('其他具体评估').value, '保存期间继续修改评估');
  assert.equal(button('Save changes').disabled, false);
  await render(null, 'second');
  await click('Generate');
  await respond({ introduction, saved: false, error: 'DB save failed. Text retained.' }, 503);
  assert.equal(textarea('讲了什么').value, introduction.summary);
  assert.equal(textarea('其他具体评估').value, introduction.extra_info);
  assert.equal(button('Save changes').disabled, false);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /DB save failed/);
  await click('Save changes');
  await respond({ item: { editorialOverrides: introduction } });
  assert.equal(button('Save changes').disabled, true);
  await click('Regenerate');
  await respond({ error: 'Model failed.' }, 502);
  assert.equal(textarea('讲了什么').value, introduction.summary);
  await click('Regenerate');
  await render(null, 'third');
  await respond({ introduction, saved: true });
  assert.equal(
    textarea('讲了什么').value,
    '',
    'A different Candidate must not receive a stale response.',
  );
  await render(null, 'conflict');
  await click('Generate');
  const currentEditorial = {
    summary: '其他编辑保存的内容',
    whyWorthReading: '最新理由',
    extra_info: '最新评估',
  };
  await respond({ error: 'Editorial conflict', saved: false, introduction, currentEditorial }, 409);
  assert.equal(textarea('讲了什么').value, '', 'Conflict never replaces local input.');
  assert.equal(textarea('本次生成：讲了什么').value, introduction.summary);
  assert.equal(textarea('最新保存：讲了什么').value, currentEditorial.summary);
  await click('使用生成文本');
  assert.equal(textarea('讲了什么').value, introduction.summary);
  assert.equal(
    button('Save changes').disabled,
    true,
    'Conflict requires explicit baseline acknowledgement.',
  );
  confirm = false;
  await click('确认最新内容，继续编辑');
  assert.equal(button('Save changes').disabled, true);
  confirm = true;
  await click('确认最新内容，继续编辑');
  await click('Save changes');
  assert.deepEqual(requests.at(-1)?.body.baseline, currentEditorial);
  await respond(
    { error: 'Another newer Save', currentEditorial: { ...currentEditorial, summary: '再次更新' } },
    409,
  );
  assert.equal(
    textarea('讲了什么').value,
    introduction.summary,
    'Manual 409 also preserves all unsaved text.',
  );
  console.log(
    'Editorial UI: generation, manual save, confirmation, duplicate guard, async edits, DB failure recovery and Candidate switching passed.',
  );
} finally {
  await act(async () => root.unmount());
  dom.window.close();
}
