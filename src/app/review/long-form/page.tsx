/** Long-form Ranking Review 页面：读取 Daily scope 全部已排名内容并批量调整 display rank。 */
import { getDatabasePool } from "@/db/index.js";
import { parseBriefDate } from "@/lib/brief-date.js";
import { resolveDailyScope } from "@/lib/daily-scope.js";
import { getLongFormReviewData } from "@/lib/review.js";
import { LongFormRankingReview } from "../ranking-review-client.js";
import { ReviewHeader } from "../review-header.js";
import styles from "../review.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LongFormReviewPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const dailyDate = parseBriefDate(rawDate ?? "")?.date ?? resolveDailyScope(undefined).dailyDate;
  const data = await getLongFormReviewData(getDatabasePool(), dailyDate);

  return (
    <main className={styles.page}>
      <ReviewHeader
        title="Long-form Ranking Review"
        description={`All ranked Long-form items · ${data.items.length} item(s) · formal cutoff Top ${data.cutoff}`}
        dailyDate={dailyDate}
        action="./long-form"
        active="long-form"
      />
      <LongFormRankingReview data={data} />
    </main>
  );
}
