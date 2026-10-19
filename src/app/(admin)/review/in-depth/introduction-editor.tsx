'use client';

import { useEffect, useRef, useState } from 'react';
import {
  EditorialIntroductionSchema,
  readEditorialIntroduction,
  type EditorialIntroduction,
} from '@/lib/in-depth-editorial.js';
import styles from '../review.module.css';

export function IntroductionEditor(props: {
  id: string;
  overrides: Record<string, unknown> | null;
  apiUrl: () => string;
}) {
  const initial = readEditorialIntroduction(props.overrides);
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState<'generate' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<EditorialIntroduction | null>(null);
  const locked = useRef(false);
  const revision = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const dirty =
    draft.summary !== saved.summary ||
    draft.whyWorthReading !== saved.whyWorthReading ||
    draft.extra_info !== saved.extra_info;
  const hasContent = Boolean(
    draft.summary ||
    draft.whyWorthReading ||
    draft.extra_info ||
    saved.summary ||
    saved.whyWorthReading ||
    saved.extra_info,
  );

  function edit(field: keyof EditorialIntroduction, value: string) {
    revision.current++;
    setDraft((current) => ({ ...current, [field]: value }));
    setMessage(null);
  }

  async function submit(generate: boolean) {
    if (locked.current) return;
    if (
      generate &&
      dirty &&
      !window.confirm('存在未保存的人工修改，重新生成可能覆盖这些内容。是否继续？')
    )
      return;
    locked.current = true;
    setBusy(generate ? 'generate' : 'save');
    setError(null);
    setMessage(null);
    const startedRevision = revision.current;
    const submitted = { ...draft };
    try {
      const response = await fetch(props.apiUrl(), {
        method: generate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          generate ? { id: props.id } : { id: props.id, action: 'editorial', ...submitted },
        ),
      });
      const payload = (await response.json()) as {
        introduction?: unknown;
        item?: { editorialOverrides: Record<string, unknown> | null };
        error?: string;
        saved?: boolean;
      };
      if (!active.current) return;
      if (generate && payload.introduction) {
        const generated = EditorialIntroductionSchema.parse(payload.introduction);
        if (revision.current === startedRevision) {
          setDraft(generated);
          setRecovery(null);
        } else {
          setRecovery(generated);
        }
        if (response.ok && payload.saved) setSaved(generated);
      }
      if (response.ok && generate && (!payload.introduction || !payload.saved))
        throw new Error('生成接口未返回已保存的有效介绍。');
      if (response.ok && !generate && !payload.item) throw new Error('保存接口未返回有效结果。');
      if (!response.ok) throw new Error(payload.error ?? '保存失败。');
      if (!generate) {
        setSaved(submitted);
        setRecovery(null);
      }
      setMessage(
        revision.current === startedRevision
          ? generate
            ? '介绍已生成并保存。审核状态未改变。'
            : '介绍已保存。'
          : '请求已保存，保留了您随后输入的未保存修改。',
      );
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '请求失败。');
    } finally {
      locked.current = false;
      if (active.current) setBusy(null);
    }
  }

  return (
    <section
      className={styles.inDepthEditor}
      aria-label="完善介绍"
    >
      <h3>完善介绍</h3>
      <p>中文 Markdown，仅用于展示；生成成功后自动保存，不改变审核状态。</p>
      <div className={styles.inDepthActions}>
        <button
          type="button"
          disabled={Boolean(busy)}
          onClick={() => void submit(true)}
        >
          {busy === 'generate' ? 'Generating…' : hasContent ? 'Regenerate' : 'Generate'}
        </button>
      </div>
      <label>
        讲了什么
        <textarea
          aria-label="讲了什么"
          value={draft.summary}
          onChange={(event) => edit('summary', event.target.value)}
          maxLength={32_000}
          rows={10}
        />
      </label>
      <label>
        为什么值得用心阅读
        <textarea
          aria-label="为什么值得用心阅读"
          value={draft.whyWorthReading}
          onChange={(event) => edit('whyWorthReading', event.target.value)}
          maxLength={32_000}
          rows={8}
        />
      </label>
      <label>
        其他具体评估
        <textarea
          aria-label="其他具体评估"
          value={draft.extra_info}
          onChange={(event) => edit('extra_info', event.target.value)}
          maxLength={32_000}
          rows={8}
        />
      </label>
      <div className={styles.inDepthActions}>
        <button
          type="button"
          disabled={Boolean(busy) || !dirty}
          onClick={() => void submit(false)}
        >
          {busy === 'save' ? 'Saving…' : 'Save changes'}
        </button>
      </div>
      {dirty ? <p>有未保存的修改。</p> : null}
      {recovery ? (
        <details open>
          <summary>本次生成文本（未覆盖当前输入）</summary>
          <textarea
            aria-label="本次生成：讲了什么"
            readOnly
            value={recovery.summary}
            rows={6}
          />
          <textarea
            aria-label="本次生成：为什么值得用心阅读"
            readOnly
            value={recovery.whyWorthReading}
            rows={6}
          />
          <textarea
            aria-label="本次生成：其他具体评估"
            readOnly
            value={recovery.extra_info}
            rows={6}
          />
          <button
            type="button"
            onClick={() => {
              if (!dirty || window.confirm('使用生成文本替换当前未保存修改？')) {
                revision.current++;
                setDraft(recovery);
                setRecovery(null);
              }
            }}
          >
            使用生成文本
          </button>
        </details>
      ) : null}
      {error ? (
        <p
          className={styles.error}
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {message ? (
        <p
          className={styles.message}
          role="status"
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}
