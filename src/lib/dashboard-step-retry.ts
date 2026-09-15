/** Restricted, detached Dashboard retry launcher for one fixed Pipeline step. */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Pool } from "pg";
import { isCurrentWorkflowDailyDate, resolveCatchupPublishedAtScope, resolveDailyScope, toDailyScopeEnv } from "./daily-scope.js";

export const DASHBOARD_RETRY_STEPS = [
  "content_completion",
  "exact_duplicate_filter",
  "stage1",
  "stage2",
  "stage3",
  "stage4",
] as const;

export type DashboardRetryStep = typeof DASHBOARD_RETRY_STEPS[number];
type RetryResult = { status: "started" } | { status: "already_running" } | { status: "failed"; message: string };

const SCRIPT_BY_STEP: Record<DashboardRetryStep, string> = {
  content_completion: "complete:content",
  exact_duplicate_filter: "dedupe:stage1",
  stage1: "process:stage1",
  stage2: "process:stage2",
  stage3: "process:stage3",
  stage4: "process:stage4",
};

export function isDashboardRetryStep(value: string): value is DashboardRetryStep {
  return (DASHBOARD_RETRY_STEPS as readonly string[]).includes(value);
}

export async function startDashboardStepRetry(
  pool: Pool,
  dailyDate: string,
  step: DashboardRetryStep,
  options: { rootDir?: string; spawn?: (script: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess } = {},
): Promise<RetryResult> {
  const scope = resolveDailyScope(dailyDate);
  const running = await pool.query<{ exists: boolean }>(
    `select exists(select 1 from pipeline_runs where daily_date = $1::date and step = $2 and status = 'running') as exists`,
    [scope.dailyDate, step],
  );
  if (running.rows[0]?.exists) return { status: "already_running" };

  try {
    const rootDir = options.rootDir ?? process.cwd();
    const env: NodeJS.ProcessEnv = { ...process.env, ...toDailyScopeEnv(scope), PIPELINE_TRIGGER_SOURCE: "dashboard" };
    // A Dashboard retry always owns its scope. Do not let an environment left
    // over from a parent Daily process turn a historical retry into catch-up.
    delete env.DAILY_CATCHUP_SCOPE_START_AT;
    delete env.DAILY_CATCHUP_SCOPE_END_AT;
    if ((step === "content_completion" || step === "stage1") && isCurrentWorkflowDailyDate(scope.dailyDate)) {
      const catchup = resolveCatchupPublishedAtScope(scope);
      env.DAILY_CATCHUP_SCOPE_START_AT = catchup.startAt;
      env.DAILY_CATCHUP_SCOPE_END_AT = catchup.endAt;
    }
    const child = (options.spawn ?? spawnFixedStep)(SCRIPT_BY_STEP[step], rootDir, env);
    child.unref();
    return { status: "started" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : "Failed to start step." };
  }
}

export async function getDashboardStepRunStatus(pool: Pool, dailyDate: string, step: DashboardRetryStep): Promise<string | null> {
  const scope = resolveDailyScope(dailyDate);
  const result = await pool.query<{ status: string }>(
    `select status from pipeline_runs where daily_date = $1::date and step = $2 order by started_at desc, id desc limit 1`,
    [scope.dailyDate, step],
  );
  return result.rows[0]?.status ?? null;
}

function spawnFixedStep(script: string, cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  return nodeSpawn("npm", ["run", script], { cwd, env, detached: true, stdio: "ignore" });
}
