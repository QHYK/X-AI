/**
 * Stage 1–3 离线模型评测服务。
 * 一次构造并持久化冻结输入，再让多个模型独立复用它；本模块只写 Evaluation 三张表。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Pool } from "pg";
import { resolveDailyScope } from "./daily-scope.js";
import { type EvaluationModel } from "./evaluation-model-config.js";
import { STAGE1_PROMPT_VERSION } from "../prompts/stage1-content-understanding.js";
import { STAGE2_PROMPT_VERSION } from "../prompts/stage2-event-merge.js";
import { STAGE3_DIGEST_RANKING_PROMPT_VERSION, type Stage3DigestRankingInput } from "../prompts/stage3-digest-ranking.js";
import { STAGE3_EVENT_RANKING_PROMPT_VERSION } from "../prompts/stage3-event-ranking.js";
import { STAGE3_LONG_FORM_RANKING_PROMPT_VERSION, type Stage3LongFormRankingInput } from "../prompts/stage3-long-form-ranking.js";
import { buildStage1BatchInput, type Stage1BatchInput } from "../processing/stage1-contract.js";
import {
  createStage1MicroBatches,
  loadStage1EvaluationArticles,
  resolveStage1BatchConfig,
} from "../processing/stage1-job.js";
import { runStage1BatchLlmForInput } from "../processing/stage1-llm.js";
import { prepareStage2Input, loadStage2EventCandidates, type Stage2IdMap, type Stage2Input } from "../processing/stage2-candidates.js";
import {
  validateStage2Assignments,
  validateStage2Output,
} from "../processing/stage2-contract.js";
import { runStage2MergeLlm } from "../processing/stage2-llm.js";
import { runStage3DigestRankingLlm } from "../processing/stage3-digest-ranking-llm.js";
import { runStage3EventRankingLlm } from "../processing/stage3-event-ranking-llm.js";
import { runStage3LongFormRankingLlm } from "../processing/stage3-long-form-ranking-llm.js";
import type { Stage3EventRankingInput } from "../processing/stage3-contract.js";

export const EVALUATION_STAGES = [
  "stage1",
  "stage2",
  "stage3_event",
  "stage3_digest",
  "stage3_long_form",
] as const;

export type EvaluationStage = (typeof EVALUATION_STAGES)[number];

export type EvaluationInputRecord = {
  id: string;
  dailyDate: string;
  stage: EvaluationStage;
  inputJson: unknown;
  inputHash: string;
};

export type EvaluationRunRecord = { id: string };

export type EvaluationStorage = {
  createInput(input: Omit<EvaluationInputRecord, "id">): Promise<EvaluationInputRecord>;
  createRun(input: {
    evaluationInputId: string;
    provider: string;
    model: string;
    promptVersion: string;
    startedAt: string;
  }): Promise<EvaluationRunRecord>;
  completeRun(input: {
    id: string;
    completedAt: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
  }): Promise<void>;
  failRun(input: { id: string; completedAt: string; durationMs: number; error: string }): Promise<void>;
  createOutputs(outputs: Array<{ evaluationRunId: string; itemKey: string | null; outputJson: unknown }>): Promise<void>;
};

export type EvaluationRunSummary = {
  provider: string;
  model: string;
  runId: string;
  status: "success" | "failed";
  error: string | null;
};

export type EvaluationSummary = {
  evaluationInputId: string;
  inputHash: string;
  dailyDate: string;
  stage: EvaluationStage;
  runs: EvaluationRunSummary[];
};

type EvaluationOutput = {
  itemKey: string | null;
  outputJson: unknown;
};

type EvaluationExecution = {
  outputs: EvaluationOutput[];
  inputTokens: number | null;
  outputTokens: number | null;
};

type Stage1FrozenInput = {
  batches: Array<{
    item_key: string;
    raw_article_ids: string[];
    input: Stage1BatchInput;
  }>;
};

type Stage2FrozenInput = {
  input: Stage2Input;
  id_map: Stage2IdMap;
};

type Stage3EventFrozenInput = { input: Stage3EventRankingInput; source_stage3_run: string };
type Stage3DigestFrozenInput = {
  inputs: Array<{ item_key: string; input: Stage3DigestRankingInput }>;
  source_stage3_run: string;
};
type Stage3LongFormFrozenInput = {
  input: Stage3LongFormRankingInput;
  source_stage3_run: string;
};

export type RunEvaluationOptions = {
  pool: Pool;
  date: string;
  stage: EvaluationStage;
  models: EvaluationModel[];
  rootDir?: string;
  storage?: EvaluationStorage;
  buildFrozenInput?: (input: {
    pool: Pool;
    date: string;
    stage: EvaluationStage;
    rootDir: string;
  }) => Promise<unknown>;
  execute?: (input: {
    stage: EvaluationStage;
    frozenInput: unknown;
    model: EvaluationModel;
  }) => Promise<EvaluationExecution>;
};

/**
 * 运行一次人工触发的 Stage-isolated Evaluation。
 * 先固定输入、再逐个模型执行；单个模型失败只更新其 own run，不会回滚其他模型结果。
 */
