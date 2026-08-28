/** 仅取消一个正在运行的 Model Evaluation run；客户端只传 run ID，不能指定系统 PID。 */
import { getDatabasePool } from "@/db/index.js";
import { cancelEvaluationRun } from "@/lib/evaluation-background.js";
import { parseEvaluationCancelRequest } from "@/lib/evaluation-request.js";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  let runId: string;
  try {
    runId = parseEvaluationCancelRequest(body).runId;
  } catch (error) {
    const message = error instanceof Error ? error.message : "run_id must be a UUID.";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const result = await cancelEvaluationRun(getDatabasePool(), runId);
    if (result.status === "not_found") return Response.json(result, { status: 404 });
    if (result.status === "not_running") return Response.json(result, { status: 409 });
    return Response.json(result, { status: 200 });
  } catch (error) {
    console.error("Failed to cancel Model Evaluation run.", error);
    return Response.json({ error: "Failed to cancel Model Evaluation run." }, { status: 500 });
  }
}
