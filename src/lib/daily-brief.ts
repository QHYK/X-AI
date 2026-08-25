/**
 * Daily Brief 的数据库组合层。
 *
 * 复用同一查询规则提供 API 与 Dashboard 所需的最终展示内容，并在传入 Daily scope 时按原始采集输入归属。
 */
import type { Pool } from "pg";
import type { ShanghaiDayRange } from "./brief-date.js";
import {
  resolveDailyScope,
  type DailyScope,
  type PublishedAtScope,
} from "./daily-scope.js";

export type DailyBriefOptions = {
  publishedAtScope?: PublishedAtScope;
};

export const DIGEST_CATEGORY_KEYS = [
  "Finance & Economy",
  "Technology",
  "Science",
  "Policy",
  "Company",
  "General",
] as const;

export type BriefEventSource = {
  source: string;
  title: string;
  url: string | null;
};

export type BriefEvent = {
  id: string;
  rank: number;
  event_date: string;
  created_at: string;
  title: string;
  title_zh: string;
  summary: string;
  summary_zh: string;
  tags: string[];
  tags_zh: string[];
  entities: string[];
  entities_zh: string[];
  source_perspectives: unknown;
  sources: BriefEventSource[];
  external_context: unknown | null;
};

export type BriefContentItem = {
  id: string;
  rank: number;
  title: string;
  title_zh: string | null;
  summary: string | null;
  summary_zh: string | null;
  source: string;
  url: string | null;
  published_at: string | null;
  created_at: string;
};

export type BriefInspirationItem = Omit<BriefContentItem, "rank"> & {
  image_url: string | null;
};

export type DailyBriefResponse = {
  date: string;
  events: BriefEvent[];
  digests: Record<string, BriefContentItem[]>;
  long_form: BriefContentItem[];
  inspiration: BriefInspirationItem[];
  meta: {
    timezone: "Asia/Shanghai";
    date_basis: "raw_articles.published_at";
    generated_at: string;
    event_count: number;
    digest_count: number;
    digest_count_by_category: Record<string, number>;
    long_form_count: number;
    inspiration_count: number;
  };
};

type EventRow = {
  id: string;
  rank: number;
  event_date: string;
  created_at: Date | string;
  title: string;
  title_zh: string;
  summary: string;
  summary_zh: string;
  tags: string[] | null;
  tags_zh: string[] | null;
  entities: string[] | null;
  entities_zh: string[] | null;
  source_perspectives: unknown;
  external_context: unknown | null;
};

type EventSourceRow = {
  event_id: string;
  source: string;
  title: string;
  url: string | null;
};

type ContentRow = {
  id: string;
  rank: number;
  title: string;
  title_zh: string | null;
  summary: string | null;
  summary_zh: string | null;
  category: string;
  source: string;
  url: string | null;
  published_at: Date | string | null;
  created_at: Date | string;
};

type InspirationRow = Omit<ContentRow, "rank" | "category"> & {
  image_url: string | null;
};

/**
 * 读取一个 Brief 的 Events、Digest、Long-form 与 Inspiration。
 * 可选 publishedAtScope 让重跑后的处理结果仍归属于其新闻发布时间期次。
 */
export async function getDailyBrief(
  pool: Pool,
  range: ShanghaiDayRange,
  options: DailyBriefOptions = {},
): Promise<DailyBriefResponse> {
  const [events, digests, longForm, inspiration] = await Promise.all([
    loadEvents(pool, range, options.publishedAtScope),
    loadDigestItems(pool, range, options.publishedAtScope),
    loadLongFormItems(pool, range, options.publishedAtScope),
    loadInspirationItems(pool, range, options.publishedAtScope),
  ]);
  const digestCountByCategory = countDigestsByCategory(digests);

  return {
    date: range.date,
    events,
    digests,
    long_form: longForm,
    inspiration,
    meta: {
      timezone: "Asia/Shanghai",
      date_basis: "raw_articles.published_at",
      generated_at: new Date().toISOString(),
      event_count: events.length,
      digest_count: Object.values(digests).reduce((sum, items) => sum + items.length, 0),
      digest_count_by_category: digestCountByCategory,
      long_form_count: longForm.length,
      inspiration_count: inspiration.length,
    },
  };
}

