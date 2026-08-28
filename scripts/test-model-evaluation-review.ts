import {
  getEvaluationReviewData,
  normalizeStage1Evaluation,
  normalizeStage2Evaluation,
  normalizeStage3Evaluation,
  type EvaluationRunView,
} from "../src/lib/evaluation-review.js";
import { startEvaluationFromRequest } from "../src/lib/evaluation-request.js";
import type { EvaluationModel } from "../src/lib/evaluation-model-config.js";
import type { EvaluationSummary } from "../src/lib/model-evaluation.js";

type Check = { name: string; passed: boolean };
const checks: Check[] = [];
const deepseek = run("deepseek-run", "deepseek");
const kimi = run("kimi-run", "kimi");
const outputMap = new Map([
  ["deepseek-run", [{ evaluationRunId: "deepseek-run", itemKey: "batch-001", outputJson: { results: [{ temp_id: "A001", routing: "Event", category: "Company", generated_content: { title_zh: "甲", summary_zh: "不同摘要 A" } }] } }]],
  ["kimi-run", [{ evaluationRunId: "kimi-run", itemKey: "batch-001", outputJson: { results: [{ temp_id: "A001", routing: "Event", category: "Technology", generated_content: { title_zh: "乙", summary_zh: "不同摘要 B" } }] } }]],
]);
const stage1 = normalizeStage1Evaluation({
  batches: [{ item_key: "batch-001", input: { articles: [{ temp_id: "A001", title: "Original article", source_name: "Fixture News" }] } }],
}, [deepseek, kimi], outputMap);
checks.push({
  name: "Stage 1 marks routing/category differences, but summary text alone is not a routing disagreement",
  passed: stage1[0]?.routingDisagreement === false && stage1[0]?.categoryDisagreement === true,
});

const stage2 = normalizeStage2Evaluation({
  input: { event_candidates: [
    { temp_id: "E001", title: "Article A", source: "Source A" },
    { temp_id: "E002", title: "Article B", source: "Source B" },
    { temp_id: "E003", title: "Article C", source: "Source C" },
  ] },
}, [deepseek, kimi], new Map([
  ["deepseek-run", [{ evaluationRunId: "deepseek-run", itemKey: null, outputJson: { events: [{ event_hint: "A and B", sources: ["E001", "E002"] }, { event_hint: "C", sources: ["E003"] }] } }]],
  ["kimi-run", [{ evaluationRunId: "kimi-run", itemKey: null, outputJson: { events: [{ event_hint: "A", sources: ["E001"] }, { event_hint: "B and C", sources: ["E002", "E003"] }] } }]],
]));
checks.push({
  name: "Stage 2 resolves temp_id back to frozen article titles and counts groups/singletons without group-index matching",
  passed: stage2[0]?.groups[0]?.articles[1]?.title === "Article B" && stage2[0]?.groupCount === 2 && stage2[0]?.singletonCount === 1 && stage2[1]?.groups[1]?.articles[1]?.title === "Article C",
});

const eventRanking = normalizeStage3Evaluation("stage3_event", {
  input: { events: [{ id: "EV-A", event_hint: "Event A" }, { id: "EV-B", event_hint: "Event B" }] },
}, [deepseek, kimi], new Map([
  ["deepseek-run", [{ evaluationRunId: "deepseek-run", itemKey: null, outputJson: { ordered_ids: ["EV-A", "EV-B"] } }]],
  ["kimi-run", [{ evaluationRunId: "kimi-run", itemKey: null, outputJson: { ordered_ids: ["EV-B", "EV-A"] } }]],
]));
checks.push({
  name: "Stage 3 Event aligns stable identifiers and sorts by absolute rank delta with Top 15 membership",
  passed: eventRanking[0]?.id === "EV-A" && eventRanking[0]?.delta === 1 && eventRanking[0]?.topProviders.length === 2 && eventRanking[0]?.topCutoff === 15,
});

