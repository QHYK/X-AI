'use client';
import { useEffect, useRef, useState } from 'react';
import type { NewsletterListItem, NewsletterParserDetail } from '@/lib/newsletter-parser.js';
import {
  defaultNewsletterReview,
  exportNewsletterAnnotation,
  importNewsletterAnnotation,
  readNewsletterEmailReview,
  type NewsletterReviewUnit,
} from '@/lib/newsletter-review-contracts.js';
import { NewsletterEditor } from './newsletter-editor.js';
import styles from './newsletter-parser.module.css';

/** Locate original-reference nodes only. Email scripts and navigation remain disabled. */
export function highlightNewsletterUnit(
  doc: Document,
  unit: Pick<NewsletterReviewUnit, 'boundary'>,
): boolean {
  const nodes = Array.from(doc.querySelectorAll<HTMLElement>('[data-review-node]'));
  nodes.forEach((n) => {
    n.removeAttribute('data-review-current');
    n.removeAttribute('data-review-range');
  });
  if (!unit.boundary) return false;
  const boundary = unit.boundary;
  const first = nodes.findIndex((n) => n.dataset.reviewNode === boundary.start_node_id),
    last = nodes.findIndex((n) => n.dataset.reviewNode === boundary.end_node_id);
  if (first < 0 || last < first) return false;
  nodes.slice(first, last + 1).forEach((n) => n.setAttribute('data-review-range', ''));
  nodes[first].setAttribute('data-review-current', '');
  nodes[first].scrollIntoView?.({ block: 'center', behavior: 'instant' });
  return true;
}
export function NewsletterParser() {
  const [sources, setSources] = useState<string[]>([]),
    [source, setSource] = useState(''),
    [items, setItems] = useState<NewsletterListItem[]>([]),
    [id, setId] = useState(''),
    [detail, setDetail] = useState<NewsletterParserDetail | null>(null),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [location, setLocation] = useState(''),
    [notice, setNotice] = useState('');
  const [units, setUnits] = useState<NewsletterReviewUnit[]>([]);
  const [status, setStatus] = useState('');
  const [skipEmail, setSkipEmail] = useState(false);
  const [skipNotes, setSkipNotes] = useState('');
  const [saveMessage, setSaveMessage] = useState('');
  const [dirty, setDirty] = useState(false);
  const pick = useRef<'start' | 'end' | null>(null);
  const selectedRef = useRef('');
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(
      `./api/admin/newsletter-parser?source=${encodeURIComponent(source)}&status=${encodeURIComponent(status)}`,
      {
        cache: 'no-store',
        signal: abort.signal,
      },
    )
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (abort.signal.aborted) return;
        setSources(data.sources);
        setItems(data.items);
        setId(data.items[0]?.id ?? '');
        setLoading(data.items.length > 0);
        setNotice('显示数据库中每个来源符合筛选条件的最新 5 封邮件（按接收时间排序）。');
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [source, status]);
  useEffect(() => {
    if (!id) return;
    const abort = new AbortController();
    fetch(`./api/admin/newsletter-parser?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: abort.signal,
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error);
        if (abort.signal.aborted) return;
        setDetail(data);
        setSkipEmail(false);
        setSkipNotes('');
        const loaded = defaultNewsletterReview(data.units);
        setUnits(loaded);

        setSelected(loaded[0]?.id ?? '');
        setDirty(false);
        setSaveMessage('标注仅供下载，不写入数据库或 Raw。');
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [id]);
  function locate(unit: Pick<NewsletterReviewUnit, 'boundary'>) {
    const doc = frame.current?.contentDocument;
    setLocation(
      doc && highlightNewsletterUnit(doc, unit)
        ? '已定位并高亮'
        : '无法定位对应区域；可核对下方原文偏移。',
    );
  }
  useEffect(() => {
    selectedRef.current = selected;
    const unit = units.find((u) => u.id === selected);
    if (unit) locate(unit);
  }, [selected, units]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function change(unit: NewsletterReviewUnit) {
    setUnits((previous) => previous.map((u) => (u.id === unit.id ? unit : u)));
    setDirty(true);
    setSaveMessage('未保存');
  }
  function selectMail(nextId: string) {
    if (!nextId || nextId === id) return;
    if (dirty && !window.confirm('未下载的标注将丢失，确定切换邮件？')) return;
    setDirty(false);
    setId(nextId);
    setDetail(null);
    setError('');
    setLocation('');
    setLoading(true);
    pick.current = null;
  }
  const currentIndex = items.findIndex((item) => item.id === id);
  function save() {
    if (!detail) return;
    try {
      const annotation = exportNewsletterAnnotation(detail, units, {
        skip: skipEmail,
        notes: skipNotes,
      });
      const blob = new Blob([JSON.stringify(annotation, null, 2) + '\n'], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = `${detail.id}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setDirty(false);
      setSaveMessage('已下载标注文件；请自行保存在本机，不会同步到服务器。');
    } catch (error) {
      setSaveMessage(error instanceof Error ? error.message : '导出失败，输入已保留');
    }
  }
  return (
    <>
      <div className={`${styles.toolbar} ${styles.mailNavigation}`}>
        <label>
          来源
          <select
            aria-label="Newsletter 来源"
            value={source}
            onChange={(e) => {
              if (dirty && !window.confirm('未下载的标注将丢失，确定切换邮件？')) return;
              setDirty(false);
              setSource(e.target.value);
              setId('');
              setItems([]);
              setDetail(null);
              setError('');
              setLoading(true);
            }}
          >
            <option value="">全部来源</option>
            {sources.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          邮件
          <select
            aria-label="Newsletter 邮件"
            value={id}
            onChange={(e) => selectMail(e.target.value)}
            disabled={!items.length}
          >
            {!items.length && (
              <option value="">{error ? '读取失败' : loading ? '读取中…' : '暂无邮件'}</option>
            )}
            {items.map((m) => (
              <option
                key={m.id}
                value={m.id}
              >
                {`[${m.status}] ${m.subject ?? m.id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          解析状态
          <select
            aria-label="解析状态"
            value={status}
            onChange={(e) => {
              if (dirty && !window.confirm('未下载的标注将丢失，确定切换？')) return;
              setDirty(false);
              setStatus(e.target.value);
              setDetail(null);
              setId('');
              setError('');
              setLoading(true);
            }}
          >
            <option value="">全部状态</option>
            {['collected', 'success', 'skipped', 'unsupported', 'conflict', 'failed'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loading || currentIndex <= 0}
          onClick={() => selectMail(items[currentIndex - 1]?.id)}
        >
          上一封
        </button>
        <button
          type="button"
          disabled={loading || currentIndex < 0 || currentIndex >= items.length - 1}
          onClick={() => selectMail(items[currentIndex + 1]?.id)}
        >
          下一封
        </button>
        <span>
          {currentIndex >= 0 ? currentIndex + 1 : 0} / {items.length}
        </span>
      </div>
      <p className={styles.muted}>{notice}</p>
      {loading && <p role="status">读取中…</p>}
      {error && <p role="alert">{error}</p>}
      {!loading && !error && !items.length && <p>此来源暂无符合查询的 Newsletter。</p>}
      {detail && (
        <>
          <p>
            {detail.source} · <b>ID:</b><code>{detail.id}</code>
             · {detail.receivedAt ?? '接收时间未知'} · {detail.template ?? '—'} 
             · {detail.units.length}个内容单元 · 采集时间{' '}
            {detail.collectedAt} · 状态{' '}
            <strong
              className={
                ['unsupported', 'conflict', 'failed'].includes(detail.status)
                  ? styles.problem
                  : undefined
              }
            >
              {detail.status}
            </strong>
            {detail.status === 'success' && (
              <span> · 已写入 Raw {detail.importedCount} 个模块</span>
            )}
            {detail.error && !detail.error.startsWith('parse:') && (
              <span role="alert"> · {detail.error}</span>
            )}
            {detail.previewError && <span role="alert"> · 当前预览：{detail.previewError}</span>}
            {detail.differsFromImported && (
              <span role="alert"> · 当前 Parser 结果与已入库结果不一致；预览不会修改 Raw。</span>
            )}
            <span>
              {' '}
              · Parser 已记录 {detail.storedParserVersion ?? '—'} / 当前{' '}
              {detail.currentParserVersion}
            </span>
          </p>
          <div className={styles.emailReview}>
            <label>
              <input
                type="checkbox"
                checked={skipEmail}
                onChange={(e) => {
                  setSkipEmail(e.target.checked);
                  setDirty(true);
                  setSaveMessage('标注未下载');
                }}
              />
              整封邮件建议跳过（Skip，仅标注）
            </label>
            {skipEmail && (
              <label>
                跳过原因
                <input
                  type="text"
                  maxLength={5000}
                  value={skipNotes}
                  onChange={(e) => {
                    setSkipNotes(e.target.value);
                    setDirty(true);
                    setSaveMessage('标注未下载');
                  }}
                />
              </label>
            )}
            <span className={styles.muted}>随标注 JSON 下载，不改变数据库状态或已入库内容。</span>
          </div>
          <div className={styles.columns}>
            <section className={styles.preview}>
              <div className={styles.previewHeader}>
                <strong>Newsletter HTML</strong>
                <span role="status">{location}</span>
              </div>
              <iframe
                ref={frame}
                title="隔离的 Newsletter 预览"
                sandbox="allow-same-origin"
                referrerPolicy="no-referrer"
                srcDoc={detail.html}
                onLoad={() => {
                  const u = units.find((u) => u.id === selected);
                  if (u) locate(u);
                  const doc = frame.current?.contentDocument;
                  doc?.addEventListener('click', (event) => {
                    if (!pick.current) return;
                    const node = (event.target as Element)?.closest<HTMLElement>(
                      '[data-review-node]',
                    )?.dataset.reviewNode;
                    if (!node || !detail.blocks.some((b) => b.node_id === node)) return;
                    const end = pick.current;
                    pick.current = null;
                    setUnits((previous) =>
                      previous.map((unit) =>
                        unit.id !== selectedRef.current
                          ? unit
                          : {
                              ...unit,
                              boundary: {
                                start_node_id: unit.boundary?.start_node_id ?? node,
                                end_node_id: unit.boundary?.end_node_id ?? node,
                                [`${end}_node_id`]: node,
                              },
                            },
                      ),
                    );
                    setDirty(true);
                    setSaveMessage('未保存');
                    setLocation('已选择内容边界');
                  });
                }}
              />
            </section>
            <NewsletterEditor
              detail={detail}
              units={units}
              selected={selected}
              saveMessage={saveMessage}
              onSelect={(unit) => {
                setSelected(unit.id);
                locate(unit);
              }}
              onChange={change}
              onExport={save}
              onImport={async (file) => {
                try {
                  if (file.size > 5 * 1024 * 1024) throw new Error('标注文件超过 5 MiB');
                  const value = JSON.parse(await file.text());
                  const loaded = importNewsletterAnnotation(detail, value);
                  const emailReview = readNewsletterEmailReview(value);
                  exportNewsletterAnnotation(detail, loaded, emailReview);
                  setSkipEmail(emailReview.skip);
                  setSkipNotes(emailReview.notes);
                  setUnits(loaded);
                  setSelected(loaded[0]?.id ?? '');
                  setDirty(false);
                  setSaveMessage('已载入本机标注；未修改数据库。');
                } catch (error) {
                  setSaveMessage(error instanceof Error ? error.message : '导入失败');
                }
              }}
              onAdd={() => {
                const unit: NewsletterReviewUnit = {
                  id: crypto.randomUUID(),
                  status: 'unreviewed',
                  content_type: null,
                  corrections: { title: null, summary: null, original_url: null },
                  boundary: null,
                  text_evidence: '',
                  notes: '',
                };
                setUnits((previous) => [...previous, unit]);
                setSelected(unit.id);
                setDirty(true);
                setSaveMessage('未保存');
              }}
              onPick={(end) => {
                pick.current = end;
                setLocation(`请点击邮件中的${end === 'start' ? '起始' : '结束'}块`);
              }}
            />
          </div>
        </>
      )}
    </>
  );
}
