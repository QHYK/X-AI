'use client';
import { useEffect, useRef, useState } from 'react';
import styles from '../review/review.module.css';
import detailStyles from '../review/in-depth/in-depth.module.css';

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
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>X-AI-field · Content Discovery</p>
          <h1>Content Discovery</h1>
          <p>输入研究方向，独立探索值得阅读的作品。发现的候选经验证后进入 In-depth Review。</p>
        </div>
        <a
          className={styles.reviewAction}
          href="./review/in-depth"
        >
          In-depth Review →
        </a>
      </header>
      <section
        className={styles.reviewSection}
        aria-labelledby="discovery-form-title"
      >
        <div className={detailStyles.inDepthDetail}>
          <header className={detailStyles.inDepthDetailHeader}>
            <div>
              <h2 id="discovery-form-title">New Discovery</h2>
              <p className={styles.summary}>
                粘贴标题、摘要、背景材料或研究问题。每次提交创建独立运行，任务按队列依次执行。
              </p>
            </div>
          </header>
          <form
            onSubmit={submit}
            className={detailStyles.inDepthEditor}
          >
            <label>
              研究主题 · 可选
              <textarea
                maxLength={16000}
                rows={7}
                placeholder="留空则自主发现。也可以粘贴新闻标题、摘要、背景材料或研究问题。"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
              />
            </label>
            <label>
              参考 URL（可选，仅作研究线索）
              <input
                type="url"
                placeholder="https://…（仅作研究线索，不保证入选）"
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
                placeholder="例如：优先寻找包含原始证据的长文。指令仅用于本次研究，不写入长期 Memory。"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            </label>
            <div className={detailStyles.inDepthActions}>
              <button
                disabled={busy}
                type="submit"
              >
                {busy ? 'Submitting…' : 'Start Discovery'}
              </button>
            </div>
            <p className={styles.snapshot}>执行前将确认付费模型、Web Search 和 Firecrawl 调用。</p>
          </form>
          {error && (
            <p
              className={styles.error}
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </section>
      {run && (
        <section
          className={styles.reviewSection}
          aria-live="polite"
        >
          <div className={detailStyles.inDepthDetail}>
            <header className={detailStyles.inDepthDetailHeader}>
              <h2>Discovery Run</h2>
            </header>
            <div className={styles.itemMeta}>
              <span>{run.status}</span>
              {run.endReason && <span>{run.endReason}</span>}
            </div>
            <p className={styles.snapshot}>Run ID: {run.id}</p>
            {run.errorSummary && (
              <p
                className={styles.error}
                role="alert"
              >
                {run.errorSummary}
              </p>
            )}
            {run.input && (
              <details>
                <summary>本 Run 输入快照</summary>
                <p>{run.input.researchTopic}</p>
                {run.input.referenceUrl && <p>参考 URL：{run.input.referenceUrl}</p>}
                {run.input.instructions && <p>补充指令：{run.input.instructions}</p>}
              </details>
            )}
            <h3>阶段与用量</h3>
            {Object.entries(run.executionState ?? {}).map(([stage, state]) => (
              <p key={stage}>
                {stage.toUpperCase()} · {state.status} · 请求 {state.usage?.requests ?? 'N/A'} ·
                输入 Token {state.usage?.inputTokens ?? 'N/A'} · 输出 Token{' '}
                {state.usage?.outputTokens ?? 'N/A'} · 耗时{' '}
                {state.elapsedMs == null ? 'N/A' : `${Math.round(state.elapsedMs / 1000)}s`}
                {state.usage && !state.usage.usageComplete ? '（用量不完整）' : ''}
              </p>
            ))}
            <h3>Discovered Candidates</h3>
            {!run.candidates?.length && (
              <p className={styles.summary}>
                {active ? '运行中，候选将在验证完成后显示。' : '本次运行暂无候选。'}
              </p>
            )}
            <div className={styles.rankedList}>
              {run.candidates?.map((candidate) => (
                <article
                  className={detailStyles.inDepthDetail}
                  key={candidate.id}
                >
                  <h3>{candidate.title_zh || candidate.title}</h3>
                  <div className={styles.itemMeta}>
                    <span>{candidate.publication || '来源未知'}</span>
                    <span>{candidate.status}</span>
                  </div>
                  <p>{candidate.why_worth_reading}</p>
                  {candidate.review_id && (
                    <a
                      className={styles.reviewAction}
                      href="./review/in-depth"
                    >
                      Review candidate →
                    </a>
                  )}
                </article>
              ))}
            </div>
          </div>
        </section>
      )}
      <section
        className={styles.reviewSection}
        aria-labelledby="history-title"
      >
        <div className={detailStyles.inDepthDetail}>
          <header className={detailStyles.inDepthDetailHeader}>
            <div>
              <h2 id="history-title">Discovery History</h2>
              <p className={styles.summary}>查看独立运行的输入、状态和候选结果。</p>
            </div>
          </header>
          <div className={detailStyles.inDepthList}>
            {!history.length && <p className={styles.summary}>暂无独立运行记录。</p>}
            {history.map((item) => (
              <button
                type="button"
                className={detailStyles.inDepthListItem}
                key={item.id}
                aria-pressed={run?.id === item.id}
                onClick={() => void select(item.id)}
              >
                <strong>{item.input.researchTopic.slice(0, 120) || '自主发现'}</strong>
                <span>
                  {item.status} · {item.created_at}
                </span>
                <small>{item.id}</small>
              </button>
            ))}
          </div>
          <div className={detailStyles.inDepthActions}>
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={history.length < 20}
              onClick={() => setOffset(offset + 20)}
            >
              下一页
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
