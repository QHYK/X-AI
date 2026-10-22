'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DiscoveryTagsSchema } from '@/lib/discovery-content-metadata.js';
import type { InDepthReviewItem } from '@/lib/in-depth-reads.js';
import styles from '../review.module.css';

export function ManualCandidateForm(props: {
  apiUrl: () => string;
  disabled: boolean;
  onCreated: (item: InDepthReviewItem) => void;
}) {
  const [url, setUrl] = useState('');
  const [tags, setTags] = useState(Array.from({ length: 3 }, () => ({ zh: '', en: '' })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const locked = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (locked.current || props.disabled) return;
    setError(null);
    setMessage(null);
    const parsed = DiscoveryTagsSchema.safeParse(
      tags.filter((tag) => tag.zh.trim() || tag.en.trim()),
    );
    if (!parsed.success) {
      setError('每组 Tags 都需要完整中英文，最多三组。');
      return;
    }
    locked.current = true;
    setBusy(true);
    try {
      const response = await fetch(`${props.apiUrl()}/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, tags: parsed.data }),
      });
      const payload = (await response.json()) as {
        item?: InDepthReviewItem;
        existing?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.item) throw new Error(payload.error ?? '候选提交失败。');
      if (!active.current) return;
      props.onCreated(payload.item);
      setMessage(
        payload.existing
          ? '已找到现有候选，展示其已有内容；没有重新生成、覆盖标签或改变审核状态。'
          : '已创建 Pending 候选并保存正文引用。请在详情中另行点击 Generate。',
      );
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '候选提交失败。');
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <details className={styles.inDepthEditor}>
      <summary>人工添加 In-depth 候选</summary>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Original URL
          <input
            type="url"
            required
            value={url}
            maxLength={4000}
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <p>Tags 可留空，最多三组。此步不调用 LLM；没有已存正文时会抓取原文。</p>
        {tags.map((tag, index) => (
          <div
            className={styles.manualTagRow}
            key={index}
          >
            <label>
              Tag {index + 1} · 中文
              <input
                value={tag.zh}
                maxLength={80}
                disabled={busy}
                onChange={(event) =>
                  setTags((current) =>
                    current.map((entry, i) =>
                      i === index ? { ...entry, zh: event.target.value } : entry,
                    ),
                  )
                }
              />
            </label>
            <label>
              Tag {index + 1} · English
              <input
                value={tag.en}
                maxLength={120}
                disabled={busy}
                onChange={(event) =>
                  setTags((current) =>
                    current.map((entry, i) =>
                      i === index ? { ...entry, en: event.target.value } : entry,
                    ),
                  )
                }
              />
            </label>
          </div>
        ))}
        <button
          type="submit"
          disabled={busy || props.disabled}
        >
          {busy ? '获取并保存中…' : '获取基础信息并创建候选'}
        </button>
      </form>
      {error ? (
        <p
          role="alert"
          className={styles.error}
        >
          {error}
        </p>
      ) : null}
      {message ? (
        <p
          role="status"
          className={styles.message}
        >
          {message}
        </p>
      ) : null}
    </details>
  );
}

export function SavedArticleContent(props: { id: string; apiUrl: () => string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function load() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${props.apiUrl()}/manual?id=${encodeURIComponent(props.id)}`, {
        cache: 'no-store',
      });
      const payload = (await response.json()) as { content?: string | null; error?: string };
      if (!response.ok) throw new Error(payload.error ?? '正文读取失败。');
      setContent(payload.content ?? '没有可读取的已存全文。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '正文读取失败。');
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <details className={styles.inDepthCopy}>
      <summary>已保存正文（只读）</summary>
      <button
        type="button"
        disabled={busy}
        onClick={() => void load()}
      >
        {busy ? '读取中…' : '读取已保存正文'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {content !== null ? <pre className={styles.savedArticleContent}>{content}</pre> : null}
    </details>
  );
}
