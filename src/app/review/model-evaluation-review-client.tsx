/**
 * Model Evaluation 的交互与结果展示组件。
 * 页面只调用受限 API 并消费已归一化的结果；不在浏览器端构造输入、调用 LLM 或访问数据库。
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation.js";
import type { EvaluationModel } from "@/lib/evaluation-model-config.js";
import type { EvaluationReviewData, EvaluationRunView, Stage1EvaluationItem } from "@/lib/evaluation-review.js";
import type { EvaluationStage } from "@/lib/model-evaluation.js";
import styles from "./review.module.css";

const STAGES: Array<{ value: EvaluationStage; label: string }> = [
  { value: "stage1", label: "Understanding" },
  { value: "stage2", label: "Event Merge" },
  { value: "stage3_event", label: "Event Ranking" },
  { value: "stage3_digest", label: "Digest Ranking" },
  { value: "stage3_long_form", label: "Long-form Ranking" },
];

export function ModelEvaluationReview(props: {
  data: EvaluationReviewData;
  models: EvaluationModel[];
}) {
  const [data, setData] = useState(props.data);
  const [date, setDate] = useState(props.data.dailyDate);
  const [stage, setStage] = useState<EvaluationStage>(props.data.stage);
  const [providers, setProviders] = useState(props.models.map((model) => model.provider));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage1Mode, setStage1Mode] = useState<"disagreements" | "all">("disagreements");
  const router = useRouter();
  const hasRunningRun = data.runs.some((run) => run.status === "running");

  useEffect(() => {
    if (!running && !hasRunningRun) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`../../api/evaluation?date=${encodeURIComponent(data.dailyDate)}&stage=${encodeURIComponent(data.stage)}`);
        if (!response.ok) return;
        const next = await response.json() as EvaluationReviewData;
        if (cancelled) return;
        setData(next);
        if (!next.runs.some((run) => run.status === "running")) setRunning(false);
      } catch {
        // 临时读取失败不改变已显示的持久化状态，下一轮 polling 会继续尝试。
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [data.dailyDate, data.stage, hasRunningRun, running]);

  const viewResults = () => {
    router.push(`./models?date=${encodeURIComponent(date)}&stage=${encodeURIComponent(stage)}`);
  };
  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const response = await fetch("../../api/evaluation/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date, stage, providers }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Failed to start Model Evaluation.");
      router.push(`./models?date=${encodeURIComponent(date)}&stage=${encodeURIComponent(stage)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to run Model Evaluation.");
      setRunning(false);
    }
  };
  const toggleProvider = (provider: EvaluationModel["provider"]) => {
    setProviders((current) => current.includes(provider)
      ? current.filter((value) => value !== provider)
      : [...current, provider]);
  };
  const successfulRuns = data.runs.filter((run) => run.status === "success");

  return (
    <section className={styles.evaluation}>
      <div className={styles.evaluationControls}>
        <label>Date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
        <label>Stage<select value={stage} onChange={(event) => setStage(event.target.value as EvaluationStage)}>
          {STAGES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        <fieldset>
          <legend>Models</legend>
          {props.models.map((model) => <label key={model.provider}>
            <input type="checkbox" checked={providers.includes(model.provider)} onChange={() => toggleProvider(model.provider)} />
            {providerLabel(model.provider)} <small>{model.model}</small>
          </label>)}
        </fieldset>
        <button type="button" onClick={viewResults} disabled={running}>View</button>
        <button className={styles.runButton} type="button" onClick={run} disabled={running || providers.length === 0}>
          {running ? "Running..." : "Run Evaluation"}
        </button>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
      {data.input ? <p className={styles.snapshot}>Frozen input · {data.input.id} · {data.input.inputHash.slice(0, 12)} · Last run {formatTime(data.input.createdAt)}</p> : null}
      {data.runs.length > 0 ? <RunStatuses runs={data.runs} /> : null}
      {!data.input ? <p className={styles.empty}>No comparable evaluation exists for this date and stage yet.</p> : null}
      {data.input && successfulRuns.length < 2 ? <p className={styles.empty}>This frozen input does not yet have two successful model outputs to compare.</p> : null}
      {data.stage1 ? <Stage1Results items={data.stage1} runs={successfulRuns} mode={stage1Mode} onModeChange={setStage1Mode} /> : null}
      {data.stage2 ? <Stage2Results data={data} /> : null}
      {data.rankings ? <Stage3Results data={data} /> : null}
    </section>
  );
}

function RunStatuses(props: { runs: EvaluationRunView[] }) {
  return <div className={styles.runStatuses}>{props.runs.map((run) => <article key={run.id} className={styles.runStatus}>
    <strong>{providerLabel(run.provider)}</strong><span>{run.status}</span>
    <small>{run.model} · {run.completedAt ? formatTime(run.completedAt) : "Running"}</small>
    {run.error ? <p className={styles.error}>{run.error}</p> : null}
  </article>)}</div>;
}

function Stage1Results(props: {
  items: Stage1EvaluationItem[];
  runs: EvaluationRunView[];
  mode: "disagreements" | "all";
  onModeChange: (mode: "disagreements" | "all") => void;
}) {
  const visible = props.mode === "disagreements"
    ? props.items.filter((item) => item.routingDisagreement || item.categoryDisagreement)
    : props.items;
  return <div className={styles.evaluationResults}>
    <div className={styles.resultToolbar}><strong>Understanding</strong><button type="button" onClick={() => props.onModeChange("disagreements")} disabled={props.mode === "disagreements"}>Disagreements</button><button type="button" onClick={() => props.onModeChange("all")} disabled={props.mode === "all"}>All</button></div>
    {visible.length === 0 ? <p className={styles.empty}>No routing or category disagreements in this frozen input.</p> : visible.map((item) => <article className={styles.stage1Item} key={item.id}>
      <header><strong>{item.title}</strong><small>{item.source}</small></header>
      <div className={styles.modelColumns}>{props.runs.map((run) => {
        const result = item.results[run.id];
        return <section key={run.id}><h3>{providerLabel(run.provider)}</h3><p>Routing: {result?.routing ?? "—"}</p><p>Category: {result?.category ?? "—"}</p><p>Title ZH: {result?.titleZh ?? "—"}</p><p>Summary ZH: {result?.summaryZh ?? "—"}</p></section>;
      })}</div>
    </article>)}</div>;
}

function Stage2Results(props: { data: EvaluationReviewData }) {
  const models = props.data.stage2 ?? [];
  return <div className={styles.evaluationResults}>
    <div className={styles.resultToolbar}><strong>Event Merge</strong></div>
    <div className={styles.modelColumns}>{models.map((model) => <section className={styles.groupColumn} key={model.runId}>
      <h2>{providerLabel(model.provider)}</h2><p>{model.groupCount} groups · {model.singletonCount} singletons</p>
      {model.groups.map((group, index) => <article className={styles.eventGroup} key={`${group.eventHint}-${index}`}><strong>{group.eventHint}</strong><small>{group.articles.length} sources</small>{group.articles.map((article) => <p key={article.id}>• {article.title}<br /><em>{article.source}</em></p>)}</article>)}
    </section>)}</div>
  </div>;
}

function Stage3Results(props: { data: EvaluationReviewData }) {
  const runs = props.data.runs.filter((run) => run.status === "success");
  const rows = props.data.rankings ?? [];
  const byCategory = new Map<string, typeof rows>();
  for (const row of rows) {
    const category = row.category ?? "All candidates";
    byCategory.set(category, [...(byCategory.get(category) ?? []), row]);
  }
  return <div className={styles.evaluationResults}>{[...byCategory.entries()].map(([category, categoryRows]) => <section className={styles.rankingSection} key={category}>
    <div className={styles.resultToolbar}><strong>{category}</strong></div>
    <div className={styles.rankingTable}><div className={styles.rankingHead}><span>Item</span>{runs.map((run) => <span key={run.id}>{providerLabel(run.provider)}</span>)}<span>Δ</span></div>
      {categoryRows.map((row) => <div className={styles.rankingRow} key={row.id}><span><strong>{row.title}</strong>{row.source ? <small>{row.source}</small> : null}{topCutoffLabel(row.topProviders, runs.length, row.topCutoff) ? <em>{topCutoffLabel(row.topProviders, runs.length, row.topCutoff)}</em> : null}</span>{runs.map((run) => <span key={run.id}>{row.ranks[run.id] ?? "—"}</span>)}<span>{row.delta ?? "—"}</span></div>)}
    </div>
  </section>)}</div>;
}

function topCutoffLabel(providers: string[], modelCount: number, cutoff: number | null) {
  if (cutoff === null) return null;
  if (providers.length === 0) return null;
  return providers.length === modelCount ? `Both Top ${cutoff}` : `Only ${providers.map(providerLabel).join(", ")} Top ${cutoff}`;
}

function providerLabel(provider: string) {
  return provider === "deepseek" ? "DeepSeek" : provider === "kimi" ? "Kimi" : provider;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
