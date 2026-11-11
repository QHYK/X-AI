'use client';
import { useMemo } from 'react';
import type { NewsletterParserDetail } from '@/lib/newsletter-parser.js';
import {
  REVIEW_STATUS_LABELS,
  type NewsletterReviewUnit,
} from '@/lib/newsletter-review-contracts.js';
import styles from './newsletter-parser.module.css';
type Props = {
  detail: NewsletterParserDetail;
  units: NewsletterReviewUnit[];
  selected: string;
  saveMessage: string;
  onSelect: (unit: NewsletterReviewUnit) => void;
  onChange: (unit: NewsletterReviewUnit) => void;
  onAdd: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onPick: (end: 'start' | 'end') => void;
};
export function NewsletterEditor({
  detail,
  units,
  selected,
  saveMessage,
  onSelect,
  onChange,
  onAdd,
  onExport,
  onImport,
  onPick,
}: Props) {
  const unit = units.find((u) => u.id === selected);
  const original = detail.units.find((u) => u.id === selected);
  const a = detail.blocks?.findIndex((b) => b.node_id === unit?.boundary?.start_node_id) ?? -1,
    b = detail.blocks?.findIndex((b) => b.node_id === unit?.boundary?.end_node_id) ?? -1;
  const links = (detail.links ?? []).filter(
    (l) =>
      a >= 0 &&
      b >= a &&
      l.start_offset < (detail.blocks[b].end_offset ?? 0) &&
      l.end_offset > (detail.blocks[a].start_offset ?? Infinity),
  );
  const urls = [...new Map(links.map((l) => [l.target_url ?? l.original_url, l])).values()];
  const content = useMemo(() => {
    if (!unit?.boundary || a < 0 || b < a) return '';
    const doc = new DOMParser().parseFromString(detail.html, 'text/html');
    return detail.blocks
      .slice(a, b + 1)
      .map((r) => doc.querySelector(`[data-review-node="${r.node_id}"]`)?.textContent ?? '')
      .join('\n\n');
  }, [detail, unit?.boundary, a, b]);
  return (
    <section
      className={styles.units}
      aria-label="来源预选内容"
    >
      <header className={styles.editorToolbar}>
        <strong>来源预选内容</strong>
        <button
          type="button"
          onClick={onAdd}
        >
          新增遗漏内容
        </button>
        <button
          type="button"
          onClick={onExport}
        >
          下载本封标注
        </button>
        <label>
          载入标注文件
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImport(file);
              e.target.value = '';
            }}
          />
        </label>
        <span role="status">{saveMessage}</span>
      </header>
      {detail.warnings.map((w, i) => (
        <p
          className={styles.editorNotice}
          key={i}
        >
          {w}
        </p>
      ))}
      <div className={styles.workspace}>
        <nav
          className={styles.moduleList}
          aria-label="内容模块"
        >
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              aria-pressed={selected === u.id}
              className={selected === u.id ? styles.selected : styles.unit}
              onClick={() => onSelect(u)}
            >
              {detail.units.some((p) => p.id === u.id) ? '' : '＋ '}
              {REVIEW_STATUS_LABELS[u.status]} · {u.corrections.title || '未命名内容'}
            </button>
          ))}
        </nav>
        <div className={styles.editor}>
          {!unit ? (
            <p>暂无内容单元，可新增遗漏内容。</p>
          ) : (
            <>
              <h2>{original ? '来源预选内容' : '人工补充内容'}</h2>
              <p className={styles.identifier}>{unit.id}</p>
              <fieldset>
                <label>
                  审核状态
                  <select
                    value={unit.status}
                    onChange={(e) =>
                      onChange({
                        ...unit,
                        status: e.target.value as NewsletterReviewUnit['status'],
                      })
                    }
                  >
                    {Object.entries(REVIEW_STATUS_LABELS).map(([value, label]) => (
                      <option
                        key={value}
                        value={value}
                      >
                        {value} · {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  内容类型
                  <select
                    value={unit.content_type ?? ''}
                    onChange={(e) =>
                      onChange({
                        ...unit,
                        content_type: (e.target.value ||
                          null) as NewsletterReviewUnit['content_type'],
                      })
                    }
                  >
                    <option value="">请选择内容类型</option>
                    {['standalone_content', 'external_reference', 'non_content'].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                {(['title', 'summary', 'original_url'] as const).map((field) => (
                  <label key={field}>
                    人工{' '}
                    {field === 'original_url'
                      ? 'Original URL'
                      : field === 'title'
                        ? 'Title'
                        : 'Summary'}
                    {field === 'original_url' ? (
                      <input
                        value={unit.corrections[field] ?? ''}
                        onChange={(e) =>
                          onChange({
                            ...unit,
                            corrections: { ...unit.corrections, [field]: e.target.value || null },
                          })
                        }
                      />
                    ) : (
                      <textarea
                        rows={field === 'title' ? 2 : 4}
                        value={unit.corrections[field] ?? ''}
                        onChange={(e) =>
                          onChange({
                            ...unit,
                            corrections: { ...unit.corrections, [field]: e.target.value || null },
                          })
                        }
                      />
                    )}
                  </label>
                ))}
                <label>
                  区域内链接（{urls.length}）
                  <select
                    value=""
                    disabled={!urls.length}
                    onChange={(e) => {
                      if (e.target.value)
                        onChange({
                          ...unit,
                          corrections: { ...unit.corrections, original_url: e.target.value },
                        });
                    }}
                  >
                    <option value="">选择当前区域内的链接（不打开网页）</option>
                    {urls.map((l) => (
                      <option
                        key={l.target_url ?? l.original_url}
                        value={l.target_url ?? l.original_url}
                      >
                        {l.anchor_text || '无锚文本'} — {l.target_url ?? l.original_url}
                      </option>
                    ))}
                  </select>
                </label>
                <p className={styles.muted}>
                  选择后写入 Original URL；追踪目标未知时保留原地址，不推测目标。
                </p>
                <div className={styles.boundary}>
                  <strong>内容边界（按原始 DOM 顺序，含起止块）</strong>
                  {(['start', 'end'] as const).map((end) => (
                    <label key={end}>
                      {end === 'start' ? '起始块' : '结束块'}
                      <select
                        value={unit.boundary?.[`${end}_node_id`] ?? ''}
                        onChange={(e) =>
                          onChange({
                            ...unit,
                            boundary: e.target.value
                              ? {
                                  start_node_id: unit.boundary?.start_node_id ?? e.target.value,
                                  end_node_id: unit.boundary?.end_node_id ?? e.target.value,
                                  [`${end}_node_id`]: e.target.value,
                                }
                              : null,
                          })
                        }
                      >
                        <option value="">未选择</option>
                        {detail.blocks.map((block) => (
                          <option
                            key={block.node_id}
                            value={block.node_id}
                          >
                            {block.node_id} &lt;{block.tag}&gt; {block.excerpt.slice(0, 85)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => onPick(end)}
                      >
                        点击左侧选{end === 'start' ? '起点' : '终点'}
                      </button>
                    </label>
                  ))}
                  {a >= 0 && b < a && <p role="alert">结束块早于起始块，请调整。</p>}
                </div>
                <label>
                  原文证据
                  <textarea
                    rows={3}
                    value={unit.text_evidence}
                    onChange={(e) => onChange({ ...unit, text_evidence: e.target.value })}
                  />
                </label>
                <label>
                  备注
                  <textarea
                    rows={3}
                    value={unit.notes}
                    onChange={(e) => onChange({ ...unit, notes: e.target.value })}
                  />
                </label>
                <details>
                  <summary>当前边界正文</summary>
                  <p className={styles.body}>{content || '请选择有效的内容边界。'}</p>
                </details>
                {original && (
                  <details>
                    <summary>原始 Code Parser 结果（只读）</summary>
                    <p>{original.title}</p>
                    <p>{original.content_type}</p>
                    <p className={styles.body}>{original.content_text}</p>
                    <p>{original.primary_url ?? 'N/A'}</p>
                  </details>
                )}
              </fieldset>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