export async function runEvaluation(options: RunEvaluationOptions): Promise<EvaluationSummary> {
  if (options.models.length === 0) {
    throw new Error("Model Evaluation requires at least one model.");
  }
  const scope = resolveDailyScope(options.date);
  const storage = options.storage ?? createPostgresEvaluationStorage(options.pool);
  const rootDir = options.rootDir ?? process.cwd();
  const frozenInput = await (options.buildFrozenInput ?? buildFrozenEvaluationInput)({
    pool: options.pool,
    date: scope.dailyDate,
    stage: options.stage,
    rootDir,
  });
  const inputHash = hashEvaluationInput(frozenInput);
  const evaluationInput = await storage.createInput({
    dailyDate: scope.dailyDate,
    stage: options.stage,
    inputJson: frozenInput,
    inputHash,
  });
  const execute = options.execute ?? executeFrozenEvaluation;
  const runs: EvaluationRunSummary[] = [];

  for (const model of options.models) {
    const startedAt = new Date();
    const run = await storage.createRun({
      evaluationInputId: evaluationInput.id,
      provider: model.provider,
      model: model.model,
      promptVersion: promptVersionForEvaluationStage(options.stage),
      startedAt: startedAt.toISOString(),
    });
    try {
      const execution = await execute({
        stage: options.stage,
        frozenInput,
        model,
      });
      const completedAt = new Date();
      await storage.createOutputs(
        execution.outputs.map((output) => ({ ...output, evaluationRunId: run.id })),
      );
      await storage.completeRun({
        id: run.id,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        inputTokens: execution.inputTokens,
        outputTokens: execution.outputTokens,
      });
      runs.push({ provider: model.provider, model: model.model, runId: run.id, status: "success", error: null });
    } catch (error) {
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await storage.failRun({
        id: run.id,
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
        error: message,
      });
      runs.push({ provider: model.provider, model: model.model, runId: run.id, status: "failed", error: message });
    }
  }

  return {
    evaluationInputId: evaluationInput.id,
    inputHash,
    dailyDate: scope.dailyDate,
    stage: options.stage,
    runs,
  };
}

/** 使用稳定 key 顺序 JSON 序列化，供人工核验相同冻结输入。 */
export function hashEvaluationInput(input: unknown): string {
  return createHash("sha256").update(stableJson(input)).digest("hex");
}

export function isEvaluationStage(value: string): value is EvaluationStage {
  return (EVALUATION_STAGES as readonly string[]).includes(value);
}

export function promptVersionForEvaluationStage(stage: EvaluationStage): string {
  switch (stage) {
    case "stage1":
      return STAGE1_PROMPT_VERSION;
    case "stage2":
      return STAGE2_PROMPT_VERSION;
    case "stage3_event":
      return STAGE3_EVENT_RANKING_PROMPT_VERSION;
    case "stage3_digest":
      return STAGE3_DIGEST_RANKING_PROMPT_VERSION;
    case "stage3_long_form":
      return STAGE3_LONG_FORM_RANKING_PROMPT_VERSION;
  }
}

