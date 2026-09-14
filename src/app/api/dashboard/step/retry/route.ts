import { Pool } from "pg";
import { parseBriefDate } from "@/lib/brief-date.js";
import { getDashboardStepRunStatus, isDashboardRetryStep, startDashboardStepRetry } from "@/lib/dashboard-step-retry.js";

export const runtime = "nodejs";

function pool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  return new Pool({ connectionString: databaseUrl, ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined });
}

export async function POST(request: Request): Promise<Response> {
  let input: { dailyDate?: unknown; step?: unknown };
  try { input = await request.json() as { dailyDate?: unknown; step?: unknown }; } catch { return Response.json({ status: "failed", message: "Invalid request." }, { status: 400 }); }
  if (typeof input.dailyDate !== "string" || !parseBriefDate(input.dailyDate) || typeof input.step !== "string" || !isDashboardRetryStep(input.step)) {
    return Response.json({ status: "failed", message: "Invalid Daily date or step." }, { status: 400 });
  }
  const connection = pool();
  try {
    const result = await startDashboardStepRetry(connection, input.dailyDate, input.step);
    return Response.json(result, { status: result.status === "failed" ? 500 : 202 });
  } finally { await connection.end(); }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const dailyDate = url.searchParams.get("dailyDate");
  const step = url.searchParams.get("step");
  if (!parseBriefDate(dailyDate) || !step || !isDashboardRetryStep(step)) return Response.json({ message: "Invalid Daily date or step." }, { status: 400 });
  const connection = pool();
  try { return Response.json({ status: await getDashboardStepRunStatus(connection, dailyDate!, step) }); }
  finally { await connection.end(); }
}
