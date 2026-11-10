import type { EditableUnit, ReviewDetail, ReviewMessage } from './review-data.js';

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const token = (document.querySelector('meta[name="review-token"]') as HTMLMetaElement).content;
const sourceSelect = byId<HTMLSelectElement>('source');
const messageSelect = byId<HTMLSelectElement>('message');
const frame = byId<HTMLIFrameElement>('preview');
let messages: ReviewMessage[] = [];
let detail: ReviewDetail | null = null;
let added: EditableUnit[] = [];
let selected = 0;
let dirty = false;
let busy = false;
let picking: 'start' | 'end' | null = null;
let loading = false;
const statusText = {
  unreviewed: '未审核',
  accepted: '接受',
  rejected: '拒绝',
  uncertain: '不确定',
};
const types = ['external_reference', 'standalone_content', 'non_content'] as const;
const allUnits = () => added;
const current = () => allUnits()[selected];
const title = (u: EditableUnit) =>
  u.corrections.title !== undefined ? u.corrections.title || '[标题已清空]' : '[无可靠标题]';

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  value?: string,
  className?: string,
) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: {
      'X-Review-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    credentials: 'omit',
  });
  const value = await response.json();
  if (response.status === 403)
    throw new Error('本地页面访问校验失败，服务可能已重启。请先保留当前未保存内容，再刷新页面。');
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}
function setStatus(value: string) {
  byId('save-status').textContent = value;
}
function changed() {
  dirty = true;
  setStatus('未保存');
  renderList();
  renderProgress();
}
function renderProgress() {
  const remaining = added.filter((u) => u.status === 'unreviewed').length;
  byId('progress').textContent =
    `内容单元 ${added.length} · 已审核 ${added.length - remaining} · 未审核 ${remaining}`;
}
function filteredMessages() {
  const counts = new Map<string, number>();
  return messages
    .filter((m) => !sourceSelect.value || m.source === sourceSelect.value)
    .filter((m) => {
      const n = (counts.get(m.source) ?? 0) + 1;
      counts.set(m.source, n);
      return byId<HTMLInputElement>('all-history').checked || n <= 5;
    });
}
function renderMessageOptions(id?: string) {
  messageSelect.replaceChildren();
  for (const m of filteredMessages()) {
    const option = element('option', m.subject || m.gmail_message_id);
    option.value = m.gmail_message_id;
    messageSelect.append(option);
  }
  if (id && filteredMessages().some((m) => m.gmail_message_id === id)) messageSelect.value = id;
}
function plainUnit(unit: EditableUnit): EditableUnit {
  return {
    manual_id: unit.manual_id,
    status: unit.status,
    content_type: unit.content_type,
    corrections: { ...unit.corrections },
    boundary: unit.boundary ? { ...unit.boundary } : null,
    text_evidence: unit.text_evidence,
    notes: unit.notes,
  };
}
async function load(id: string, discardConfirmed = false) {
  if (loading || busy) return;
  if (dirty && !discardConfirmed && !window.confirm('当前有未保存修改，放弃这些修改并切换邮件？')) {
    if (detail) messageSelect.value = detail.gmail_message_id;
    return;
  }
  loading = true;
  messageSelect.disabled = true;
  sourceSelect.disabled = true;
  setStatus('读取中…');
  try {
    const value = await api<ReviewDetail>(`/api/messages/${encodeURIComponent(id)}`);
    detail = value;
    const prior = new Map(value.annotations?.added_units.map((u) => [u.manual_id, u]) ?? []);
    const proposals = new Set(value.guidance.units.map((p) => p.id));
    added = value.guidance.units.map((p) =>
      prior.has(p.id)
        ? plainUnit(prior.get(p.id)!)
        : {
            manual_id: p.id,
            status: 'unreviewed',
            content_type: p.content_type,
            corrections: {
              title: p.title,
              ...(p.primary_url ? { original_url: p.primary_url } : {}),
            },
            boundary: { ...p.boundary },
            text_evidence: '',
            notes: p.notes,
          },
    );
    // Explicit human additions remain editable; obsolete automatic splits are not loaded.
    added.push(
      ...(value.annotations?.added_units ?? [])
        .filter((u) => !u.source_guidance && !proposals.has(u.manual_id!))
        .map(plainUnit),
    );
    dirty = false;
    selected = 0;
    picking = null;
    byId('metadata').textContent =
      `${value.source} · ${value.guidance.template} · ${value.subject} · ${value.received_at ? new Date(value.received_at).toLocaleString() : '接收时间未知'} · ${value.gmail_message_id}`;
    byId('notice').textContent = value.baseline_matches
      ? `已默认载入来源预选 v${value.guidance.version}。旧标注保留作对照，未自动改写。${value.guidance.warnings.join('；')}`
      : '邮件原文或内容边界已变化，当前仅可查看；请先核对已保存标注。';
    frame.srcdoc = value.preview.html;
    render();
    setStatus(
      value.annotations
        ? `已加载保存记录 · ${new Date(value.annotations.updated_at).toLocaleString()}`
        : '尚未保存',
    );
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '读取失败');
    if (detail) messageSelect.value = detail.gmail_message_id;
  } finally {
    loading = false;
    sourceSelect.disabled = false;
    messageSelect.disabled = false;
    renderButtons();
  }
}
function renderButtons() {
  byId<HTMLInputElement>('all-history').disabled = busy || loading;
  sourceSelect.disabled = busy || loading;
  messageSelect.disabled = busy || loading;
  for (const id of ['previous', 'next']) byId<HTMLButtonElement>(id).disabled = busy || loading;
  byId<HTMLButtonElement>('save').disabled = busy || loading || !detail || !detail.baseline_matches;
  byId<HTMLButtonElement>('add').disabled = busy || loading || !detail || !detail.baseline_matches;
  byId<HTMLButtonElement>('load-guidance').disabled =
    busy || loading || !detail || !detail.baseline_matches || !detail.guidance.units.length;
  for (const id of ['pick-start', 'pick-end'])
    byId<HTMLButtonElement>(id).disabled = busy || !current() || !detail?.baseline_matches;
  byId<HTMLButtonElement>('locate').disabled = !current();
}
function renderList() {
  const list = byId('units');
  list.replaceChildren();
  allUnits().forEach((u, index) => {
    const button = element(
      'button',
      `${detail?.guidance.units.some((p) => p.id === u.manual_id) ? '' : '＋ '}${statusText[u.status]} · ${title(u)}`,
      selected === index ? 'unit selected' : 'unit',
    );
    button.type = 'button';
    button.onclick = () => {
      selected = index;
      picking = null;
      render();
      byId<HTMLButtonElement>('locate').click();
    };
    list.append(button);
  });
}
function field(label: string, node: HTMLElement) {
  const wrapper = element('label', label, 'field');
  wrapper.append(node);
  return wrapper;
}
function renderEditor() {
  const editor = byId('editor');
  editor.replaceChildren();
  const u = current();
  if (!u) {
    editor.append(element('p', '当前邮件没有来源预选内容，可在左侧选择边界并新增遗漏内容。'));
    return;
  }
  editor.append(
    element(
      'h2',
      detail!.guidance.units.some((p) => p.id === u.manual_id) ? '来源预选内容' : '人工补充内容',
    ),
    element('p', u.manual_id!, 'identifier'),
  );
  const form = element('fieldset');
  form.disabled = busy || !detail!.baseline_matches;
  const status = element('select');
  for (const key of Object.keys(statusText) as (keyof typeof statusText)[]) {
    const option = element('option', `${key} · ${statusText[key]}`);
    option.value = key;
    status.append(option);
  }
  status.value = u.status;
  status.onchange = () => {
    u.status = status.value as EditableUnit['status'];
    changed();
  };
  const type = element('select');
  type.append(element('option', '请选择内容类型'));
  type.options[0].value = '';
  for (const key of types) {
    const option = element('option', key);
    option.value = key;
    type.append(option);
  }
  type.value = u.content_type ?? '';
  type.onchange = () => {
    u.content_type = (type.value || null) as EditableUnit['content_type'];
    changed();
  };
  form.append(field('审核状态', status), field('内容类型', type));
  for (const [key, label] of [
    ['title', '人工 Title'],
    ['summary', '人工 Summary'],
    ['original_url', '人工 Original URL'],
  ] as const) {
    const input = element(key === 'original_url' ? 'input' : 'textarea');
    if (input instanceof HTMLTextAreaElement) input.rows = key === 'summary' ? 4 : 2;
    input.value = u.corrections[key] ?? '';
    input.oninput = () => {
      u.corrections[key] = input.value || null;
      changed();
    };
    form.append(field(label, input));
  }
  const chooseLink = element('select');
  const emptyLink = element('option', '选择当前区域内的链接（不打开网页）');
  emptyLink.value = '';
  chooseLink.append(emptyLink);
  const startRef = detail!.preview.blocks.find((b) => b.node_id === u.boundary?.start_node_id);
  const endRef = detail!.preview.blocks.find((b) => b.node_id === u.boundary?.end_node_id);
  const availableLinks = detail!.guidance.links.filter(
    (l) =>
      startRef?.start_offset != null &&
      endRef?.end_offset != null &&
      l.start_offset < endRef.end_offset &&
      l.end_offset > startRef.start_offset,
  );
  const seenLinks = new Set<string>();
  for (const l of availableLinks) {
    const url = l.target_url ?? l.original_url;
    if (seenLinks.has(url)) continue;
    seenLinks.add(url);
    const option = element(
      'option',
      `${l.anchor_text || '[图片或无锚文本]'} — ${new URL(url).hostname}${l.target_url ? '' : '（追踪目标未知）'}`,
    );
    option.value = url;
    chooseLink.append(option);
  }
  chooseLink.value = u.corrections.original_url ?? '';
  chooseLink.disabled = busy || !availableLinks.length;
  chooseLink.onchange = () => {
    if (!chooseLink.value) return;
    u.corrections.original_url = chooseLink.value;
    changed();
    renderEditor();
  };
  form.append(field(`区域内链接（${seenLinks.size}）`, chooseLink));
  form.append(
    element(
      'p',
      availableLinks.length
        ? '选择后写入 Original URL；追踪链接未解析时保留原地址，不推测目标。'
        : '此边界内没有可用链接；可调整边界，或手动填写原文中确认的 URL。',
    ),
  );
  const boundaryBox = element('div', undefined, 'boundary');
  boundaryBox.append(element('strong', '内容边界（按原始 DOM 顺序，含起止块）'));
  for (const end of ['start', 'end'] as const) {
    const select = element('select');
    select.append(element('option', '未选择'));
    select.options[0].value = '';
    for (const block of detail!.preview.blocks) {
      const option = element(
        'option',
        `${block.node_id} <${block.tag}> ${block.excerpt.slice(0, 85)}`,
      );
      option.value = block.node_id;
      select.append(option);
    }
    select.value = u.boundary?.[`${end}_node_id`] ?? '';
    select.onchange = () => {
      if (!select.value) u.boundary = null;
      else
        u.boundary = {
          start_node_id: u.boundary?.start_node_id ?? select.value,
          end_node_id: u.boundary?.end_node_id ?? select.value,
          [`${end}_node_id`]: select.value,
        };
      changed();
      renderEditor();
      highlight(false);
    };
    boundaryBox.append(field(end === 'start' ? '起始块' : '结束块', select));
  }
  const clear = element('button', '清除边界');
  clear.type = 'button';
  clear.onclick = () => {
    u.boundary = null;
    changed();
    renderEditor();
    highlight(false);
  };
  boundaryBox.append(clear);
  boundaryBox.append(
    element(
      'p',
      '来源预选边界仅供参考，需人工确认。可用上方按钮后点击左侧内容，或使用块下拉框。块引用包含原始 HTML Hash、字符偏移和文本 Hash；不能选择任意字符或拖拽区域。',
    ),
  );
  form.append(boundaryBox);
  for (const [key, label] of [
    ['text_evidence', '原文证据（可选；无边界的新增内容必填）'],
    ['notes', '备注'],
  ] as const) {
    const input = element('textarea');
    input.rows = 3;
    input.value = u[key];
    input.oninput = () => {
      u[key] = input.value;
      changed();
    };
    form.append(field(label, input));
  }
  if (u.manual_id) {
    const remove = element('button', '移除此人工新增单元');
    remove.type = 'button';
    remove.onclick = () => {
      if (window.confirm('移除该人工新增单元？保存后生效。')) {
        added = added.filter((a) => a.manual_id !== u.manual_id);
        selected = Math.max(0, selected - 1);
        changed();
        render();
      }
    };
    form.append(remove);
  }
  editor.append(form);
  const proposal = detail!.guidance.units.find((p) => p.id === u.manual_id);
  if (proposal) {
    const evidence = element('details');
    evidence.open = true;
    evidence.append(element('summary', `来源预选 · ${proposal.review_label}`));
    evidence.append(element('p', proposal.notes), element('pre', proposal.content_text));
    for (const link of proposal.urls)
      evidence.append(
        element(
          'pre',
          `${link.anchor_text || '[无锚文本]'}\n原始：${link.original_url}\n目标线索：${link.target_url ?? '未知'} (${link.target_evidence})`,
        ),
      );
    editor.append(evidence);
  }
}
function render() {
  renderList();
  renderEditor();
  renderProgress();
  renderButtons();
  highlight(false);
}
function highlight(scroll: boolean) {
  const doc = frame.contentDocument;
  if (!doc || !detail) return;
  doc.querySelectorAll('[data-review-current],[data-review-range]').forEach((e) => {
    e.removeAttribute('data-review-current');
    e.removeAttribute('data-review-range');
  });
  const u = current();
  if (!u) return;
  const nodeId = u.boundary?.start_node_id;
  const blocks = detail.preview.blocks;
  if (u.boundary) {
    const start = blocks.findIndex((b) => b.node_id === u.boundary!.start_node_id);
    const end = blocks.findIndex((b) => b.node_id === u.boundary!.end_node_id);
    if (start >= 0 && end >= start)
      for (const b of blocks.slice(start, end + 1))
        doc
          .querySelector(`[data-review-node="${b.node_id}"]`)
          ?.setAttribute('data-review-range', '');
  }
  const target = nodeId ? doc.querySelector(`[data-review-node="${nodeId}"]`) : null;
  if (target) {
    target.setAttribute('data-review-current', '');
    if (scroll) target.scrollIntoView({ block: 'center' });
  }
  byId('location-status').textContent = picking
    ? `请点击左侧${picking === 'start' ? '起始' : '结束'}内容块`
    : target
      ? `已定位 ${nodeId}`
      : '尚未选择内容边界';
}
frame.onload = () => {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!picking || !current() || busy || !detail?.baseline_matches) return;
    const node = (event.target as Element).closest?.('[data-review-node]');
    const id = node?.getAttribute('data-review-node');
    if (!id) return;
    const u = current()!;
    u.boundary = {
      start_node_id: u.boundary?.start_node_id ?? id,
      end_node_id: u.boundary?.end_node_id ?? id,
      [`${picking}_node_id`]: id,
    };
    picking = null;
    changed();
    renderEditor();
    highlight(false);
  });
  doc.addEventListener('submit', (e) => e.preventDefault());
  highlight(false);
};
byId('all-history').onchange = () => {
  if (dirty && !window.confirm('当前有未保存修改，放弃并切换邮件范围？')) {
    byId<HTMLInputElement>('all-history').checked = !byId<HTMLInputElement>('all-history').checked;
    return;
  }
  renderMessageOptions(detail?.gmail_message_id);
  if (messageSelect.value && messageSelect.value !== detail?.gmail_message_id)
    void load(messageSelect.value, true);
};
byId('load-guidance').onclick = () => {
  if (!detail || !detail.baseline_matches) return;
  let count = 0;
  for (const proposal of detail.guidance.units) {
    if (added.some((u) => u.manual_id === proposal.id)) continue;
    const url = proposal.title ? proposal.urls.find((l) => l.anchor_text === proposal.title) : null;
    added.push({
      manual_id: proposal.id,
      status: 'uncertain',
      content_type: proposal.content_type,
      corrections: {
        title: proposal.title ?? '',
        ...(proposal.primary_url
          ? { original_url: proposal.primary_url }
          : url
            ? { original_url: url.target_url ?? url.original_url }
            : {}),
      },
      boundary: { ...proposal.boundary },
      text_evidence: '',
      notes: `[来源预选:v${detail.guidance.version}:${proposal.review_label}] ${proposal.notes}\n待人工确认；不属于已审核 Ground Truth。`,
    });
    count++;
  }
  if (added.length) selected = 0;
  if (count) changed();
  render();
  setStatus(
    count
      ? `已载入 ${count} 条来源预选，尚未保存；未确定的标题或类型可暂存，接受前需补齐。`
      : '来源预选已存在，未重复添加。',
  );
};
byId('locate').onclick = () => highlight(true);
for (const which of ['start', 'end'] as const)
  byId(`pick-${which}`).onclick = () => {
    picking = which;
    highlight(false);
  };
