/** Read-only projection of automatic Stage3 routing corrections, including orphaned groups. */
import type { Pool } from 'pg';
import { parseBriefDate } from './brief-date.js';

type Database = Pick<Pool, 'query'>;
const automaticCorrection = `f.target_type = 'processed_content'
  and f.feedback_type = 'routing_error'
  and f.before_value->>'routing' = 'digest'
  and f.after_value->>'routing' = 'event'
  and f.after_value->>'source' = 'stage3_consolidation'`;
const consolidationRun = `step = 'stage3'
  and jsonb_typeof(details->'consolidation') = 'object'
  and details->'consolidation' <> '{}'::jsonb`;

export type ConsolidationArticle = {
  id: string;
  title: string;
  category: string | null;
  source: string;
  url: string | null;
};
export type ConsolidationGroup = {
  id: string | null;
  hint: string | null;
  articles: ConsolidationArticle[];
};
export type ConsolidationReview = {
  dailyDate: string;
  hasRecord: boolean;
  eventGroupCount: number | null;
  correctionCount: number | null;
  groups: ConsolidationGroup[];
  run: { id: string; status: string } | null;
};

export async function latestEventConsolidationDate(db: Database): Promise<string | null> {
  const result = await db.query<{ daily_date: string | null }>(`
    select max(daily_date)::text as daily_date from (
      select pc.daily_date from feedback f
      join processed_contents pc on pc.id = f.target_id
      where ${automaticCorrection}
      union all
      select daily_date from pipeline_runs where ${consolidationRun}
    ) recorded_dates
  `);
  return result.rows[0]?.daily_date ?? null;
}

export async function loadEventConsolidationReview(
  db: Database,
  dailyDate: string,
): Promise<ConsolidationReview> {
  if (!parseBriefDate(dailyDate)) throw new RangeError('date must be YYYY-MM-DD.');
  const [articles, runs] = await Promise.all([
    db.query<{
      id: string;
      title: string;
      category: string | null;
      source: string;
      url: string | null;
      group_id: string | null;
      event_hint: string | null;
    }>(
      `with corrections as (
        select distinct on (f.target_id)
          f.target_id, f.after_value->>'event_group_id' as group_id,
          f.before_value->>'category' as category, f.created_at, f.id
        from feedback f
        join processed_contents pc on pc.id = f.target_id
        where pc.daily_date = $1::date and ${automaticCorrection}
        order by f.target_id, f.created_at desc, f.id desc
      )
      select pc.id, ra.title, ra.url, s.name as source, c.category,
        c.group_id, eg.event_hint
      from corrections c
      join processed_contents pc on pc.id = c.target_id
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      left join event_groups eg on eg.id::text = c.group_id and eg.daily_date = pc.daily_date
      order by c.group_id nulls last, c.created_at, pc.id`,
      [dailyDate],
    ),
    db.query<{ id: string; status: string }>(
      `select id, status from pipeline_runs
       where daily_date = $1::date and ${consolidationRun}
       order by started_at desc, id desc limit 1`,
      [dailyDate],
    ),
  ]);
  const groups = new Map<string | null, ConsolidationGroup>();
  for (const row of articles.rows) {
    let group = groups.get(row.group_id);
    if (!group) {
      group = { id: row.group_id, hint: row.event_hint, articles: [] };
      groups.set(row.group_id, group);
    }
    let url: string | null = null;
    try {
      if (row.url && ['https:', 'http:'].includes(new URL(row.url).protocol)) url = row.url;
    } catch {
      // Historical URLs may be missing or malformed; retain the article without a link.
    }
    group.articles.push({
      id: row.id,
      title: row.title,
      source: row.source,
      category: row.category,
      url,
    });
  }
  const run = runs.rows[0] ?? null;
  const hasRecord = articles.rows.length > 0 || run !== null;
  return {
    dailyDate,
    hasRecord,
    eventGroupCount: hasRecord ? groups.size : null,
    correctionCount: hasRecord ? articles.rows.length : null,
    groups: [...groups.values()],
    run,
  };
}
