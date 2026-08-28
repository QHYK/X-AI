import {
  createPostgresEvaluationStorage,
  buildFrozenEvaluationInput,
  hashEvaluationInput,
  runEvaluation,
  type EvaluationStorage,
} from "../src/lib/model-evaluation.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveEvaluationModels } from "../src/lib/evaluation-model-config.js";
import { parseEvaluationCliArguments } from "./run-model-evaluation.js";

type Check = { name: string; passed: boolean; detail?: unknown };
const checks: Check[] = [];

checks.push({
  name: "Frozen Input hash is stable across object key order and changes with content",
  passed:
    hashEvaluationInput({ nested: { b: 2, a: 1 }, list: ["x"] }) ===
      hashEvaluationInput({ list: ["x"], nested: { a: 1, b: 2 } }) &&
    hashEvaluationInput({ list: ["y"], nested: { a: 1, b: 2 } }) !==
      hashEvaluationInput({ list: ["x"], nested: { a: 1, b: 2 } }),
});

const runtimeRoot = await mkdtemp(join(tmpdir(), "x-ai-field-evaluation-runtime-"));
try {
  await writeJson(join(runtimeRoot, "runtime", "daily", "fixture", "run.json"), {
    daily_date: "2026-08-28",
    stage3_run: "runtime/stage3/from-daily-lineage",
  });
  await writeJson(join(runtimeRoot, "runtime", "stage3", "from-daily-lineage", "run.json"), {
    status: "success",
    daily_date: "2026-08-28",
  });
  await writeJson(join(runtimeRoot, "runtime", "stage3", "from-daily-lineage", "events", "input.json"), {
    events: [],
  });
  await writeJson(join(runtimeRoot, "runtime", "stage3", "newer-global", "run.json"), {
    status: "success",
    daily_date: "2026-08-28",
  });
  await writeJson(join(runtimeRoot, "runtime", "stage3", "newer-global", "events", "input.json"), {
    events: [{ id: "wrong" }],
  });
  const frozenStage3 = await buildFrozenEvaluationInput({
    pool: {} as never,
    date: "2026-08-28",
    stage: "stage3_event",
    rootDir: runtimeRoot,
  }) as { source_stage3_run?: string; input?: { events?: unknown[] } };
  checks.push({
    name: "Stage 3 Evaluation follows the Daily runtime lineage before global latest fallback",
    passed:
      frozenStage3.source_stage3_run?.endsWith("runtime/stage3/from-daily-lineage") === true &&
      frozenStage3.input?.events?.length === 0,
  });
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

const sqlLog: string[] = [];
const postgresStorage = createPostgresEvaluationStorage({
  query: async (text: string) => {
    sqlLog.push(text);
    if (text.includes("insert into evaluation_inputs")) {
      return { rows: [{ id: "db-input", dailyDate: "2026-08-28", stage: "stage1", inputJson: {}, inputHash: "hash" }] };
    }
    if (text.includes("insert into evaluation_runs")) {
      return { rows: [{ id: "db-run" }] };
    }
    return { rows: [] };
  },
} as never);
await runEvaluation({
  pool: {} as never,
  date: "2026-08-28",
  stage: "stage1",
  models: [{ provider: "deepseek", model: "fixture" }],
  storage: postgresStorage,
  buildFrozenInput: async () => ({ batches: [] }),
  execute: async () => ({
    outputs: [{ itemKey: "batch-001", outputJson: { results: [] } }],
    inputTokens: null,
    outputTokens: null,
  }),
});
checks.push({
  name: "Evaluation persistence never writes Production tables",
  passed:
    sqlLog.length > 0 &&
    sqlLog.every((text) => /evaluation_(inputs|runs|outputs)/.test(text)) &&
    !sqlLog.some((text) => /processed_contents|event_review_items|\bevents\b|feedback|ai_rank|display_rank/i.test(text)),
  detail: sqlLog,
});

const storageState = createStorage();
const summary = await runEvaluation({
  pool: {} as never,
  date: "2026-08-28",
  stage: "stage2",
  models: [
    { provider: "deepseek", model: "fixture-deepseek" },
    { provider: "kimi", model: "fixture-kimi" },
  ],
  storage: storageState.storage,
  buildFrozenInput: async () => ({ input: { event_candidates: [{ temp_id: "E001" }] } }),
  execute: async ({ model }) => {
    if (model.provider === "kimi") {
      throw new Error("fixture model failure");
    }
    return {
      outputs: [{ itemKey: null, outputJson: { events: [{ event_hint: "Fixture", sources: ["E001"] }] } }],
      inputTokens: 11,
      outputTokens: 7,
    };
  },
});

checks.push({
  name: "DeepSeek and Kimi runs share one evaluation_input_id",
  passed:
    storageState.runs.length === 2 &&
    storageState.runs.every((run) => run.evaluationInputId === summary.evaluationInputId),
});
checks.push({
  name: "Successful run persists only Evaluation output and metadata",
  passed:
    storageState.completed.length === 1 &&
    storageState.outputs.length === 1 &&
    storageState.outputs[0]?.outputJson !== null &&
    storageState.productionWrites === 0,
});
checks.push({
  name: "One model failure is recorded without rolling back another model output",
  passed:
    summary.runs.find((run) => run.provider === "deepseek")?.status === "success" &&
    summary.runs.find((run) => run.provider === "kimi")?.status === "failed" &&
    storageState.failed.length === 1 &&
    storageState.outputs.length === 1,
});

const previousDeepSeekModel = process.env.DEEPSEEK_MODEL;
process.env.DEEPSEEK_MODEL = "fixture-deepseek-from-env";
const configured = resolveEvaluationModels({ provider: "deepseek" });
if (previousDeepSeekModel === undefined) {
  delete process.env.DEEPSEEK_MODEL;
} else {
  process.env.DEEPSEEK_MODEL = previousDeepSeekModel;
}
checks.push({
  name: "Evaluation model config uses the shared provider model environment",
  passed: configured[0]?.model === "fixture-deepseek-from-env",
});

const parsed = parseEvaluationCliArguments([
  "--date=2026-08-28",
  "--stage=stage3_event",
  "--provider=kimi",
]);
checks.push({
  name: "CLI parsing supplies stage/date to the reusable Evaluation service boundary",
  passed: parsed.date === "2026-08-28" && parsed.stage === "stage3_event" && parsed.provider === "kimi",
});

for (const check of checks) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
  if (!check.passed && check.detail) {
    console.error(check.detail);
  }
}
if (checks.some((check) => !check.passed)) {
  process.exitCode = 1;
}

function createStorage(): {
  storage: EvaluationStorage;
  runs: Array<{ id: string; evaluationInputId: string }>;
  completed: string[];
  failed: string[];
  outputs: Array<{ evaluationRunId: string; itemKey: string | null; outputJson: unknown }>;
  productionWrites: number;
} {
  const runs: Array<{ id: string; evaluationInputId: string }> = [];
  const completed: string[] = [];
  const failed: string[] = [];
  const outputs: Array<{ evaluationRunId: string; itemKey: string | null; outputJson: unknown }> = [];
  let nextRun = 1;
  return {
    runs,
    completed,
    failed,
    outputs,
    productionWrites: 0,
    storage: {
      async createInput(input) {
        return { id: "input-1", ...input };
      },
      async createRun(input) {
        const run = { id: `run-${nextRun++}`, evaluationInputId: input.evaluationInputId };
        runs.push(run);
        return run;
      },
      async completeRun(input) {
        completed.push(input.id);
      },
      async failRun(input) {
        failed.push(input.id);
      },
      async createOutputs(value) {
        outputs.push(...value);
      },
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}
