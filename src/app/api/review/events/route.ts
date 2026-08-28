/** Event Ranking Review 的批量组合查询 API。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { getEventReviewData } from "@/lib/review.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const date = parseBriefDate(new URL(request.url).searchParams.get("date"))?.date;
  if (!date) {
    return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
  }

  try {
    return Response.json(await getEventReviewData(getDatabasePool(), date));
  } catch (error) {
    console.error("Failed to load Event Ranking Review.", error);
    return Response.json({ error: "Failed to load Event Ranking Review." }, { status: 500 });
  }
}
