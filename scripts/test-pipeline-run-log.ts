import type { Pool } from "pg";
import { getDashboardData } from "../src/lib/dashboard.js";
import { finishPipelineRun, startPipelineRun } from "../src/processing/pipeline-run-log.js";

type Row = { id: string; daily_date: string; step: string; status: string; trigger_source: string; metrics: Record<string, unknown>; error_summary: string | null; started_at: string; finished_at: string | null; provider: string | null; model: string | null };
const rows: Row[] = [];
let nextId = 1;
const pool = {
  query: async (text: string, values?: unknown[]) => {
    if (text.includes("insert into pipeline_runs")) {
      const id = `run-${nextId++}`;
      rows.push({ id, daily_date: values?.[0] as string, step: values?.[1] as string, status: "running", trigger_source: values?.[2] as string, started_at: values?.[3] as string, finished_at: null, provider: null, model: null, metrics: {}, error_summary: null });
      return { rows: [{ id }] };
    }
    if (text.includes("update pipeline_runs")) {
      const row = rows.find((item) => item.id === values?.[0]);
      if (row) { row.status = values?.[1] as string; row.provider = values?.[2] as string | null; row.model = values?.[3] as string | null; row.finished_at = values?.[4] as string; row.metrics = JSON.parse(values?.[5] as string); row.error_summary = values?.[6] as string | null; }
      return { rows: [] };
    }
    return { rows: [] };
  },
} as unknown as Pool;

const started = new Date("2026-09-07T01:00:00.000Z");
const successId = await startPipelineRun(pool, { dailyDate: "2026-09-07", step: "stage1", triggerSource: "standalone", startedAt: started });
await finishPipelineRun(pool, successId, { status: "success", model: "model-a", metrics: { llm_calls: 3 }, finishedAt: new Date("2026-09-07T01:01:00.000Z") });
const failedId = await startPipelineRun(pool, { dailyDate: "2026-09-07", step: "stage2", triggerSource: "daily_orchestrator", startedAt: new Date("2026-09-07T02:00:00.000Z") });
await finishPipelineRun(pool, failedId, { status: "failed", errorSummary: "provider unavailable" });
const partialId = await startPipelineRun(pool, { dailyDate: "2026-09-07", step: "stage4", triggerSource: "daily_orchestrator", startedAt: new Date("2026-09-07T03:00:00.000Z") });
await finishPipelineRun(pool, partialId, { status: "partial", metrics: { ready_count: 6, draft_count: 6, failed_count: 1 } });

const dashboardRows: Row[] = [
  { id: "old", daily_date: "2026-08-24", step: "stage1", status: "success", trigger_source: "standalone", started_at: "2026-08-24T01:00:00.000Z", finished_at: "2026-08-24T01:01:00.000Z", provider: "openai", model: "old", metrics: { llm_calls: 1 }, error_summary: null },
  { id: "new", daily_date: "2026-08-24", step: "stage1", status: "failed", trigger_source: "dashboard", started_at: "2026-08-24T02:00:00.000Z", finished_at: "2026-08-24T02:01:00.000Z", provider: "openai", model: "new", metrics: { llm_calls: 2 }, error_summary: "failed" },
  { id: "stage3", daily_date: "2026-08-24", step: "stage3", status: "success", trigger_source: "daily_orchestrator", started_at: "2026-08-24T03:00:00.000Z", finished_at: "2026-08-24T03:01:00.000Z", provider: "openai", model: "stage3-model", metrics: { prompt_versions: { event: "event-v3", digest: "digest-v3", long_form: "long-v1" }, input_tokens: 120, output_tokens: 30, total_tokens: 150 }, error_summary: null },
  { id: "stage4", daily_date: "2026-08-24", step: "stage4", status: "success", trigger_source: "daily_orchestrator", started_at: "2026-08-24T04:00:00.000Z", finished_at: "2026-08-24T04:02:00.000Z", provider: "openai", model: "stage4-model", metrics: { prompt_version: "stage4-v7", llm_duration_ms: 98_000, input_tokens: 300, output_tokens: 70, total_tokens: 370, web_search_event_count: 0, total_web_search_calls: 0 }, error_summary: null },
];
const dashboard = await getDashboardData(createDashboardPool(dashboardRows), { now: new Date("2026-08-24T16:00:00.000Z"), rootDir: "/private/tmp/x-ai-field-no-runtime" });
const latestStage1 = dashboard.days[0]?.runtime.stages.stage1;
const latestStage3 = dashboard.days[0]?.runtime.stages.stage3;
const latestStage4 = dashboard.days[0]?.runtime.stages.stage4;

const checks = [
  ["start → success updates one row", rows.length === 3 && rows[0]?.status === "success" && rows[0]?.metrics.llm_calls === 3],
  ["failed stores error summary", rows[1]?.status === "failed" && rows[1]?.error_summary === "provider unavailable"],
  ["Stage4 partial stores durable partial metrics", rows[2]?.status === "partial" && rows[2]?.metrics.ready_count === 6 && rows[2]?.metrics.draft_count === 6 && rows[2]?.metrics.failed_count === 1],
  ["trigger sources retain standalone and daily_orchestrator", rows[0]?.trigger_source === "standalone" && rows[1]?.trigger_source === "daily_orchestrator"],
  ["Dashboard chooses latest DB attempt, including failed status", latestStage1?.status === "failed" && latestStage1.model === "new" && latestStage1.llmCalls === 2],
  ["Dashboard maps all three Stage3 prompt versions and aggregated token usage from pipeline metrics", latestStage3?.promptVersions?.event === "event-v3" && latestStage3.promptVersions?.digest === "digest-v3" && latestStage3.promptVersions?.longForm === "long-v1" && latestStage3.inputTokens === 120 && latestStage3.outputTokens === 30 && latestStage3.totalTokens === 150],
  ["Dashboard maps Stage4 prompt, LLM duration, token usage, and explicit zero Web Search metrics from pipeline metrics", latestStage4?.promptVersion === "stage4-v7" && latestStage4.llmDurationMs === 98_000 && latestStage4.inputTokens === 300 && latestStage4.outputTokens === 70 && latestStage4.totalTokens === 370 && latestStage4.webSearchEventCount === 0 && latestStage4.totalWebSearchCalls === 0],
];
const failures = checks.filter(([, passed]) => !passed);
console.log(JSON.stringify({ success: failures.length === 0, checks }, null, 2));
if (failures.length) process.exitCode = 1;

function createDashboardPool(pipelineRows: Row[]): Pool {
  return { query: (async (text: string) => {
    if (text.includes("from pipeline_runs")) return { rows: pipelineRows };
    if (text.includes("as raw_articles")) return { rows: [{ raw_articles: 0, processed_contents: 0, events: 0 }] };
    if (text.includes("as raw_chars")) return { rows: [{ raw_chars: 0, selected_chars: 0 }] };
    if (text.includes("as processed_summary_chars")) return { rows: [{ processed_summary_chars: 0 }] };
    return { rows: [] };
  }) as Pool["query"] } as Pool;
}
