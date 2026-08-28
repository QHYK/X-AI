/** Long-form Ranking Review 的 Daily scope 查询 API。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { getLongFormReviewData } from "@/lib/review.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const date = parseBriefDate(new URL(request.url).searchParams.get("date"))?.date;
  if (!date) {
    return Response.json({ error: "date must be YYYY-MM-DD." }, { status: 400 });
  }

  try {
    return Response.json(await getLongFormReviewData(getDatabasePool(), date));
  } catch (error) {
    console.error("Failed to load Long-form Ranking Review.", error);
    return Response.json({ error: "Failed to load Long-form Ranking Review." }, { status: 500 });
  }
}
