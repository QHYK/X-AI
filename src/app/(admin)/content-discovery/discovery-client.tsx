'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './discovery.module.css';

type Run = {
  id: string;
  status: string;
  errorSummary?: string | null;
  endReason?: string;
  input?: { researchTopic: string; referenceUrl: string | null; instructions: string | null };
  executionState?: Record<
    string,
    {
      status: string;
      elapsedMs?: number;
      usage?: {
        requests: number;
        inputTokens: number | null;
        outputTokens: number | null;
        usageComplete: boolean;
      };
    }
  >;
  candidates?: {
    id: string;
    title: string;
    title_zh: string;
    publication: string;
    why_worth_reading: string;
    status: string;
    review_id: string | null;
  }[];
};
type History = { id: string; status: string; created_at: string; input: { researchTopic: string } };
const endpoint = './api/admin/discovery';
async function read(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败');
  return data;
}
export function ContentDiscoveryClient() {
  const [topic, setTopic] = useState('');
  const [referenceUrl, setReferenceUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void read(`${endpoint}?history=standalone&offset=${offset}`)
      .then((data) => {
        if (!cancelled) setHistory(data.runs);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [offset, run?.status]);
  const runId = run?.id;
  const active = run?.status === 'pending' || run?.status === 'running';
  useEffect(() => {
    if (!active || !runId) return;
    let pending = false;
    const controller = new AbortController();
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void read(`${endpoint}?id=${runId}`, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setRun(data);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(String(error));
        })
        .finally(() => {
          pending = false;
        });
    }, 3000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [active, runId]);
  async function select(id: string) {
    try {
      setRun(await read(`${endpoint}?id=${id}`));
      setError('');
    } catch (error) {
      setError(String(error));
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    if (
      !window.confirm(
        '启动 D5 Open Discovery？将创建独立 Run，可能调用付费模型、Web Search 和 Firecrawl；任务按队列串行执行。',
      )
    )
      return;
    submitting.current = true;
    setBusy(true);
    setError('');
    const fields = {
      mode: 'standalone',
      researchTopic: topic.trim(),
      referenceUrl: referenceUrl.trim() || null,
      instructions: instructions.trim() || null,
      confirmPaid: true,
    };
    const payload = JSON.stringify(fields);
    if (request.current?.payload !== payload)
      request.current = {
        payload,
        id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
      };
    try {
      const result = await read(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, requestId: request.current.id }),
      });
      setRun(result);
      request.current = null;
      await select(result.id);
    } catch (error) {
      setError(String(error));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <main className={styles.page}>
      <h1>Content Discovery</h1>
      <p>独立探索高质量作品，结果进入现有人工审核队列。</p>
      <form
        onSubmit={submit}
        className={styles.form}
      >
        <label>
          研究主题
          <textarea
            required
            maxLength={16000}
            rows={7}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
        </label>
        <label>
          参考 URL（可选，仅作研究线索）
          <input
            type="url"
            maxLength={2048}
            value={referenceUrl}
            onChange={(e) => setReferenceUrl(e.target.value)}
          />
        </label>
        <label>
          本次补充指令（可选，仅作用于本 Run）
          <textarea
            maxLength={8000}
            rows={4}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
        <button
          disabled={busy}
          type="submit"
        >
          {busy ? 'Submitting…' : 'Start Discovery'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {run && (
        <section aria-live="polite">
          <h2>当前 Run</h2>
          <p>
            {run.id} · {run.status} · {run.endReason}
          </p>
          {run.errorSummary && <p role="alert">{run.errorSummary}</p>}
          {run.input && (
            <div>
              <h3>本 Run 输入快照</h3>
              <p>{run.input.researchTopic}</p>
              {run.input.referenceUrl && <p>参考 URL：{run.input.referenceUrl}</p>}
              {run.input.instructions && <p>补充指令：{run.input.instructions}</p>}
            </div>
          )}
          <h3>阶段与用量</h3>
          {Object.entries(run.executionState ?? {}).map(([stage, state]) => (
            <p key={stage}>
              {stage.toUpperCase()} · {state.status} · 请求 {state.usage?.requests ?? 'N/A'} · 输入
              Token {state.usage?.inputTokens ?? 'N/A'} · 输出 Token{' '}
              {state.usage?.outputTokens ?? 'N/A'} · 耗时{' '}
              {state.elapsedMs == null ? 'N/A' : `${Math.round(state.elapsedMs / 1000)}s`}
              {state.usage && !state.usage.usageComplete ? '（用量不完整）' : ''}
            </p>
          ))}
          {run.candidates?.map((candidate) => (
            <article key={candidate.id}>
              <h3>{candidate.title_zh || candidate.title}</h3>
              <p>
                {candidate.publication} · {candidate.status}
              </p>
              <p>{candidate.why_worth_reading}</p>
              {candidate.review_id && <a href="./review/in-depth">前往 In-depth Review</a>}
            </article>
          ))}
        </section>
      )}
      <section>
        <h2>独立运行历史</h2>
        {history.map((item) => (
          <p key={item.id}>
            <button onClick={() => void select(item.id)}>
              {item.input.researchTopic.slice(0, 120)} · {item.status}
            </button>{' '}
            · {item.created_at}
          </p>
        ))}
        <button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页
        </button>
        <button
          disabled={history.length < 20}
          onClick={() => setOffset(offset + 20)}
        >
          下一页
        </button>
      </section>
    </main>
  );
}