/** 以固定 Daily scope 读取 Brief，是正式 Daily attribution 的首选入口。 */
export function getDailyBriefForDailyScope(
  pool: Pool,
  scope: DailyScope,
): Promise<DailyBriefResponse> {
  return getDailyBrief(
    pool,
    {
      date: scope.dailyDate,
      startUtc: new Date(scope.startAt),
      endUtc: new Date(scope.endAt),
    },
    { publishedAtScope: scope },
  );
}

export function getDailyBriefForDailyDate(
  pool: Pool,
  dailyDate: string,
): Promise<DailyBriefResponse> {
  return getDailyBriefForDailyScope(pool, resolveDailyScope(dailyDate));
}

async function loadEvents(
  pool: Pool,
  range: ShanghaiDayRange,
  publishedAtScope?: PublishedAtScope,
): Promise<BriefEvent[]> {
  // Event 可能关联多篇候选稿；exists 避免 join 扩张导致同一 Event 重复返回。
  const scopePredicate = publishedAtScope
    ? `
        exists (
          select 1
          from processed_contents pc
          join raw_articles ra on ra.id = pc.raw_article_id
          where pc.event_id = events.id
            and pc.routing = 'event'
            and ra.published_at >= $1::timestamptz
            and ra.published_at < $2::timestamptz
        )
      `
    : `created_at >= $1::timestamptz and created_at < $2::timestamptz`;
  const eventResult = await pool.query<EventRow>(
    `
      select
        id,
        coalesce(display_rank, ai_rank) as rank,
        to_char(event_date, 'YYYY-MM-DD') as event_date,
        created_at,
        title,
        title_zh,
        summary,
        summary_zh,
        tags,
        tags_zh,
        entities,
        entities_zh,
        source_perspectives,
        external_context
      from events
      where ${scopePredicate}
        and coalesce(display_rank, ai_rank) is not null
      order by coalesce(display_rank, ai_rank) asc, created_at asc, id asc
      limit 10
    `,
    scopeValues(range, publishedAtScope),
  );

  const eventIds = eventResult.rows.map((row) => row.id);
  const sourcesByEventId = await loadEventSources(pool, eventIds);

  return eventResult.rows.map((row) => ({
    id: row.id,
    rank: row.rank,
    event_date: row.event_date,
    created_at: toIsoString(row.created_at) ?? "",
    title: row.title,
    title_zh: row.title_zh,
    summary: row.summary,
    summary_zh: row.summary_zh,
    tags: row.tags ?? [],
    tags_zh: row.tags_zh ?? [],
    entities: row.entities ?? [],
    entities_zh: row.entities_zh ?? [],
    source_perspectives: row.source_perspectives,
    sources: sourcesByEventId.get(row.id) ?? [],
    external_context: row.external_context,
  }));
}

async function loadEventSources(
  pool: Pool,
  eventIds: string[],
): Promise<Map<string, BriefEventSource[]>> {
  const sourcesByEventId = new Map<string, BriefEventSource[]>();
  if (eventIds.length === 0) {
    return sourcesByEventId;
  }

  const result = await pool.query<EventSourceRow>(
    `
      select
        pc.event_id,
        s.name as source,
        ra.title,
        ra.url
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.event_id = any($1::uuid[])
      order by pc.event_id asc, ra.published_at asc nulls last, s.name asc, pc.id asc
    `,
    [eventIds],
  );

  for (const row of result.rows) {
    const existing = sourcesByEventId.get(row.event_id) ?? [];
    existing.push({
      source: row.source,
      title: row.title,
      url: row.url,
    });
    sourcesByEventId.set(row.event_id, existing);
  }

  return sourcesByEventId;
}

