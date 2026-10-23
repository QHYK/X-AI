import type { Pool } from "pg";
import {
  resolveCompletedDailyScopesInRange,
  resolveRecentCompletedDailyScopes,
  type DailyScope,
} from "./daily-scope.js";
import { parseBriefDate } from "./brief-date.js";

export type AnalyticsRange = "7" | "30" | "custom";
export type SourceAnalyticsRow = {
  sourceId: string;
  sourceName: string;
  raw: number;
  selected: number;
  ignored: number;
  duplicate: number;
  pending: number;
  failed: number;
};

export type SourceAnalyticsDay = Omit<SourceAnalyticsRow, "sourceId" | "sourceName"> & { date: string };
export type IgnoredArticle = {
  id: string;
  title: string;
  sourceName: string;
  url: string | null;
  ignoreType: "AI Ignored" | "Duplicate";
  putBackAt?: string | null;
  inDigest?: boolean;
  dailyDate?: string | null;
};

type CountRow = {
  source_id?: string;
  source_name?: string;
  date?: string;
  raw: number | string;
  selected: number | string;
  ignored: number | string;
  duplicate: number | string;
  pending: number | string;
  failed: number | string;
};

export function resolveAnalyticsScopes(
  range: AnalyticsRange,
  startDate?: string | null,
  endDate?: string | null,
  now: Date = new Date(),
): DailyScope[] {
  if (range === "7") return resolveRecentCompletedDailyScopes(7, now);
  if (range === "30") return resolveRecentCompletedDailyScopes(30, now);
  if (!startDate || !endDate || !parseBriefDate(startDate) || !parseBriefDate(endDate)) {
    throw new Error("Custom analytics ranges require valid startDate and endDate.");
  }
  return resolveCompletedDailyScopesInRange(startDate, endDate, now);
}

export async function loadSourceAnalytics(
  pool: Pool,
  scopes: DailyScope[],
): Promise<SourceAnalyticsRow[]> {
  if (scopes.length === 0) return [];
  const result = await pool.query<CountRow>(`
    with scopes as (
      select * from unnest($1::text[], $2::timestamptz[], $3::timestamptz[])
        as scope(date, start_at, end_at)
    )
    select ra.source_id, s.name as source_name,
      count(ra.id)::int as raw,
      count(ra.id) filter (where ra.stage1_status = 'selected')::int as selected,
      count(ra.id) filter (where ra.stage1_status = 'ignored' and coalesce(ra.processing_error, '') <> 'duplicate')::int as ignored,
      count(ra.id) filter (where ra.stage1_status = 'ignored' and ra.processing_error = 'duplicate')::int as duplicate,
      count(ra.id) filter (where ra.stage1_status = 'pending')::int as pending,
      count(ra.id) filter (where ra.stage1_status = 'failed')::int as failed
    from scopes scope
    join raw_articles ra on ra.published_at >= scope.start_at and ra.published_at < scope.end_at
    join sources s on s.id = ra.source_id
    group by ra.source_id, s.name
    order by raw desc, s.name asc
  `, scopeValues(scopes));
  return result.rows.map((row) => ({
    sourceId: row.source_id!, sourceName: row.source_name!, ...counts(row),
  }));
}

export async function loadSourceAnalyticsDays(
  pool: Pool,
  sourceId: string,
  scopes: DailyScope[],
): Promise<SourceAnalyticsDay[]> {
  if (scopes.length === 0) return [];
  const result = await pool.query<CountRow>(`
    with scopes as (
      select * from unnest($1::text[], $2::timestamptz[], $3::timestamptz[])
        as scope(date, start_at, end_at)
    )
    select scope.date,
      count(ra.id)::int as raw,
      count(ra.id) filter (where ra.stage1_status = 'selected')::int as selected,
      count(ra.id) filter (where ra.stage1_status = 'ignored' and coalesce(ra.processing_error, '') <> 'duplicate')::int as ignored,
      count(ra.id) filter (where ra.stage1_status = 'ignored' and ra.processing_error = 'duplicate')::int as duplicate,
      count(ra.id) filter (where ra.stage1_status = 'pending')::int as pending,
      count(ra.id) filter (where ra.stage1_status = 'failed')::int as failed
    from scopes scope
    left join raw_articles ra on ra.source_id = $4::uuid
      and ra.published_at >= scope.start_at and ra.published_at < scope.end_at
    group by scope.date
    order by scope.date desc
  `, [...scopeValues(scopes), sourceId]);
  return result.rows.map((row) => ({ date: row.date!, ...counts(row) }));
}

export async function loadIgnoredArticles(
  pool: Pool,
  sourceId: string,
  scope: DailyScope,
  page: number,
  pageSize = 50,
): Promise<{ items: IgnoredArticle[]; total: number }> {
  const offset = (page - 1) * pageSize;
  const result = await pool.query<IgnoredArticle & { total_count: number | string }>(`
    select ra.id, ra.title, s.name as "sourceName", ra.url,
      coalesce(ra.metadata->'put_back_preparation'->>'ignoreType',
        case when ra.processing_error = 'duplicate' then 'Duplicate' else 'AI Ignored' end) as "ignoreType",
      pc.put_back_at::text as "putBackAt", pc.daily_date::text as "dailyDate",
      coalesce(pc.routing = 'digest' and coalesce(pc.display_rank, pc.ai_rank) is not null, false) as "inDigest",
      count(*) over()::int as total_count
    from raw_articles ra join sources s on s.id = ra.source_id
    left join processed_contents pc on pc.raw_article_id = ra.id
    where ra.source_id = $1::uuid
      and ra.published_at >= $2::timestamptz and ra.published_at < $3::timestamptz
      and (ra.stage1_status = 'ignored' or pc.put_back_at is not null)
    order by ra.stage1_processed_at desc nulls last, ra.id
    limit $4 offset $5
  `, [sourceId, scope.startAt, scope.endAt, pageSize, offset]);
  return {
    items: result.rows.map((row) => ({ id: row.id, title: row.title, sourceName: row.sourceName, url: row.url, ignoreType: row.ignoreType,
      ...(row.putBackAt !== undefined ? { putBackAt: row.putBackAt, inDigest: row.inDigest, dailyDate: row.dailyDate } : {}) })),
    total: Number(result.rows[0]?.total_count ?? 0),
  };
}

export function isAnalyticsRange(value: string | null): value is AnalyticsRange {
  return value === "7" || value === "30" || value === "custom";
}

export function isUuid(value: string | null): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

function scopeValues(scopes: DailyScope[]): [string[], string[], string[]] {
  return [scopes.map((scope) => scope.dailyDate), scopes.map((scope) => scope.startAt), scopes.map((scope) => scope.endAt)];
}

function counts(row: CountRow): Omit<SourceAnalyticsRow, "sourceId" | "sourceName"> {
  return { raw: Number(row.raw), selected: Number(row.selected), ignored: Number(row.ignored), duplicate: Number(row.duplicate), pending: Number(row.pending), failed: Number(row.failed) };
}
