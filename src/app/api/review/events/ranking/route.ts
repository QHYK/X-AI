/** Event Ranking Review 的单次事务保存 API。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import {
  ReviewValidationError,
  saveEventReviewRanking,
} from "@/lib/ranking-review.js";

export const runtime = "nodejs";

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const input = parseRequest(body);
    const result = await saveEventReviewRanking(getDatabasePool(), input);
    return Response.json({ status: "saved", ...result });
  } catch (error) {
    if (error instanceof ReviewValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to save Event Ranking Review.", error);
    return Response.json({ error: "Failed to save Event Ranking Review." }, { status: 500 });
  }
}

function parseRequest(value: unknown): {
  dailyDate: string;
  reviewRunId: string;
  orderedIds: string[];
  touchedIds: string[];
} {
  if (!isRecord(value)) {
    throw new ReviewValidationError("Request body must be an object.");
  }
  const dailyDate = typeof value.date === "string" ? parseBriefDate(value.date)?.date : undefined;
  if (!dailyDate) {
    throw new ReviewValidationError("date must be YYYY-MM-DD.");
  }
  if (typeof value.reviewRunId !== "string" || !isUuid(value.reviewRunId)) {
    throw new ReviewValidationError("reviewRunId must be a UUID.");
  }
  return {
    dailyDate,
    reviewRunId: value.reviewRunId,
    orderedIds: stringArray(value.orderedIds, "orderedIds"),
    touchedIds: stringArray(value.touchedIds, "touchedIds"),
  };
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !isUuid(item))) {
    throw new ReviewValidationError(`${name} must be an array of UUIDs.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