async function loadDigestItems(
  pool: Pool,
  range: ShanghaiDayRange,
  publishedAtScope?: PublishedAtScope,
): Promise<Record<string, BriefContentItem[]>> {
  const result = await pool.query<ContentRow>(
    `
      select
        pc.id,
        coalesce(pc.display_rank, pc.ai_rank) as rank,
        ra.title,
        pc.title_zh,
        pc.summary,
        pc.summary_zh,
        pc.category,
        s.name as source,
        ra.url,
        ra.published_at,
        pc.created_at
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = 'digest'
        and coalesce(pc.display_rank, pc.ai_rank) is not null
        and ${publishedAtScopePredicate(publishedAtScope, "pc.created_at", "ra")}
      order by pc.category asc, coalesce(pc.display_rank, pc.ai_rank) asc, pc.created_at asc, pc.id asc
    `,
    scopeValues(range, publishedAtScope),
  );

  const digests = createEmptyDigests();
  for (const row of result.rows) {
    digests[row.category] ??= [];
    digests[row.category].push(toBriefContentItem(row));
  }

  return digests;
}

async function loadLongFormItems(
  pool: Pool,
  range: ShanghaiDayRange,
  publishedAtScope?: PublishedAtScope,
): Promise<BriefContentItem[]> {
  const result = await pool.query<ContentRow>(
    `
      select
        pc.id,
        coalesce(pc.display_rank, pc.ai_rank) as rank,
        ra.title,
        pc.title_zh,
        pc.summary,
        pc.summary_zh,
        pc.category,
        s.name as source,
        ra.url,
        ra.published_at,
        pc.created_at
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = 'long_form'
        and coalesce(pc.display_rank, pc.ai_rank) is not null
        and ${publishedAtScopePredicate(publishedAtScope, "pc.created_at", "ra")}
      order by coalesce(pc.display_rank, pc.ai_rank) asc, pc.created_at asc, pc.id asc
      limit 10
    `,
    scopeValues(range, publishedAtScope),
  );

  return result.rows.map(toBriefContentItem);
}

async function loadInspirationItems(
  pool: Pool,
  range: ShanghaiDayRange,
  publishedAtScope?: PublishedAtScope,
): Promise<BriefInspirationItem[]> {
  const result = await pool.query<InspirationRow>(
    `
      select
        pc.id,
        ra.title,
        pc.title_zh,
        pc.summary,
        pc.summary_zh,
        s.name as source,
        ra.url,
        ra.image_url,
        ra.published_at,
        pc.created_at
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      join sources s on s.id = ra.source_id
      where pc.routing = 'inspiration'
        and ${publishedAtScopePredicate(publishedAtScope, "pc.created_at", "ra")}
      order by pc.created_at asc, pc.id asc
    `,
    scopeValues(range, publishedAtScope),
  );

  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    title_zh: row.title_zh,
    summary: row.summary,
    summary_zh: row.summary_zh,
    source: row.source,
    url: row.url,
    image_url: row.image_url,
    published_at: toIsoString(row.published_at),
    created_at: toIsoString(row.created_at) ?? "",
  }));
}

function publishedAtScopePredicate(
  publishedAtScope: PublishedAtScope | undefined,
  createdAtColumn: string,
  rawArticleAlias: string,
): string {
  return publishedAtScope
    ? `${rawArticleAlias}.published_at >= $1::timestamptz and ${rawArticleAlias}.published_at < $2::timestamptz`
    : `${createdAtColumn} >= $1::timestamptz and ${createdAtColumn} < $2::timestamptz`;
}

function scopeValues(
  range: ShanghaiDayRange,
  publishedAtScope: PublishedAtScope | undefined,
): [Date, Date] | [string, string] {
  return publishedAtScope
    ? [publishedAtScope.startAt, publishedAtScope.endAt]
    : [range.startUtc, range.endUtc];
}

function createEmptyDigests(): Record<string, BriefContentItem[]> {
  return Object.fromEntries(DIGEST_CATEGORY_KEYS.map((category) => [category, []]));
}

function toBriefContentItem(row: ContentRow): BriefContentItem {
  return {
    id: row.id,
    rank: row.rank,
    title: row.title,
    title_zh: row.title_zh,
    summary: row.summary,
    summary_zh: row.summary_zh,
    source: row.source,
    url: row.url,
    published_at: toIsoString(row.published_at),
    created_at: toIsoString(row.created_at) ?? "",
  };
}

function countDigestsByCategory(
  digests: Record<string, BriefContentItem[]>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(digests).map(([category, items]) => [category, items.length]),
  );
}

function toIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date(value).toISOString();
}
