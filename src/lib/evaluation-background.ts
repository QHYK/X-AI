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

/** 启动固定的 npm evaluation script；输入 ID 来自已持久化的服务结果，不拼接用户 shell 命令。 */
export function startDetachedEvaluation(
  prepared: PreparedEvaluation,
  options: { rootDir?: string; spawn?: (script: string, inputId: string, cwd: string) => ChildProcess } = {},
): BackgroundEvaluationStartResult {
  const rootDir = options.rootDir ?? process.cwd();
  try {
    const child = (options.spawn ?? spawnEvaluationCli)(
      SCRIPT_BY_STAGE[prepared.stage],
      prepared.evaluationInput.id,
      rootDir,
    );
    child.once("error", (error) => {
      void failPreparedEvaluation(prepared.storage, prepared.models, `Failed to start detached Evaluation: ${error.message}`);
    });
    child.unref();
    return { status: "started", evaluationInputId: prepared.evaluationInput.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start detached Evaluation.";
    void failPreparedEvaluation(prepared.storage, prepared.models, message);
    return { status: "failed", message };
  }
}

function spawnEvaluationCli(script: string, inputId: string, cwd: string): ChildProcess {
  return nodeSpawn("npm", ["run", script, "--", `--input-id=${inputId}`], {
    cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
}
