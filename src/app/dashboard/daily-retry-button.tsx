"use client";

/**
 * Dashboard 当前 Daily 的手动重跑控件。
 *
 * 只向固定的内部 endpoint 发起 POST；确认和短暂的运行状态留在浏览器侧，
 * 不让日期选择器或用户输入参与服务器命令构造。
 */
import { useState } from "react";
import styles from "./dashboard.module.css";

type DailyRetryButtonProps = {
  dailyDate: string;
  initiallyRunning: boolean;
};

/** 确认后请求后台启动 Daily，并展示启动或互斥锁返回的状态。 */
export function DailyRetryButton({ dailyDate, initiallyRunning }: DailyRetryButtonProps) {
  const [running, setRunning] = useState(initiallyRunning);
  const [error, setError] = useState<string | null>(null);

  async function retryDaily(): Promise<void> {
    if (
      !window.confirm(
        `Run Daily Workflow for ${dailyDate}?\n\nThis runs the complete Daily Workflow.`,
      )
    ) {
      return;
    }

    setError(null);
    try {
      const response = await fetch("/api/dashboard/daily/retry", { method: "POST" });
      const result: { status?: string; message?: string } = await response.json();
      if (!response.ok || result.status === "failed") {
        throw new Error(result.message ?? "Failed to start Daily Workflow.");
      }
      if (result.status === "started" || result.status === "already_running") {
        setRunning(true);
        return;
      }
      throw new Error("Unexpected Daily Workflow response.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Failed to start Daily Workflow.");
    }
  }

  return (
    <span className={styles.retryControl}>
      <button type="button" className={styles.retryButton} disabled={running} onClick={retryDaily}>
        {running ? "Running..." : "Retry Daily"}
      </button>
      {error ? <span className={styles.retryError} role="alert">{error}</span> : null}
    </span>
  );
}
