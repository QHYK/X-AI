import { getDatabasePool } from "@/db/index.js";
import { isAnalyticsRange, isUuid, loadSourceAnalyticsDays, resolveAnalyticsScopes } from "@/lib/dashboard-analytics.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const range = url.searchParams.get("range");
  const sourceId = url.searchParams.get("sourceId");
  if (!isAnalyticsRange(range) || !isUuid(sourceId)) return Response.json({ message: "Invalid request." }, { status: 400 });
  try {
    const scopes = resolveAnalyticsScopes(range, url.searchParams.get("startDate"), url.searchParams.get("endDate"));
    return Response.json({ rows: await loadSourceAnalyticsDays(getDatabasePool(), sourceId, scopes) });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Invalid analytics request." }, { status: 400 });
  }
}
