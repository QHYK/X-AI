import { EventEmitter } from "node:events";
import {
  buildFrozenEvaluationInput,
  executePreparedEvaluation,
  prepareEvaluation,
  reconstructStage1EvaluationInput,
  resumeEvaluation,
  type EvaluationStorage,
} from "../src/lib/model-evaluation.js";
import { hasRunningEvaluation, startDetachedEvaluation } from "../src/lib/evaluation-background.js";
import { getEvaluationReviewData } from "../src/lib/evaluation-review.js";

type Check = { name: string; passed: boolean };
const checks: Check[] = [];

class FakeChildProcess extends EventEmitter {
  constructor(readonly pid: number) { super(); }
  unrefCalled = false;
  unref() { this.unrefCalled = true; return this; }
}

const storageState = createStorage();
const prepared = await prepareEvaluation({
  pool: {} as never,
  date: "2026-08-28",
  stage: "stage1",
  models: [{ provider: "deepseek", model: "fixture-deepseek" }, { provider: "kimi", model: "fixture-kimi" }],
  storage: storageState.storage,
  buildFrozenInput: async () => ({
    source: "raw_articles",
    raw_article_ids: ["raw-1", "raw-2"],
    batch_config: { batchSize: 8, batchMaxContentChars: 12_000, batchMaxTotalChars: 40_000 },
  }),
});
checks.push({
  name: "Trigger preparation persists one comparison input and all model runs as running before detached execution",
  passed: storageState.inputs.length === 1 && storageState.runs.length === 2 && storageState.runs.every((run) => run.evaluationInputId === prepared.evaluationInput.id),
});
checks.push({
  name: "Stage 1 persisted input retains only Raw Article identity and batch configuration, never article content",
  passed: JSON.stringify(storageState.inputs[0]?.inputJson).includes("raw_article_ids") && !JSON.stringify(storageState.inputs[0]?.inputJson).includes("content_text"),
});

const spawnedChildren = [new FakeChildProcess(41001), new FakeChildProcess(41002)];
const children = [...spawnedChildren];
const started = await startDetachedEvaluation(prepared, { spawn: () => children.shift() as never });
checks.push({
  name: "Detached starter gives every model an independent detached process and returns before Evaluation execution",
  passed: started.status === "started" && children.length === 0 && storageState.processPids.length === 2 && spawnedChildren.every((child) => child.unrefCalled),
});

const executionPrepared = await prepareEvaluation({
  pool: {} as never,
  date: "2026-08-28",
  stage: "stage2",
  models: [{ provider: "deepseek", model: "fixture-deepseek" }, { provider: "kimi", model: "fixture-kimi" }],
  storage: storageState.storage,
  buildFrozenInput: async () => ({ input: { event_candidates: [] }, id_map: {} }),
});
const execution = await executePreparedEvaluation({
  ...executionPrepared,
  execute: async ({ model }) => {
    if (model.provider === "kimi") throw new Error("fixture model failure");
    return { outputs: [{ itemKey: "batch-001", outputJson: { results: [] } }], inputTokens: 3, outputTokens: 2 };
  },
});
checks.push({
  name: "One background model failure persists failed while another run completes successfully",
  passed: execution.runs.some((run) => run.provider === "deepseek" && run.status === "success")
    && execution.runs.some((run) => run.provider === "kimi" && run.status === "failed")
    && storageState.completed.length === 1 && storageState.failed.length === 1,
});

const resumeState = createStorage();
resumeState.input = { id: "resume-input", dailyDate: "2026-08-28", stage: "stage2", inputJson: { input: { event_candidates: [] }, id_map: {} }, inputHash: "fixture" };
resumeState.pending = [{ id: "resume-run", evaluationInputId: "resume-input", provider: "deepseek", model: "fixture", startedAt: "2026-08-28T00:00:00.000Z" }];
const resumed = await resumeEvaluation({
  pool: {} as never,
  evaluationInputId: "resume-input",
  storage: resumeState.storage,
  execute: async () => ({ outputs: [{ itemKey: null, outputJson: { events: [] } }], inputTokens: null, outputTokens: null }),
});
checks.push({
  name: "A persisted running run can be resumed independently of the original HTTP request",
  passed: resumed.runs[0]?.status === "success" && resumeState.completed.includes("resume-run"),
});

const stage1Rows = [article("raw-1", "First"), article("raw-2", "Second")];
const stage1Pool = {
  query: async () => ({ rows: stage1Rows }),
};
const stage1Reference = await buildFrozenEvaluationInput({ pool: stage1Pool as never, date: "2026-08-28", stage: "stage1", rootDir: process.cwd() }) as { raw_article_ids?: string[]; batch_config?: unknown };
const stage1Rebuilt = await reconstructStage1EvaluationInput(stage1Pool as never, stage1Reference as never);
checks.push({
  name: "Stage 1 rebuilds the existing production-shaped micro-batches from the same Daily Raw Article identity",
  passed: stage1Reference.raw_article_ids?.join(",") === "raw-1,raw-2" && stage1Rebuilt.batches.length === 1 && stage1Rebuilt.batches[0]?.input.articles.length === 2,
});

