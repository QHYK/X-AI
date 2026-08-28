/** Model Evaluation 的受限人工触发 API；先持久化 running runs，再启动固定 detached CLI。 */
import { getDatabasePool } from "@/db/index.js";
import { hasRunningEvaluation, startDetachedEvaluation } from "@/lib/evaluation-background.js";
import { prepareEvaluation } from "@/lib/model-evaluation.js";
import { parseEvaluationRunRequest } from "@/lib/evaluation-request.js";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  try {
    const pool = getDatabasePool();
    const parsed = parseEvaluationRunRequest(body);
    if (await hasRunningEvaluation(pool, parsed.request.date, parsed.request.stage)) {
      return Response.json({ status: "already_running" }, { status: 202 });
    }
    const prepared = await prepareEvaluation({
      pool,
      date: parsed.request.date,
      stage: parsed.request.stage,
      models: parsed.models,
    });
    const result = await startDetachedEvaluation(prepared);
    return Response.json(result, { status: result.status === "failed" ? 500 : 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run Model Evaluation.";
    console.error("Failed to run Model Evaluation.", error);
    return Response.json({ error: message }, { status: 400 });
  }
}
