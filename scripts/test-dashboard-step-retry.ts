import { EventEmitter } from "node:events";
import { isDashboardRetryStep, startDashboardStepRetry } from "../src/lib/dashboard-step-retry.js";
import { resolveDailyScope } from "../src/lib/daily-scope.js";

class FakeChild extends EventEmitter { pid = 12_345; unrefCalled = false; unref() { this.unrefCalled = true; return this; } }

const calls: Array<{ script: string; env: NodeJS.ProcessEnv }> = [];
const pool = { query: async () => ({ rows: [{ exists: false }] }) } as never;
const currentDailyScope = resolveDailyScope(undefined);
const currentDailyDate = currentDailyScope.dailyDate;
const historicalDailyDate = currentDailyDate === "2026-09-14" ? "2026-09-13" : "2026-09-14";
const stage3 = await startDashboardStepRetry(pool, historicalDailyDate, "stage3", {
  rootDir: "/private/tmp/x-ai-field-retry",
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const stage4 = await startDashboardStepRetry(pool, historicalDailyDate, "stage4", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const currentStage1 = await startDashboardStepRetry(pool, currentDailyDate, "stage1", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const historicalStage1 = await startDashboardStepRetry(pool, historicalDailyDate, "stage1", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const historicalContent = await startDashboardStepRetry(pool, historicalDailyDate, "content_completion", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const alreadyRunningPool = { query: async () => ({ rows: [{ exists: true }] }) } as never;
const alreadyRunning = await startDashboardStepRetry(alreadyRunningPool, "2026-09-14", "stage3");

let invalidDateRejected = false;
try { await startDashboardStepRetry(pool, "not-a-date", "stage3"); } catch { invalidDateRejected = true; }

const checks = [
  ["Stage3 retry uses target daily_date, dashboard trigger, and only the fixed Stage3 CLI", stage3.status === "started" && calls[0]?.script === "process:stage3" && calls[0]?.env.DAILY_DATE === historicalDailyDate && calls[0]?.env.PIPELINE_TRIGGER_SOURCE === "dashboard" && !calls.some((call) => call.script === "process:stage4" && call !== calls[1])],
  ["Stage4 retry uses the fixed Stage4 CLI, preserving its existing DB-backed resume path", stage4.status === "started" && calls[1]?.script === "process:stage4" && calls[1]?.env.DAILY_DATE === historicalDailyDate],
  ["current Daily Stage1 retry preserves the 72h catch-up scope", currentStage1.status === "started" && calls[2]?.script === "process:stage1" && Date.parse(calls[2]?.env.DAILY_CATCHUP_SCOPE_END_AT ?? "") - Date.parse(calls[2]?.env.DAILY_CATCHUP_SCOPE_START_AT ?? "") === 72 * 60 * 60 * 1000],
  ["historical Daily Stage1 retry uses the strict 24h Daily scope", historicalStage1.status === "started" && calls[3]?.script === "process:stage1" && !calls[3]?.env.DAILY_CATCHUP_SCOPE_START_AT && Date.parse(calls[3]?.env.DAILY_PUBLISHED_SCOPE_END_AT ?? "") - Date.parse(calls[3]?.env.DAILY_PUBLISHED_SCOPE_START_AT ?? "") === 24 * 60 * 60 * 1000],
  ["historical Content Completion retry uses the strict 24h Daily scope", historicalContent.status === "started" && calls[4]?.script === "complete:content" && !calls[4]?.env.DAILY_CATCHUP_SCOPE_START_AT && Date.parse(calls[4]?.env.DAILY_PUBLISHED_SCOPE_END_AT ?? "") - Date.parse(calls[4]?.env.DAILY_PUBLISHED_SCOPE_START_AT ?? "") === 24 * 60 * 60 * 1000],
  ["an already running daily_date + step is rejected without a second spawn", alreadyRunning.status === "already_running"],
  ["invalid daily_date and non-allowlist steps are rejected", invalidDateRejected && !isDashboardRetryStep("npm run arbitrary")],
];
const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length) process.exitCode = 1;
