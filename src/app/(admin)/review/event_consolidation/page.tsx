import { getDatabasePool } from '@/db/index.js';
import { parseBriefDate } from '@/lib/brief-date.js';
import { resolveDailyScope } from '@/lib/daily-scope.js';
import {
  latestEventConsolidationDate,
  loadEventConsolidationReview,
  type ConsolidationReview,
} from '@/lib/event-consolidation-review.js';
import { ReviewHeader } from '../review-header.js';
import styles from '../review.module.css';
import { ConsolidationResults } from './consolidation-results.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function EventConsolidationPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  let dailyDate = parseBriefDate(rawDate ?? null)?.date ?? resolveDailyScope(undefined).dailyDate;
  let data: ConsolidationReview | null = null;
  let error: string | null = null;
  if (rawDate !== undefined && !parseBriefDate(rawDate)) {
    error = '日期无效，请使用 YYYY-MM-DD。';
  } else {
    try {
      const db = getDatabasePool();
      if (rawDate === undefined) dailyDate = (await latestEventConsolidationDate(db)) ?? dailyDate;
      data = await loadEventConsolidationReview(db, dailyDate);
    } catch (cause) {
      console.error('Unable to load Event Consolidation Review.', cause);
      error = '无法读取 Event Consolidation，请稍后重试。';
    }
  }
  return (
    <main className={styles.page}>
      <ReviewHeader
        title="Event Consolidation"
        description="Stage 3 · Routing Corrections"
        dailyDate={dailyDate}
        action="./event_consolidation"
      />
      {error ? (
        <p
          role="alert"
          className={styles.empty}
        >
          {error}
        </p>
      ) : null}
      {data ? <ConsolidationResults data={data} /> : null}
    </main>
  );
}
