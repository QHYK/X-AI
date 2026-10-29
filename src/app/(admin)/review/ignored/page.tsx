import { getDatabasePool } from '@/db/index.js';
import { parseBriefDate } from '@/lib/brief-date.js';
import { resolveDailyScope, isDailyScopeCompleted } from '@/lib/daily-scope.js';
import { loadAiIgnoredArticles } from '@/lib/dashboard-analytics.js';
import { ReviewHeader } from '../review-header.js';
import { IgnoredArticlesList } from './ignored-articles-list.js';
import styles from '../review.module.css';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function IgnoredArticlesPage(props: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  const params = await props.searchParams;
  const rawDate = Array.isArray(params.date) ? params.date[0] : params.date;
  const date = parseBriefDate(rawDate ?? '')?.date ?? resolveDailyScope(undefined).dailyDate;
  const scope = resolveDailyScope(date);
  const completed = isDailyScopeCompleted(scope);
  const items = completed ? await loadAiIgnoredArticles(getDatabasePool(), scope) : [];
  return (
    <main className={styles.page}>
      <ReviewHeader
        title="Ignored Articles"
        description="审查 Stage1 LLM 的 Ignore 判断；不包含规则去重或采集失败。"
        dailyDate={date}
        action="./ignored"
      />
      <section className={styles.inDepthSection}>
        {completed ? (
          <IgnoredArticlesList
            key={date}
            items={items}
            date={date}
          />
        ) : (
          <p role="status">该 Daily Scope 尚未结束，请选择已经完成的日期。</p>
        )}
      </section>
    </main>
  );
}