const digestRanking = normalizeStage3Evaluation("stage3_digest", {
  inputs: [
    { item_key: "Company", input: { category: "Company", candidates: [{ id: "D1", title: "Company item", source: "S1" }] } },
    { item_key: "Science", input: { category: "Science", candidates: [{ id: "D2", title: "Science item", source: "S2" }] } },
  ],
}, [deepseek, kimi], new Map([
  ["deepseek-run", [
    { evaluationRunId: "deepseek-run", itemKey: "Company", outputJson: { rankings: [{ id: "D1", rank: 1 }] } },
    { evaluationRunId: "deepseek-run", itemKey: "Science", outputJson: { rankings: [{ id: "D2", rank: 1 }] } },
  ]],
  ["kimi-run", [
    { evaluationRunId: "kimi-run", itemKey: "Company", outputJson: { rankings: [{ id: "D1", rank: 1 }] } },
    { evaluationRunId: "kimi-run", itemKey: "Science", outputJson: { rankings: [{ id: "D2", rank: 1 }] } },
  ]],
]));
checks.push({
  name: "Stage 3 Digest keeps categories separate",
  passed: digestRanking.find((item) => item.id === "D1")?.category === "Company" && digestRanking.find((item) => item.id === "D2")?.category === "Science",
});

const sqlLog: Array<{ text: string; values: unknown[] | undefined }> = [];
const loaded = await getEvaluationReviewData({
  query: async (text: string, values?: unknown[]) => {
    sqlLog.push({ text, values });
    if (text.includes("from evaluation_inputs")) {
      return { rows: [{ id: "latest-input", dailyDate: "2026-08-28", stage: "stage2", inputJson: { input: { event_candidates: [] } }, inputHash: "latest", createdAt: "2026-08-28T00:00:00.000Z" }] };
    }
    if (text.includes("from evaluation_runs")) {
      return { rows: [
        { ...deepseek, id: "latest-deepseek", status: "success" },
        { ...kimi, id: "latest-kimi", status: "failed", error: "fixture failure" },
      ] };
    }
    if (text.includes("from evaluation_outputs")) {
      return { rows: [{ evaluationRunId: "latest-deepseek", itemKey: null, outputJson: { events: [] } }] };
    }
    throw new Error("Unexpected query");
  },
} as never, "2026-08-28", "stage2");
checks.push({
  name: "Read API data uses the newest single Frozen Input and retains a failed model beside a successful result",
  passed: loaded.input?.id === "latest-input" && loaded.runs.length === 2 && loaded.runs.some((item) => item.status === "failed") && sqlLog.find((entry) => entry.text.includes("from evaluation_runs"))?.values?.[0] === "latest-input",
});
checks.push({
  name: "Evaluation review queries only evaluation tables",
  passed: sqlLog.every((entry) => /evaluation_(inputs|runs|outputs)/.test(entry.text)) && !sqlLog.some((entry) => /processed_contents|event_review_items|\bevents\b|feedback/i.test(entry.text)),
});

let invocation: { date: string; stage: string; models: EvaluationModel[] } | null = null;
const summary: EvaluationSummary = { evaluationInputId: "input", inputHash: "hash", dailyDate: "2026-08-28", stage: "stage1", runs: [] };
await startEvaluationFromRequest({
  pool: {} as never,
  body: { date: "2026-08-28", stage: "stage1", providers: ["deepseek"] },
  availableModels: [{ provider: "deepseek", model: "fixture" }, { provider: "kimi", model: "fixture" }],
  run: async (options) => {
    invocation = { date: options.date, stage: options.stage, models: options.models };
    return summary;
  },
});
checks.push({
  name: "Run API request delegates date, stage and selected configured model to the existing Evaluation service",
  passed: (invocation as { date: string; stage: string; models: EvaluationModel[] } | null)?.date === "2026-08-28"
    && (invocation as { date: string; stage: string; models: EvaluationModel[] } | null)?.stage === "stage1"
    && (invocation as { date: string; stage: string; models: EvaluationModel[] } | null)?.models[0]?.provider === "deepseek",
});

for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;

function run(id: string, provider: string): EvaluationRunView {
  return {
    id,
    provider,
    model: `${provider}-fixture`,
    status: "success",
    error: null,
    startedAt: "2026-08-28T00:00:00.000Z",
    completedAt: "2026-08-28T00:00:01.000Z",
    durationMs: 1_000,
    inputTokens: null,
    outputTokens: null,
  };
}
