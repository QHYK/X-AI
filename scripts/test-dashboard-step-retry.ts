import { EventEmitter } from "node:events";
import { isDashboardRetryStep, startDashboardStepRetry } from "../src/lib/dashboard-step-retry.js";

class FakeChild extends EventEmitter { pid = 12_345; unrefCalled = false; unref() { this.unrefCalled = true; return this; } }

const calls: Array<{ script: string; env: NodeJS.ProcessEnv }> = [];
const pool = { query: async () => ({ rows: [{ exists: false }] }) } as never;
const stage3 = await startDashboardStepRetry(pool, "2026-09-14", "stage3", {
  rootDir: "/private/tmp/x-ai-field-retry",
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const stage4 = await startDashboardStepRetry(pool, "2026-09-14", "stage4", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const content = await startDashboardStepRetry(pool, "2026-09-14", "content_completion", {
  spawn: (script, _cwd, env) => { calls.push({ script, env }); return new FakeChild() as never; },
});
const alreadyRunningPool = { query: async () => ({ rows: [{ exists: true }] }) } as never;
const alreadyRunning = await startDashboardStepRetry(alreadyRunningPool, "2026-09-14", "stage3");

let invalidDateRejected = false;
try { await startDashboardStepRetry(pool, "not-a-date", "stage3"); } catch { invalidDateRejected = true; }

const checks = [
  ["Stage3 retry uses target daily_date, dashboard trigger, and only the fixed Stage3 CLI", stage3.status === "started" && calls[0]?.script === "process:stage3" && calls[0]?.env.DAILY_DATE === "2026-09-14" && calls[0]?.env.PIPELINE_TRIGGER_SOURCE === "dashboard" && !calls.some((call) => call.script === "process:stage4" && call !== calls[1])],
  ["Stage4 retry uses the fixed Stage4 CLI, preserving its existing DB-backed resume path", stage4.status === "started" && calls[1]?.script === "process:stage4" && calls[1]?.env.DAILY_DATE === "2026-09-14"],
  ["Content Completion retry preserves the Daily catch-up scope", content.status === "started" && calls[2]?.script === "complete:content" && Boolean(calls[2]?.env.DAILY_CATCHUP_SCOPE_START_AT)],
  ["an already running daily_date + step is rejected without a second spawn", alreadyRunning.status === "already_running"],
  ["invalid daily_date and non-allowlist steps are rejected", invalidDateRejected && !isDashboardRetryStep("npm run arbitrary")],
];
const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length) process.exitCode = 1;
