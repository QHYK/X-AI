'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation.js';
import { discoveryDatesForEndDate } from '@/lib/discovery-window.js';
import styles from './dashboard.module.css';

type Job = { id: string; status: string; errorSummary?: string | null };
export function DiscoveryActions({
  date,
  mode,
  active,
}: {
  date: string;
  mode: 'regular' | 'open';
  active?: Job | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const key = useRef<string | null>(null);
  const [job, setJob] = useState<Job | null>(active ?? null);
  const [error, setError] = useState<string | null>(null);
  const running = job?.status === 'pending' || job?.status === 'running';
  useEffect(() => {
    if (!running || !job) return;
    const controller = new AbortController();
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(`./api/admin/discovery?id=${encodeURIComponent(job.id)}`, {
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? '状态读取失败');
        if (controller.signal.aborted) return;
        setJob(result);
        setError(null);
        router.refresh();
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : '状态读取失败');
      } finally {
        polling = false;
      }
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [job, running, router]);
  async function submit() {
    if (lock.current || running) return;
    const [start, end] = discoveryDatesForEndDate(date);
    if (
      !window.confirm(
        `执行窗口：${start} 至 ${end}\n阶段：${mode === 'regular' ? 'D2 → D3 / D4 → 条件触发 D5' : '仅 D5 Open（不执行 D2–D4）'}\n将创建新 Run，可能调用付费模型、Web Search 和 Firecrawl。是否继续？`,
      )
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      // getRandomValues is available on the current HTTP deployment too.
      key.current ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const response = await fetch('./api/admin/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, mode, requestId: key.current, confirmPaid: true }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '提交失败');
      setJob(result);
      key.current = null;
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : '提交失败');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className={`${styles.retryControl} ${styles.discoveryControl}`}>
      <button
        type="button"
        className={styles.retryButton}
        disabled={busy || running}
        onClick={submit}
      >
        {busy ? 'Submitting…' : mode === 'regular' ? 'Retry Discovery' : 'Retry Open'}
      </button>
      {job ? (
        <p role="status">
          {job.status} · {job.id}
          {job.errorSummary ? ` · ${job.errorSummary}` : ''}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className={styles.retryError}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
