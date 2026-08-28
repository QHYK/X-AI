/** Event Ranking Review 页面：展示最新 Stage 3 Top 50 snapshot 并支持批量人工排序。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { resolveDailyScope } from "@/lib/daily-scope.js";
import { getEventReviewData } from "@/lib/review.js";
import { EventRankingReview } from "../ranking-review-client.js";
import { ReviewHeader } from "../review-header.js";
import styles from "../review.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function EventReviewPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const dailyDate = parseBriefDate(rawDate ?? "")?.date ?? resolveDailyScope(undefined).dailyDate;
  const data = await getEventReviewData(getDatabasePool(), dailyDate);

  return (
    <main className={styles.page}>
      <ReviewHeader
        title="Event Ranking Review"
        description={`Latest Stage 3 snapshot · ${data.items.length} item(s) · formal cutoff Top ${data.cutoff}`}
        dailyDate={dailyDate}
        action="./events"
        active="events"
      />
      {data.reviewRunId ? (
        <p className={styles.snapshot}>Snapshot · {data.reviewRunId}</p>
      ) : null}
      <EventRankingReview data={data} />
    </main>
  );
}
