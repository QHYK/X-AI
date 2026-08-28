/**
 * 低频人工 Model Evaluation 的 detached CLI 启动器。
 * 当前部署是长期运行的 Node server，因此独立子进程可在 HTTP 请求和浏览器断开后继续运行；
 * 真正的状态仍由 evaluation_runs 持久化，不以子进程内存状态为准。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { failPreparedEvaluation, type EvaluationStage, type PreparedEvaluation } from "./model-evaluation.js";

const SCRIPT_BY_STAGE: Record<EvaluationStage, string> = {
  stage1: "eval:stage1",
  stage2: "eval:stage2",
  stage3_event: "eval:stage3:event",
  stage3_digest: "eval:stage3:digest",
  stage3_long_form: "eval:stage3:long-form",
};

export type BackgroundEvaluationStartResult =
  | { status: "started"; evaluationInputId: string }
  | { status: "already_running" }
  | { status: "failed"; message: string };

/**
 * 避免同一 Daily + Stage 的重复人工触发。
 * 它只检查尚有 running 模型的 execution；历史 success/failed 均不阻止重新评测。
 */
export async function hasRunningEvaluation(
  pool: Pick<Pool, "query">,
  dailyDate: string,
  stage: EvaluationStage,
): Promise<boolean> {
  const result = await pool.query(
    `select 1
       from evaluation_inputs input
       join evaluation_runs run on run.evaluation_input_id = input.id
      where input.daily_date = $1::date and input.stage = $2 and run.status = 'running'
      limit 1`,
    [dailyDate, stage],
  );
  return result.rows.length > 0;
}

/**
 * 为每个 model run 启动独立 detached process group。
 * 这样 Cancel 可以向负 PID 发送信号，只结束对应 CLI 及其子进程，不影响同一 input 的其它模型。
 */
export async function startDetachedEvaluation(
  prepared: PreparedEvaluation,
  options: { rootDir?: string; spawn?: (script: string, runId: string, cwd: string) => ChildProcess } = {},
): Promise<BackgroundEvaluationStartResult> {
  const rootDir = options.rootDir ?? process.cwd();
  let startedCount = 0;
  let firstError: string | null = null;
  for (const modelRun of prepared.models) {
    try {
      const child = (options.spawn ?? spawnEvaluationCli)(
        SCRIPT_BY_STAGE[prepared.stage],
        modelRun.run.id,
        rootDir,
      );
      if (!child.pid) throw new Error("Detached Evaluation process did not provide a PID.");
      if (!prepared.storage.setRunProcessPid) {
        throw new Error("Evaluation storage cannot persist detached process PID.");
      }
      await prepared.storage.setRunProcessPid({ id: modelRun.run.id, pid: child.pid });
      child.once("error", (error) => {
        void failPreparedEvaluation(prepared.storage, [modelRun], `Detached Evaluation process failed: ${error.message}`);
      });
      child.unref();
      startedCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start detached Evaluation.";
      firstError ??= message;
      await failPreparedEvaluation(prepared.storage, [modelRun], message);
    }
  }
  return startedCount > 0
    ? { status: "started", evaluationInputId: prepared.evaluationInput.id }
    : { status: "failed", message: firstError ?? "Failed to start detached Evaluation." };
}

function spawnEvaluationCli(script: string, runId: string, cwd: string): ChildProcess {
  return nodeSpawn("npm", ["run", script, "--", `--run-id=${runId}`], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
}

export type EvaluationCancelResult =
  | { status: "cancelled" }
  | { status: "not_found" }
  | { status: "not_running" };

type CancellableRun = { id: string; status: string; processPid: number | null; startedAt: Date | string };

/**
 * 只按内部 evaluation_run_id 取消一个 detached process group。
 * SQL update 同时要求 status=running，避免自然完成的 success/failed 被迟到的 Cancel 覆盖。
 */
export async function cancelEvaluationRun(
  pool: Pick<Pool, "query">,
  evaluationRunId: string,
  options: { terminateGroup?: (pid: number) => void; now?: Date } = {},
): Promise<EvaluationCancelResult> {
  const found = await pool.query<CancellableRun>(
    `select id, status, process_pid as "processPid", started_at as "startedAt"
       from evaluation_runs where id = $1`,
    [evaluationRunId],
  );
  const run = found.rows[0];
  if (!run) return { status: "not_found" };
  if (run.status !== "running") return { status: "not_running" };

  if (run.processPid !== null) {
    try {
      (options.terminateGroup ?? terminateProcessGroup)(run.processPid);
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  }
  const now = options.now ?? new Date();
  const durationMs = Math.max(0, now.getTime() - new Date(run.startedAt).getTime());
  const cancelled = await pool.query(
    `update evaluation_runs
        set status = 'cancelled', completed_at = $2::timestamptz, duration_ms = $3,
            error = 'Cancelled by user.', process_pid = null
      where id = $1 and status = 'running'
      returning id`,
    [evaluationRunId, now.toISOString(), Number.isFinite(durationMs) ? durationMs : 0],
  );
  return cancelled.rows.length > 0 ? { status: "cancelled" } : { status: "not_running" };
}

function terminateProcessGroup(pid: number): void {
  // detached=true makes the CLI its own POSIX process-group leader; a negative PID targets npm, tsx and LLM descendants.
  process.kill(-pid, "SIGTERM");
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ESRCH";
}