const running = await hasRunningEvaluation({ query: async () => ({ rows: [{ value: 1 }] }) } as never, "2026-08-28", "stage1");
const idle = await hasRunningEvaluation({ query: async () => ({ rows: [] }) } as never, "2026-08-28", "stage1");
checks.push({
  name: "A visible running Evaluation prevents an accidental duplicate trigger for the same Daily and Stage",
  passed: running && !idle,
});

const runningReview = await getEvaluationReviewData({
  query: async (text: string) => {
    if (text.includes("from evaluation_inputs")) {
      return { rows: [{ id: "running-input", dailyDate: "2026-08-28", stage: "stage2", inputJson: { input: { event_candidates: [] }, id_map: {} }, inputHash: "fixture", createdAt: "2026-08-28T00:00:00.000Z" }] };
    }
    if (text.includes("from evaluation_runs")) {
      return { rows: [{ id: "running-run", provider: "deepseek", model: "fixture", status: "running", error: null, startedAt: "2026-08-28T00:00:00.000Z", completedAt: null, durationMs: null, inputTokens: null, outputTokens: null }] };
    }
    throw new Error("No outputs are queried while every model is running.");
  },
} as never, "2026-08-28", "stage2");
checks.push({
  name: "Read API data exposes persisted running state after a page reload",
  passed: runningReview.runs[0]?.status === "running" && runningReview.stage2?.length === 0,
});

const cancelledReview = await getEvaluationReviewData({
  query: async (text: string) => {
    if (text.includes("from evaluation_inputs")) {
      return { rows: [{ id: "cancelled-input", dailyDate: "2026-08-28", stage: "stage2", inputJson: { input: { event_candidates: [] }, id_map: {} }, inputHash: "fixture", createdAt: "2026-08-28T00:00:00.000Z" }] };
    }
    if (text.includes("from evaluation_runs")) {
      return { rows: [{ id: "cancelled-run", provider: "deepseek", model: "fixture", status: "cancelled", error: "Cancelled by user.", startedAt: "2026-08-28T00:00:00.000Z", completedAt: "2026-08-28T00:00:02.000Z", durationMs: 2_000, inputTokens: null, outputTokens: null }] };
    }
    throw new Error("No outputs are queried for a cancelled run.");
  },
} as never, "2026-08-28", "stage2");
checks.push({
  name: "Read API data retains a persisted cancelled run after a page reload",
  passed: cancelledReview.runs[0]?.status === "cancelled" && cancelledReview.runs[0]?.completedAt !== null,
});

for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
if (checks.some((check) => !check.passed)) process.exitCode = 1;

function article(id: string, title: string) {
  return {
    id,
    title,
    url: null,
    author: null,
    contentText: `${title} content`,
    publishedAt: new Date("2026-08-27T03:00:00.000Z"),
    sourceTags: null,
    sourceName: "Fixture Source",
    sourceCategory: "Technology",
    sourceType: null,
    sourcePriority: "High",
    eventCandidate: true,
    sourceDigestCandidate: true,
    sourceAvailability: null,
    sourceLanguage: "en",
  };
}

function createStorage(): {
  storage: EvaluationStorage;
  inputs: Array<{ id: string; dailyDate: string; stage: "stage1" | "stage2"; inputJson: unknown; inputHash: string }>;
  runs: Array<{ id: string; evaluationInputId: string }>;
  completed: string[];
  failed: string[];
  input: { id: string; dailyDate: string; stage: "stage2"; inputJson: unknown; inputHash: string } | null;
  pending: Array<{ id: string; evaluationInputId: string; provider: string; model: string; startedAt: string }>;
  processPids: Array<{ id: string; pid: number }>;
} {
  const inputs: Array<{ id: string; dailyDate: string; stage: "stage1" | "stage2"; inputJson: unknown; inputHash: string }> = [];
  const runs: Array<{ id: string; evaluationInputId: string }> = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const processPids: Array<{ id: string; pid: number }> = [];
  const state = {
    inputs,
    runs,
    completed,
    failed,
    processPids,
    input: null as { id: string; dailyDate: string; stage: "stage2"; inputJson: unknown; inputHash: string } | null,
    pending: [] as Array<{ id: string; evaluationInputId: string; provider: string; model: string; startedAt: string }>,
    storage: undefined as unknown as EvaluationStorage,
  };
  let inputNumber = 1;
  let runNumber = 1;
  state.storage = {
    async createInput(input) {
      const created = { id: `input-${inputNumber++}`, ...input };
      inputs.push(created as typeof inputs[number]);
      return created;
    },
    async createRun(input) {
      const run = { id: `run-${runNumber++}`, evaluationInputId: input.evaluationInputId };
      runs.push(run);
      return run;
    },
    async completeRun(input) { completed.push(input.id); },
    async failRun(input) { failed.push(input.id); },
    async setRunProcessPid(input) { processPids.push(input); },
    async createOutputs() {},
    async loadInput() { return state.input; },
    async loadRunningRuns() { return state.pending; },
  };
  return state;
}
