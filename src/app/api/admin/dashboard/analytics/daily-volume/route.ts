import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from "@/db/index.js";
import { getDashboardData } from "@/lib/dashboard.js";
import { isAnalyticsRange, resolveAnalyticsScopes } from "@/lib/dashboard-analytics.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authError = await adminApiError(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const range = url.searchParams.get("range");
  if (!isAnalyticsRange(range)) return Response.json({ message: "Invalid range." }, { status: 400 });
  try {
    const scopes = resolveAnalyticsScopes(range, url.searchParams.get("startDate"), url.searchParams.get("endDate"));
    if (scopes.length === 0) return Response.json({ days: [] });
    const data = await getDashboardData(getDatabasePool(), { overviewScopes: scopes, detailDate: scopes[0]?.dailyDate });
    return Response.json({ days: data.days });
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Invalid analytics request." }, { status: 400 });
  }
}
