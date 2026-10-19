import { adminApiError } from '@/lib/admin-auth.js';
import { getDatabasePool } from "@/db/index.js";
import { isUuid, loadIgnoredArticles } from "@/lib/dashboard-analytics.js";
import { isDailyScopeCompleted, resolveDailyScope } from "@/lib/daily-scope.js";
import { parseBriefDate } from "@/lib/brief-date.js";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const authError = await adminApiError(request);
  if (authError) return authError;
  const url = new URL(request.url);
  const sourceId = url.searchParams.get("sourceId");
  const date = url.searchParams.get("date");
  const parsedPage = Number(url.searchParams.get("page") ?? "1");
  if (!isUuid(sourceId) || !parseBriefDate(date) || !Number.isInteger(parsedPage) || parsedPage < 1) {
    return Response.json({ message: "Invalid request." }, { status: 400 });
  }
  try {
    const scope = resolveDailyScope(date!);
    if (!isDailyScopeCompleted(scope)) return Response.json({ message: "Daily scope has not completed." }, { status: 400 });
    return Response.json(await loadIgnoredArticles(getDatabasePool(), sourceId, scope, parsedPage));
  } catch (error) {
    return Response.json({ message: error instanceof Error ? error.message : "Invalid analytics request." }, { status: 400 });
  }
}