byId('add').onclick = () => {
  added.push({
    manual_id: crypto.randomUUID(),
    status: 'accepted',
    content_type: null,
    corrections: { title: '' },
    boundary: null,
    text_evidence: '',
    notes: '',
  });
  selected = added.length - 1;
  picking = null;
  changed();
  render();
};
byId('save').onclick = async () => {
  if (!detail || busy) return;
  busy = true;
  renderButtons();
  renderEditor();
  setStatus('保存中…');
  try {
    const saved = await api<{ value: ReviewDetail['annotations']; revision: string }>(
      `/api/annotations/${detail.gmail_message_id}`,
      {
        revision: detail.revision,
        baseline: detail.baseline,
        added_units: added,
      },
    );
    detail.annotations = saved.value;
    detail.revision = saved.revision;
    dirty = false;
    setStatus('已保存');
    byId('notice').textContent =
      `已默认载入来源预选 v${detail.guidance.version}。${detail.guidance.warnings.join('；')}`;
  } catch (e) {
    const message = e instanceof Error ? e.message : '保存失败；输入已保留';
    setStatus(message);
    byId('notice').textContent = `保存失败，当前输入已保留：${message}`;
  } finally {
    busy = false;
    renderButtons();
    renderEditor();
  }
};
sourceSelect.onchange = () => {
  const priorSource = detail?.source;
  if (dirty && !window.confirm('当前有未保存修改，放弃并切换来源？')) {
    sourceSelect.value = priorSource ?? '';
    return;
  }
  renderMessageOptions();
  if (messageSelect.value) void load(messageSelect.value, true);
};
messageSelect.onchange = () => void load(messageSelect.value);
for (const [id, step] of [
  ['previous', -1],
  ['next', 1],
] as const)
  byId(id).onclick = () => {
    if (loading || busy) return;
    const filtered = filteredMessages(),
      index = filtered.findIndex((m) => m.gmail_message_id === detail?.gmail_message_id),
      next = filtered[index + step];
    if (next) {
      messageSelect.value = next.gmail_message_id;
      void load(next.gmail_message_id);
    }
  };
window.addEventListener('beforeunload', (event) => {
  if (dirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function start() {
  try {
    messages = await api<ReviewMessage[]>('/api/messages');
    const all = element('option', '全部来源');
    all.value = '';
    sourceSelect.append(all);
    for (const source of [...new Set(messages.map((m) => m.source))]) {
      const option = element('option', source);
      option.value = source;
      sourceSelect.append(option);
    }
    renderMessageOptions();
    if (messageSelect.value) await load(messageSelect.value);
    else setStatus('没有本地邮件样本');
  } catch (e) {
    setStatus(e instanceof Error ? e.message : '加载失败');
  }
}
void start();
