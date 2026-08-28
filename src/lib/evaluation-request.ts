/**
 * Model Evaluation 手动触发请求的参数校验边界。
 * API Route 只在这里校验日期、Stage 与可用 Provider，实际冻结输入、LLM 调用和持久化仍委托 service。
 */
import type { Pool } from "pg";
import { parseBriefDate } from "./brief-date.js";
import { resolveEvaluationModels, type EvaluationModel } from "./evaluation-model-config.js";
import {
  isEvaluationStage,
  runEvaluation,
  type EvaluationStage,
  type EvaluationSummary,
} from "./model-evaluation.js";

export type EvaluationRunRequest = {
  date: string;
  stage: EvaluationStage;
  providers: string[];
};

/** 解析取消请求。客户端只能声明持久化 run ID，进程 PID 始终由服务端从数据库读取。 */
export function parseEvaluationCancelRequest(body: unknown): { runId: string } {
  const runId = isRecord(body) && typeof body.run_id === "string" ? body.run_id : undefined;
  if (!runId || !isUuid(runId)) throw new Error("run_id must be a UUID.");
  return { runId };
}

/** 解析不可信的 HTTP body，只允许当前 Evaluation 配置中启用的 Provider 被手动执行。 */
export function parseEvaluationRunRequest(
  body: unknown,
  availableModels: EvaluationModel[] = resolveEvaluationModels(),
): { request: EvaluationRunRequest; models: EvaluationModel[] } {
  if (!isRecord(body)) throw new Error("Request body must be an object.");
  const date = typeof body.date === "string" ? parseBriefDate(body.date)?.date : undefined;
  const stage = typeof body.stage === "string" && isEvaluationStage(body.stage) ? body.stage : undefined;
  const providers = Array.isArray(body.providers) && body.providers.every((value) => typeof value === "string")
    ? body.providers
    : [];
  if (!date) throw new Error("date must be YYYY-MM-DD.");
  if (!stage) throw new Error("Unsupported Evaluation stage.");
  if (providers.length === 0 || new Set(providers).size !== providers.length) {
    throw new Error("Select one or more unique Evaluation providers.");
  }
  const models = availableModels.filter((model) => providers.includes(model.provider));
  if (models.length !== providers.length) {
    throw new Error("One or more providers are not enabled for Model Evaluation.");
  }
  return { request: { date, stage, providers }, models };
}

/** 调用既有 Evaluation service；保留注入点使 Route 行为可在不调用 LLM 的情况下验证。 */
export async function startEvaluationFromRequest(input: {
  pool: Pool;
  body: unknown;
  availableModels?: EvaluationModel[];
  run?: typeof runEvaluation;
}): Promise<EvaluationSummary> {
  const parsed = parseEvaluationRunRequest(input.body, input.availableModels);
  return (input.run ?? runEvaluation)({
    pool: input.pool,
    date: parsed.request.date,
    stage: parsed.request.stage,
    models: parsed.models,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
