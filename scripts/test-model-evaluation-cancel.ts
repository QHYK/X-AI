/** Model Evaluation Cancel 的无外部依赖确定性测试。 */
import { evaluationApiUrl } from "../src/lib/evaluation-api-url.js";
import { cancelEvaluationRun } from "../src/lib/evaluation-background.js";
import { parseEvaluationCancelRequest } from "../src/lib/evaluation-request.js";

type Check = { name: string; passed: boolean };
type Run = { id: string; provider: string; status: string; processPid: number | null; startedAt: string };

const checks: Check[] = [];
const deepseekId = "11111111-1111-4111-8111-111111111111";
const kimiId = "22222222-2222-4222-8222-222222222222";
const successId = "33333333-3333-4333-8333-333333333333";
const runs = new Map<string, Run>([
  [deepseekId, { id: deepseekId, provider: "deepseek", status: "running", processPid: 41001, startedAt: "2026-08-28T00:00:00.000Z" }],
  [kimiId, { id: kimiId, provider: "kimi", status: "running", processPid: 41002, startedAt: "2026-08-28T00:00:00.000Z" }],
  [successId, { id: successId, provider: "deepseek", status: "success", processPid: null, startedAt: "2026-08-28T00:00:00.000Z" }],
]);
const terminated: number[] = [];
const pool = {
  async query(text: string, values?: unknown[]) {
    const id = values?.[0] as string;
    if (text.includes("select id, status")) return { rows: runs.has(id) ? [runs.get(id)] : [] };
    if (text.includes("set status = 'cancelled'")) {
      const run = runs.get(id);
      if (!run || run.status !== "running") return { rows: [] };
      run.status = "cancelled";
      run.processPid = null;
      return { rows: [{ id }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  },
};

const cancelled = await cancelEvaluationRun(pool as never, deepseekId, {
  now: new Date("2026-08-28T00:00:02.000Z"),
  terminateGroup: (pid) => terminated.push(pid),
});
checks.push({
  name: "A running run is cancelled durably by its evaluation_run_id and terminates only its process group",
  passed: cancelled.status === "cancelled" && runs.get(deepseekId)?.status === "cancelled" && terminated.join(",") === "41001",
});
checks.push({
  name: "Cancelling DeepSeek does not change Kimi's independent running run",
  passed: runs.get(kimiId)?.status === "running" && runs.get(kimiId)?.processPid === 41002,
});

const repeat = await cancelEvaluationRun(pool as never, deepseekId, { terminateGroup: (pid) => terminated.push(pid) });
const terminal = await cancelEvaluationRun(pool as never, successId, { terminateGroup: (pid) => terminated.push(pid) });
checks.push({
  name: "Cancelled, successful and failed-style terminal runs cannot be cancelled again or overwritten",
  passed: repeat.status === "not_running" && terminal.status === "not_running" && terminated.join(",") === "41001",
});

let raceStatus = "running";
const race = await cancelEvaluationRun({
  async query(text: string) {
    if (text.includes("select id, status")) return { rows: [{ id: kimiId, status: raceStatus, processPid: 42000, startedAt: "2026-08-28T00:00:00.000Z" }] };
    raceStatus = "success";
    return { rows: [] };
  },
} as never, kimiId, { terminateGroup() {} });
checks.push({
  name: "A natural completion racing with Cancel wins when the guarded running update no longer matches",
  passed: race.status === "not_running" && raceStatus === "success",
});

checks.push({
  name: "Cancel input accepts a stable UUID run_id only; PID is never an executable request parameter",
  passed: parseEvaluationCancelRequest({ run_id: kimiId, pid: 99999 }).runId === kimiId
    && throws(() => parseEvaluationCancelRequest({ pid: 99999 })),
});

const base = new URL("https://internal.example/ai/review/models");
checks.push({
  name: "Evaluation GET, Run and Cancel URLs retain the deployed basePath through relative addressing",
  passed: new URL(evaluationApiUrl("", new URLSearchParams({ date: "2026-08-28", stage: "stage1" })), base).pathname === "/ai/api/evaluation"
    && new URL(evaluationApiUrl("/run"), base).pathname === "/ai/api/evaluation/run"
    && new URL(evaluationApiUrl("/cancel"), base).pathname === "/ai/api/evaluation/cancel",
});

for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;

function throws(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}