/** 仅构造并返回冻结输入；此函数不会写入任何 Production 或 Evaluation 数据。 */
export async function buildFrozenEvaluationInput(input: {
  pool: Pool;
  date: string;
  stage: EvaluationStage;
  rootDir: string;
}): Promise<unknown> {
  const scope = resolveDailyScope(input.date);
  switch (input.stage) {
    case "stage1": {
      const articles = await loadStage1EvaluationArticles(input.pool, scope);
      const batches = createStage1MicroBatches(articles, resolveStage1BatchConfig());
      return {
        batches: batches.map((batch, index) => ({
          item_key: `batch-${String(index + 1).padStart(3, "0")}`,
          raw_article_ids: batch.map((article) => article.id),
          input: buildStage1BatchInput(batch),
        })),
      } satisfies Stage1FrozenInput;
    }
    case "stage2": {
      const candidates = await loadStage2EventCandidates(input.pool, { publishedAtScope: scope });
      const prepared = prepareStage2Input(candidates);
      return { input: prepared.input, id_map: prepared.idMap } satisfies Stage2FrozenInput;
    }
    case "stage3_event":
    case "stage3_digest":
    case "stage3_long_form":
      return loadStage3FrozenInput(input.rootDir, scope.dailyDate, input.stage);
  }
}

/** 创建 Evaluation 专用持久化适配器；所有 SQL 只触及 evaluation_* 表。 */
export function createPostgresEvaluationStorage(pool: Pool): EvaluationStorage {
  return {
    async createInput(input) {
      const result = await pool.query<EvaluationInputRecord>(
        `insert into evaluation_inputs (daily_date, stage, input_json, input_hash)
         values ($1::date, $2, $3::jsonb, $4)
         returning id, daily_date as "dailyDate", stage, input_json as "inputJson", input_hash as "inputHash"`,
        [input.dailyDate, input.stage, JSON.stringify(input.inputJson), input.inputHash],
      );
      return result.rows[0] as EvaluationInputRecord;
    },
    async createRun(input) {
      const result = await pool.query<EvaluationRunRecord>(
        `insert into evaluation_runs
          (evaluation_input_id, provider, model, prompt_version, status, started_at)
         values ($1, $2, $3, $4, 'running', $5::timestamptz)
         returning id`,
        [input.evaluationInputId, input.provider, input.model, input.promptVersion, input.startedAt],
      );
      return result.rows[0] as EvaluationRunRecord;
    },
    async completeRun(input) {
      await pool.query(
        `update evaluation_runs
         set status = 'success', completed_at = $2::timestamptz, duration_ms = $3,
             input_tokens = $4, output_tokens = $5, error = null
         where id = $1`,
        [input.id, input.completedAt, input.durationMs, input.inputTokens, input.outputTokens],
      );
    },
    async failRun(input) {
      await pool.query(
        `update evaluation_runs
         set status = 'failed', completed_at = $2::timestamptz, duration_ms = $3, error = $4
         where id = $1`,
        [input.id, input.completedAt, input.durationMs, input.error],
      );
    },
    async createOutputs(outputs) {
      for (const output of outputs) {
        await pool.query(
          `insert into evaluation_outputs (evaluation_run_id, item_key, output_json)
           values ($1, $2, $3::jsonb)`,
          [output.evaluationRunId, output.itemKey, JSON.stringify(output.outputJson)],
        );
      }
    },
  };
}

async function executeFrozenEvaluation(input: {
  stage: EvaluationStage;
  frozenInput: unknown;
  model: EvaluationModel;
}): Promise<EvaluationExecution> {
  switch (input.stage) {
    case "stage1":
      return executeStage1(input.frozenInput as Stage1FrozenInput, input.model);
    case "stage2":
      return executeStage2(input.frozenInput as Stage2FrozenInput, input.model);
    case "stage3_event":
      return executeStage3Event(input.frozenInput as Stage3EventFrozenInput, input.model);
    case "stage3_digest":
      return executeStage3Digest(input.frozenInput as Stage3DigestFrozenInput, input.model);
    case "stage3_long_form":
      return executeStage3LongForm(input.frozenInput as Stage3LongFormFrozenInput, input.model);
  }
}

