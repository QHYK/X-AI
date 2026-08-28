/** Event Ranking Review 的单次事务保存 API。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import {
  getEventReviewEnrichmentRequests,
  ReviewValidationError,
  saveEventReviewRanking,
} from "@/lib/ranking-review.js";
import {
  enrichStage4Event,
  loadStage4SourceCandidates,
  prepareStage4Event,
  Stage4EnrichmentError,
  type EnrichedStage4Event,
} from "@/processing/stage4-event-processing.js";

export const runtime = "nodejs";

export async function PATCH(request: Request): Promise<Response> {
  try {
    const body: unknown = await request.json();
    const input = parseRequest(body);
    const pool = getDatabasePool();
    // 先在 transaction 外完成可能耗时的 enrichment；失败时不会写入任何 Review 或最终 Brief 排名。
    const enrichmentRequests = await getEventReviewEnrichmentRequests(pool, input);
    const sourceCandidates = await loadStage4SourceCandidates(
      pool,
      [...new Set(enrichmentRequests.flatMap((item) => item.processedContentIds))],
    );
    const enrichedEvents: EnrichedStage4Event[] = [];
    for (const item of enrichmentRequests) {
      enrichedEvents.push(
        await enrichStage4Event(prepareStage4Event(item, sourceCandidates, new Date())),
      );
    }
    const result = await saveEventReviewRanking(pool, { ...input, enrichedEvents });
    return Response.json({ status: "saved", ...result });
  } catch (error) {
    if (error instanceof ReviewValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof Stage4EnrichmentError) {
      return Response.json(
        { error: `${error.message} Review ranking was not saved.` },
        { status: 502 },
      );
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
