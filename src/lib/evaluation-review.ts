/**
 * Model Evaluation Review 的读取与展示数据归一化层。
 *
 * 只从 evaluation_* 表读取最新一次冻结输入及其模型结果，确保页面不会把不同输入的
 * 运行混在一起比较；Stage 1–3 的原始 Structured Output 在这里转换为人工可读结构。
 */
import type { Pool } from "pg";
import {
  isStage1EvaluationInputReference,
  reconstructStage1EvaluationInput,
  type EvaluationStage,
} from "./model-evaluation.js";

type EvaluationInputRow = {
  id: string;
  dailyDate: string;
  stage: EvaluationStage;
  inputJson: unknown;
  inputHash: string;
  createdAt: Date | string;
};

type EvaluationRunRow = {
  id: string;
  provider: string;
  model: string;
  status: "running" | "success" | "failed" | "cancelled";
  error: string | null;
  startedAt: Date | string;
  completedAt: Date | string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

type EvaluationOutputRow = {
  evaluationRunId: string;
  itemKey: string | null;
  outputJson: unknown;
};

export type EvaluationRunView = {
  id: string;
  provider: string;
  model: string;
  status: "running" | "success" | "failed" | "cancelled";
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type Stage1EvaluationItem = {
  id: string;
  title: string;
  source: string;
  results: Record<string, {
    routing: string | null;
    category: string | null;
    titleZh: string | null;
    summaryZh: string | null;
  } | null>;
  routingDisagreement: boolean;
  categoryDisagreement: boolean;
};

export type Stage2EvaluationGroup = {
  eventHint: string;
  articles: Array<{ id: string; title: string; source: string }>;
};

export type Stage2EvaluationModel = {
  runId: string;
  provider: string;
  model: string;
  groups: Stage2EvaluationGroup[];
  groupCount: number;
  singletonCount: number;
};

export type EvaluationRankedItem = {
  id: string;
  title: string;
  source: string | null;
  category: string | null;
  ranks: Record<string, number | null>;
  delta: number | null;
  topProviders: string[];
  topCutoff: number | null;
};

export type EvaluationReviewData = {
  dailyDate: string;
  stage: EvaluationStage;
  input: { id: string; inputHash: string; createdAt: string } | null;
  runs: EvaluationRunView[];
  stage1: Stage1EvaluationItem[] | null;
  stage2: Stage2EvaluationModel[] | null;
  rankings: EvaluationRankedItem[] | null;
};

/**
 * 加载指定日期和 Stage 的最近一次 Evaluation input。
 * Runs 必须共同指向该 input，避免重跑产生的新 Frozen Input 与旧结果被错误地横向比较。
 */
export async function getEvaluationReviewData(
  pool: Pick<Pool, "query">,
  dailyDate: string,
  stage: EvaluationStage,
): Promise<EvaluationReviewData> {
  const inputResult = await pool.query<EvaluationInputRow>(
    `select id, daily_date::text as "dailyDate", stage, input_json as "inputJson",
            input_hash as "inputHash", created_at as "createdAt"
       from evaluation_inputs
      where daily_date = $1::date and stage = $2
      order by created_at desc, id desc
      limit 1`,
    [dailyDate, stage],
  );
  const input = inputResult.rows[0];
  if (!input) {
    return emptyReviewData(dailyDate, stage);
  }

  const runResult = await pool.query<EvaluationRunRow>(
    `select distinct on (provider, model)
            id, provider, model, status, error, started_at as "startedAt",
            completed_at as "completedAt", duration_ms as "durationMs",
            input_tokens as "inputTokens", output_tokens as "outputTokens"
       from evaluation_runs
      where evaluation_input_id = $1
      order by provider, model, started_at desc, id desc`,
    [input.id],
  );
  const runs = runResult.rows.map(toRunView);
  const successfulRunIds = runs.filter((run) => run.status === "success").map((run) => run.id);
  const outputRows = successfulRunIds.length === 0
    ? []
    : (await pool.query<EvaluationOutputRow>(
      `select evaluation_run_id as "evaluationRunId", item_key as "itemKey", output_json as "outputJson"
         from evaluation_outputs
        where evaluation_run_id = any($1::uuid[])
        order by created_at asc, id asc`,
      [successfulRunIds],
    )).rows;
  const outputsByRun = groupOutputsByRun(outputRows);

  const data: EvaluationReviewData = {
    dailyDate,
    stage,
    input: { id: input.id, inputHash: input.inputHash, createdAt: toIso(input.createdAt) },
    runs,
    stage1: null,
    stage2: null,
    rankings: null,
  };
  if (stage === "stage1") {
    const stage1Input = isStage1EvaluationInputReference(input.inputJson)
      ? await reconstructStage1EvaluationInput(pool, input.inputJson)
      : input.inputJson;
    data.stage1 = normalizeStage1Evaluation(stage1Input, runs, outputsByRun);
  } else if (stage === "stage2") {
    data.stage2 = normalizeStage2Evaluation(input.inputJson, runs, outputsByRun);
  } else {
    data.rankings = normalizeStage3Evaluation(stage, input.inputJson, runs, outputsByRun);
  }
  return data;
}

/** 将 Stage 1 batch outputs 按原始 temp_id 合并，且只将 routing/category 差异标为 disagreement。 */
export function normalizeStage1Evaluation(
  frozenInput: unknown,
  runs: EvaluationRunView[],
  outputsByRun: Map<string, EvaluationOutputRow[]>,
): Stage1EvaluationItem[] {
  const batches = asArray(recordValue(frozenInput, "batches"));
  const articles = batches.flatMap((batch) => {
    const input = recordValue(batch, "input");
    return asArray(recordValue(input, "articles")).map((article) => ({
      batchKey: stringValue(recordValue(batch, "item_key")) ?? "",
      id: stringValue(recordValue(article, "temp_id")) ?? "",
      title: stringValue(recordValue(article, "title")) ?? "Untitled article",
      source: stringValue(recordValue(article, "source_name")) ?? "Unknown source",
    }));
  });

  return articles.map((article) => {
    const results: Stage1EvaluationItem["results"] = {};
    for (const run of runs) {
      const output = outputsByRun.get(run.id)?.find((entry) => entry.itemKey === article.batchKey)?.outputJson;
      const result = asArray(recordValue(output, "results")).find(
        (entry) => stringValue(recordValue(entry, "temp_id")) === article.id,
      );
      results[run.id] = result ? {
        routing: stringValue(recordValue(result, "routing")),
        category: stringValue(recordValue(result, "category")),
        titleZh: stringValue(recordValue(recordValue(result, "generated_content"), "title_zh")),
        summaryZh: stringValue(recordValue(recordValue(result, "generated_content"), "summary_zh")),
      } : null;
    }
    const present = Object.values(results).filter((value): value is NonNullable<typeof value> => value !== null);
    return {
      id: article.id,
      title: article.title,
      source: article.source,
      results,
      routingDisagreement: new Set(present.map((value) => value.routing)).size > 1,
      categoryDisagreement: new Set(present.map((value) => value.category)).size > 1,
    };
  }).sort((left, right) => Number(right.routingDisagreement) - Number(left.routingDisagreement)
    || Number(right.categoryDisagreement) - Number(left.categoryDisagreement)
    || left.title.localeCompare(right.title));
}

/** 通过 Stage 2 frozen input 的 temp_id 回填文章标题和来源，供人工查看每个模型的完整分组。 */
export function normalizeStage2Evaluation(
  frozenInput: unknown,
  runs: EvaluationRunView[],
  outputsByRun: Map<string, EvaluationOutputRow[]>,
): Stage2EvaluationModel[] {
  const candidates = asArray(recordValue(recordValue(frozenInput, "input"), "event_candidates"));
  const candidateById = new Map(candidates.map((candidate) => [
    stringValue(recordValue(candidate, "temp_id")) ?? "",
    {
      id: stringValue(recordValue(candidate, "temp_id")) ?? "",
      title: stringValue(recordValue(candidate, "title")) ?? "Untitled article",
      source: stringValue(recordValue(candidate, "source")) ?? "Unknown source",
    },
  ]));
  return runs.filter((run) => run.status === "success").map((run) => {
    const output = outputsByRun.get(run.id)?.[0]?.outputJson;
    const groups = asArray(recordValue(output, "events")).map((event) => ({
      eventHint: stringValue(recordValue(event, "event_hint")) ?? "Untitled event group",
      articles: asArray(recordValue(event, "sources"))
        .map((id) => candidateById.get(stringValue(id) ?? ""))
        .filter((article): article is { id: string; title: string; source: string } => Boolean(article)),
    }));
    return {
      runId: run.id,
      provider: run.provider,
      model: run.model,
      groups,
      groupCount: groups.length,
      singletonCount: groups.filter((group) => group.articles.length === 1).length,
    };
  });
}

/** 以 frozen input 的稳定 ID 对齐 Stage 3 排名；只计算同一 input 内不同模型的 rank 差。 */
export function normalizeStage3Evaluation(
  stage: Exclude<EvaluationStage, "stage1" | "stage2">,
  frozenInput: unknown,
  runs: EvaluationRunView[],
  outputsByRun: Map<string, EvaluationOutputRow[]>,
): EvaluationRankedItem[] {
  const items = stage === "stage3_event"
    ? asArray(recordValue(recordValue(frozenInput, "input"), "events")).map((item) => ({
      id: stringValue(recordValue(item, "id")) ?? "",
      title: stringValue(recordValue(item, "event_hint")) ?? "Untitled event",
      source: null,
      category: null,
    }))
    : stage === "stage3_digest"
      ? asArray(recordValue(frozenInput, "inputs")).flatMap((entry) => {
        const input = recordValue(entry, "input");
        const category = stringValue(recordValue(input, "category")) ?? stringValue(recordValue(entry, "item_key"));
        return asArray(recordValue(input, "candidates")).map((item) => ({
          id: stringValue(recordValue(item, "id")) ?? "",
          title: stringValue(recordValue(item, "title")) ?? "Untitled content",
          source: stringValue(recordValue(item, "source")),
          category,
        }));
      })
      : asArray(recordValue(recordValue(frozenInput, "input"), "candidates")).map((item) => ({
        id: stringValue(recordValue(item, "id")) ?? "",
        title: stringValue(recordValue(item, "title")) ?? "Untitled content",
        source: stringValue(recordValue(item, "source")),
        category: null,
      }));
  const successfulRuns = runs.filter((run) => run.status === "success");
  const ranksByRun = new Map(successfulRuns.map((run) => [run.id, rankMap(stage, outputsByRun.get(run.id) ?? [])]));
  const topCutoff = stage === "stage3_event" ? 15 : stage === "stage3_long_form" ? 10 : null;
  return items.map((item) => {
    const ranks = Object.fromEntries(successfulRuns.map((run) => [run.id, ranksByRun.get(run.id)?.get(item.id) ?? null]));
    const values = Object.values(ranks).filter((rank): rank is number => rank !== null);
    const topProviders = successfulRuns
      .filter((run) => topCutoff !== null && (ranks[run.id] ?? Number.POSITIVE_INFINITY) <= topCutoff)
      .map((run) => run.provider);
    return {
      ...item,
      ranks,
      delta: values.length >= 2 ? Math.max(...values) - Math.min(...values) : null,
      topProviders,
      topCutoff,
    };
  }).sort((left, right) => (right.delta ?? -1) - (left.delta ?? -1) || left.title.localeCompare(right.title));
}

function rankMap(stage: Exclude<EvaluationStage, "stage1" | "stage2">, outputs: EvaluationOutputRow[]) {
  const ranks = new Map<string, number>();
  if (stage === "stage3_event") {
    asArray(recordValue(outputs[0]?.outputJson, "ordered_ids")).forEach((id, index) => {
      const value = stringValue(id);
      if (value) ranks.set(value, index + 1);
    });
    return ranks;
  }
  for (const output of outputs) {
    asArray(recordValue(output.outputJson, "rankings")).forEach((ranking) => {
      const id = stringValue(recordValue(ranking, "id"));
      const rank = numberValue(recordValue(ranking, "rank"));
      if (id && rank) ranks.set(id, rank);
    });
  }
  return ranks;
}

function emptyReviewData(dailyDate: string, stage: EvaluationStage): EvaluationReviewData {
  return { dailyDate, stage, input: null, runs: [], stage1: null, stage2: null, rankings: null };
}

function groupOutputsByRun(rows: EvaluationOutputRow[]) {
  const outputs = new Map<string, EvaluationOutputRow[]>();
  for (const row of rows) {
    const values = outputs.get(row.evaluationRunId) ?? [];
    values.push(row);
    outputs.set(row.evaluationRunId, values);
  }
  return outputs;
}

function toRunView(row: EvaluationRunRow): EvaluationRunView {
  return {
    ...row,
    startedAt: toIso(row.startedAt),
    completedAt: row.completedAt ? toIso(row.completedAt) : null,
  };
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown, key: string): Record<string, unknown> | unknown {
  if (!isRecord(value)) return {};
  return value[key] ?? {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
