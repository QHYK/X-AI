/**
 * Daily Brief 的 HTTP 入口。
 *
 * 校验日期与跨域请求后，委托 Daily Brief 组合层按 Daily scope 返回既定 JSON 契约。
 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { getDailyBriefForDailyDate } from "@/lib/daily-brief.js";

export const runtime = "nodejs";

/** 处理指定 Daily Date 的正式 Brief 查询。 */
export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const { searchParams } = new URL(request.url);
  const dateRange = parseBriefDate(searchParams.get("date"));

  if (!dateRange) {
    return jsonResponse(
      { error: "Query parameter date is required in YYYY-MM-DD format." },
      { status: 400, headers },
    );
  }

  try {
    const brief = await getDailyBriefForDailyDate(getDatabasePool(), dateRange.date);
    return jsonResponse(brief, { headers });
  } catch (error) {
    console.error("Failed to load daily brief.", error);
    return jsonResponse(
      { error: "Failed to load daily brief." },
      { status: 500, headers },
    );
  }
}

export function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request),
  });
}

function corsHeaders(request: Request): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  const origin = request.headers.get("origin");

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

function isAllowedOrigin(origin: string): boolean {
  const configuredOrigins = (process.env.BRIEF_API_ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredOrigins.length > 0) {
    return configuredOrigins.includes(origin);
  }

  return /^http:\/\/localhost:\d+$/.test(origin);
}

function jsonResponse(
  body: unknown,
  init: ResponseInit & { headers?: HeadersInit } = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}