async function executeStage1(input: Stage1FrozenInput, model: EvaluationModel): Promise<EvaluationExecution> {
  const outputs: EvaluationOutput[] = [];
  const usage = emptyUsage();
  for (const batch of input.batches) {
    const result = await runStage1BatchLlmForInput(batch.input, model);
    if (!result.success) {
      throw new Error(result.error);
    }
    outputs.push({ itemKey: batch.item_key, outputJson: result.output });
    addUsage(usage, result.tokenUsage?.inputTokens ?? null, result.tokenUsage?.outputTokens ?? null);
  }
  return { outputs, ...toUsage(usage) };
}

async function executeStage2(input: Stage2FrozenInput, model: EvaluationModel): Promise<EvaluationExecution> {
  if (input.input.event_candidates.length === 0) {
    return { outputs: [{ itemKey: null, outputJson: { events: [] } }], inputTokens: null, outputTokens: null };
  }
  const result = await runStage2MergeLlm(input.input, model);
  if (!result.success) {
    throw new Error(result.error);
  }
  const validation = validateStage2Output(result.output);
  const assignment = validateStage2Assignments(result.output, input.input);
  if (!validation.success || !assignment.passed) {
    throw new Error([
      ...(validation.success ? [] : validation.errors),
      ...assignment.errors,
    ].join("; "));
  }
  return {
    outputs: [{ itemKey: null, outputJson: result.output }],
    inputTokens: result.tokenUsage?.inputTokens ?? null,
    outputTokens: result.tokenUsage?.outputTokens ?? null,
  };
}

async function executeStage3Event(input: Stage3EventFrozenInput, model: EvaluationModel): Promise<EvaluationExecution> {
  if (input.input.events.length === 0) {
    return { outputs: [{ itemKey: null, outputJson: { ordered_ids: [] } }], inputTokens: null, outputTokens: null };
  }
  const result = await runStage3EventRankingLlm(input.input, model);
  if (!result.success) {
    throw new Error(result.error);
  }
  return {
    outputs: [{ itemKey: null, outputJson: result.output }],
    inputTokens: result.tokenUsage?.inputTokens ?? null,
    outputTokens: result.tokenUsage?.outputTokens ?? null,
  };
}

async function executeStage3Digest(input: Stage3DigestFrozenInput, model: EvaluationModel): Promise<EvaluationExecution> {
  const outputs: EvaluationOutput[] = [];
  const usage = emptyUsage();
  for (const entry of input.inputs) {
    const result = await runStage3DigestRankingLlm(entry.input, model);
    if (!result.success) {
      throw new Error(`${entry.item_key}: ${result.error}`);
    }
    outputs.push({ itemKey: entry.item_key, outputJson: result.output });
    addUsage(usage, result.diagnostics.initial.input_tokens, result.diagnostics.initial.output_tokens);
    if (result.diagnostics.repair) {
      addUsage(usage, result.diagnostics.repair.input_tokens, result.diagnostics.repair.output_tokens);
    }
  }
  return { outputs, ...toUsage(usage) };
}

async function executeStage3LongForm(input: Stage3LongFormFrozenInput, model: EvaluationModel): Promise<EvaluationExecution> {
  if (input.input.candidates.length === 0) {
    return { outputs: [{ itemKey: null, outputJson: { rankings: [] } }], inputTokens: null, outputTokens: null };
  }
  const result = await runStage3LongFormRankingLlm(input.input, model);
  if (!result.success) {
    throw new Error(result.error);
  }
  return {
    outputs: [{ itemKey: null, outputJson: result.output }],
    inputTokens: result.tokenUsage?.inputTokens ?? null,
    outputTokens: result.tokenUsage?.outputTokens ?? null,
  };
}

