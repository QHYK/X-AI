/** Model Evaluation Review 的只读 API，返回已归一化的同一 Frozen Input 比较结果。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { getEvaluationReviewData } from "@/lib/evaluation-review.js";
import { isEvaluationStage } from "@/lib/model-evaluation.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const date = parseBriefDate(searchParams.get("date"))?.date;
  const stage = searchParams.get("stage");
  if (!date) return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
  if (!stage || !isEvaluationStage(stage)) {
    return Response.json({ error: "Unsupported Evaluation stage." }, { status: 400 });
  }
  try {
    return Response.json(await getEvaluationReviewData(getDatabasePool(), date, stage));
  } catch (error) {
    console.error("Failed to load Model Evaluation Review.", error);
    return Response.json({ error: "Failed to load Model Evaluation Review." }, { status: 500 });
  }
}
