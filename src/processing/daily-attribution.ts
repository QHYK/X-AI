/** 为旧数据补齐稳定 Daily attribution；只填空值，绝不抢占已归属内容。 */
import type { Pool, PoolClient } from "pg";
import type { DailyScope } from "../lib/daily-scope.js";

export async function backfillDailyAttribution(
  queryable: Pick<Pool | PoolClient, "query">,
  scope: DailyScope,
): Promise<number> {
  const result = await queryable.query(
    `
      update processed_contents pc
      set daily_date = $1::date
      from raw_articles ra
      where ra.id = pc.raw_article_id
        and pc.daily_date is null
        and ra.published_at >= $2::timestamptz
        and ra.published_at < $3::timestamptz
    `,
    [scope.dailyDate, scope.startAt, scope.endAt],
  );
  return result.rowCount ?? 0;
}