async function loadStage3FrozenInput(
  rootDir: string,
  dailyDate: string,
  stage: "stage3_event" | "stage3_digest" | "stage3_long_form",
): Promise<Stage3EventFrozenInput | Stage3DigestFrozenInput | Stage3LongFormFrozenInput> {
  const runDir = await findLatestSuccessfulStage3Run(rootDir, dailyDate);
  if (stage === "stage3_event") {
    return {
      input: await readJson<Stage3EventRankingInput>(join(runDir, "events", "input.json")),
      source_stage3_run: runDir,
    };
  }
  if (stage === "stage3_long_form") {
    return {
      input: await readJson<Stage3LongFormRankingInput>(join(runDir, "long-form", "input.json")),
      source_stage3_run: runDir,
    };
  }
  const digestDir = join(runDir, "digest");
  const entries = await readdir(digestDir, { withFileTypes: true });
  const inputs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith("-input.json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => {
        const input = await readJson<Stage3DigestRankingInput>(join(digestDir, entry.name));
        return { item_key: input.category, input };
      }),
  );
  return { inputs, source_stage3_run: runDir };
}

async function findLatestSuccessfulStage3Run(rootDir: string, dailyDate: string): Promise<string> {
  const fromDailyLineage = await findStage3RunFromDailyLineage(rootDir, dailyDate);
  if (fromDailyLineage) {
    return fromDailyLineage;
  }

  // 保留 standalone Stage 3 的支持；它同样是正式处理结果，但不具备 Daily run pointer。
  const directory = join(rootDir, "runtime", "stage3");
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries.filter((entry) => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
  for (const candidate of candidates) {
    const runDir = join(directory, candidate.name);
    try {
      const run = await readJson<{ status?: string; daily_date?: string }>(join(runDir, "run.json"));
      if (run.status === "success" && run.daily_date === dailyDate) {
        return runDir;
      }
    } catch {
      // 一个不完整 runtime 不应阻止继续寻找同日期的已完成 Stage 3 run。
    }
  }
  throw new Error(`No successful Stage 3 runtime found for Daily ${dailyDate}.`);
}

/** 优先沿 Daily artifact 记录的 stage3_run 指针读取，避免依赖全局 latest runtime。 */
async function findStage3RunFromDailyLineage(
  rootDir: string,
  dailyDate: string,
): Promise<string | null> {
  const directory = join(rootDir, "runtime", "daily");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries.filter((value) => value.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const dailyRun = await readJson<{ daily_date?: string; stage3_run?: string | null }>(
        join(directory, entry.name, "run.json"),
      );
      if (dailyRun.daily_date !== dailyDate || !dailyRun.stage3_run) {
        continue;
      }
      const stage3RunDir = isAbsolute(dailyRun.stage3_run)
        ? dailyRun.stage3_run
        : join(rootDir, dailyRun.stage3_run);
      const stage3Run = await readJson<{ status?: string; daily_date?: string }>(
        join(stage3RunDir, "run.json"),
      );
      if (stage3Run.status === "success" && stage3Run.daily_date === dailyDate) {
        return stage3RunDir;
      }
    } catch {
      // 某个 Daily artifact 不完整时继续检查较早的同日期运行。
    }
  }
  return null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Evaluation input must not contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`Evaluation input contains unsupported value type ${typeof value}.`);
}

function emptyUsage() {
  return { seen: false, inputTokens: 0, outputTokens: 0 };
}

function addUsage(
  usage: ReturnType<typeof emptyUsage>,
  inputTokens: number | null,
  outputTokens: number | null,
) {
  if (inputTokens !== null) {
    usage.inputTokens += inputTokens;
    usage.seen = true;
  }
  if (outputTokens !== null) {
    usage.outputTokens += outputTokens;
    usage.seen = true;
  }
}

function toUsage(usage: ReturnType<typeof emptyUsage>) {
  return {
    inputTokens: usage.seen ? usage.inputTokens : null,
    outputTokens: usage.seen ? usage.outputTokens : null,
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
