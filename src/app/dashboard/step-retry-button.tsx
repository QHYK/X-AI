"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation.js";
import { MetricInfo } from "./metric-info.js";
import styles from "./dashboard.module.css";

type StepRetryButtonProps = {
  dailyDate: string;
  step: "content_completion" | "exact_duplicate_filter" | "stage1" | "stage2" | "stage3" | "stage4";
  label: string;
  initiallyRunning: boolean;
};

export function StepRetryButton({ dailyDate, step, label, initiallyRunning }: StepRetryButtonProps) {
  const router = useRouter();
  const [running, setRunning] = useState(initiallyRunning);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`./api/dashboard/step/retry?dailyDate=${encodeURIComponent(dailyDate)}&step=${step}`);
        const result: { status?: string | null } = await response.json();
        if (result.status && result.status !== "running") { setRunning(false); router.refresh(); }
      } catch { /* The current button remains disabled; next poll may recover. */ }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [dailyDate, router, running, step]);

  async function retry(): Promise<void> {
    const downstream = "\n\nRetry 当前步骤不会自动更新已经生成的后续阶段结果；如需更新，请依次 Retry 后续步骤。";
    const stage4 = step === "stage4" ? "\n\nStage4 会复用当前 Daily 已成功持久化的结果，并按照现有 resume / publish 规则执行。" : "";
    if (!window.confirm(`重新执行 ${label} for ${dailyDate}？\n\n只会执行当前步骤，不会自动运行后续步骤。${stage4}${downstream}`)) return;
    setError(null);
    try {
      const response = await fetch("./api/dashboard/step/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dailyDate, step }) });
      const result: { status?: string; message?: string } = await response.json();
      if (!response.ok || result.status === "failed") throw new Error(result.message ?? "Failed to start step.");
      if (result.status === "already_running") { setError("This step is already running."); setRunning(true); return; }
      setRunning(true);
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Failed to start step."); }
  }

  const info = step === "stage4"
    ? "只重新执行当前步骤，不会自动运行后续步骤。Stage4 会复用当前 Daily 已成功持久化的结果，并按照现有 resume / publish 规则执行。"
    : "只重新执行当前步骤，不会自动运行后续步骤。";
  return <span className={styles.retryControl}>
    <button type="button" className={styles.retryButton} disabled={running} onClick={retry}>{running ? "Running..." : "Retry"}</button>
    <MetricInfo text={info} />
    {error ? <span className={styles.retryError} role="alert">{error}</span> : null}
  </span>;
}
