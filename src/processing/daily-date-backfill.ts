/** 一次性 legacy daily_date 回填的查询与计划；只处理尚未归属的记录。 */
import type { Pool, PoolClient } from "pg";
import { deriveDailyDateFromPublishedAt } from "../lib/daily-scope.js";

type Queryable = Pick<Pool | PoolClient, "query">;

export type DailyDateBackfillRow = {
  id: string;
  dailyDate: string | null;
  publishedAt: Date | string | null;
};

export type DailyDateBackfillPlan = {
  updates: Array<{ id: string; dailyDate: string }>;
  skippedCount: number;
  byDailyDate: Array<{ dailyDate: string; count: number }>;
};

export type DailyDateBackfillPreview = DailyDateBackfillPlan & {
  processedContentsCount: number;
  nullDailyDateCount: number;
};

export type DailyDateBackfillResult = DailyDateBackfillPlan & {
  beforeNullCount: number;
  updatedCount: number;
  afterNullCount: number;
};

/** 将可推导的 NULL 记录整理为更新计划，方便 dry-run 与正式执行共用同一规则。 */
export function buildDailyDateBackfillPlan(
  rows: readonly DailyDateBackfillRow[],
): DailyDateBackfillPlan {
  const updates: Array<{ id: string; dailyDate: string }> = [];
  let skippedCount = 0;

  for (const row of rows) {
    if (row.dailyDate !== null || row.publishedAt === null) {
      skippedCount += 1;
      continue;
    }

    try {
      updates.push({
        id: row.id,
        dailyDate: deriveDailyDateFromPublishedAt(row.publishedAt),
      });
    } catch {
      // legacy 数据异常时保留 NULL，供 dry-run/后续人工处理，而不是中断整次回填。
      skippedCount += 1;
    }
  }

  const counts = new Map<string, number>();
  for (const update of updates) {
    counts.set(update.dailyDate, (counts.get(update.dailyDate) ?? 0) + 1);
  }

  return {
    updates,
    skippedCount,
    byDailyDate: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([dailyDate, count]) => ({ dailyDate, count })),
  };
}

/** 读取 dry-run 所需计数和全部 NULL 候选，不对数据库写入。 */
export async function previewDailyDateBackfill(
  queryable: Queryable,
): Promise<DailyDateBackfillPreview> {
  const [totalResult, rows] = await Promise.all([
    queryable.query<{ count: string }>("select count(*) from processed_contents"),
    loadNullDailyDateRows(queryable),
  ]);
  const plan = buildDailyDateBackfillPlan(rows);

  return {
    processedContentsCount: Number(totalResult.rows[0]?.count ?? 0),
    nullDailyDateCount: rows.length,
    ...plan,
  };
}

/** 在一个 transaction 内重新确认 NULL 条件并回填，避免中途只写入一部分。 */
export async function executeDailyDateBackfill(
  pool: Pool,
): Promise<DailyDateBackfillResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const rows = await loadNullDailyDateRows(client);
    const plan = buildDailyDateBackfillPlan(rows);
    const beforeNullCount = rows.length;
    let updatedCount = 0;

    if (plan.updates.length > 0) {
      const result = await client.query(
        `
          update processed_contents as pc
          set daily_date = updates.daily_date::date
          from unnest($1::uuid[], $2::date[]) as updates(id, daily_date)
          where pc.id = updates.id
            and pc.daily_date is null
        `,
        [
          plan.updates.map((update) => update.id),
          plan.updates.map((update) => update.dailyDate),
        ],
      );
      updatedCount = result.rowCount ?? 0;
    }

    const afterResult = await client.query<{ count: string }>(
      "select count(*) from processed_contents where daily_date is null",
    );
    const afterNullCount = Number(afterResult.rows[0]?.count ?? 0);
    await client.query("commit");

    return {
      beforeNullCount,
      updatedCount,
      afterNullCount,
      ...plan,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function loadNullDailyDateRows(
  queryable: Queryable,
): Promise<DailyDateBackfillRow[]> {
  const result = await queryable.query<DailyDateBackfillRow>(`
    select
      pc.id,
      pc.daily_date as "dailyDate",
      ra.published_at as "publishedAt"
    from processed_contents as pc
    left join raw_articles as ra on ra.id = pc.raw_article_id
    where pc.daily_date is null
    order by pc.id
  `);

  return result.rows;
}
