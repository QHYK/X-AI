'use client';

import { useEffect, useRef, useState } from 'react';
import type { PutBackResult, PutBackFields } from '@/lib/digest-put-back.js';
import styles from '../dashboard.module.css';

export function PutBackButton(props: {
  id: string;
  date: string;
  inDigest?: boolean;
  onRestored?: (result: PutBackResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(Boolean(props.inDigest));
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<PutBackFields | null>(null);
  const locked = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function restore() {
    if (locked.current || done || props.inDigest) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('../api/admin/dashboard/analytics/ignored-articles/put-back', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: props.id, date: props.date }),
      });
      const payload = (await response.json()) as {
        restored?: PutBackResult;
        message?: string;
        generatedFields?: PutBackFields;
      };
      if (!active.current) return;
      if (!response.ok || !payload.restored) {
        if (payload.generatedFields) setGenerated(payload.generatedFields);
        throw new Error(payload.message ?? '恢复失败。');
      }
      setDone(true);
      setGenerated(null);
      props.onRestored?.(payload.restored);
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : '恢复失败。');
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className={styles.analyticsPutBack}>
      <button
        className={styles.retryButton}
        type="button"
        disabled={busy || done || props.inDigest}
        onClick={() => void restore()}
      >
        {busy ? 'Restoring…' : done || props.inDigest ? 'In Digest' : 'Put Back'}
      </button>
      {done || props.inDigest ? (
        <small role="status">已进入 Daily {props.date} 的 Digest。</small>
      ) : null}
      {error ? (
        <p
          role="alert"
          className={styles.error}
        >
          {error}
        </p>
      ) : null}
      {generated ? (
        <details open>
          <summary>已生成字段（请保留）</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(generated, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}
