import type { Pool } from "pg";
import type { ShanghaiDayRange } from "./brief-date.js";

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
    date_basis: "created_at";
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

export async function getDailyBrief(
  pool: Pool,
  range: ShanghaiDayRange,
): Promise<DailyBriefResponse> {
  const [events, digests, longForm, inspiration] = await Promise.all([
    loadEvents(pool, range),
    loadDigestItems(pool, range),
    loadLongFormItems(pool, range),
    loadInspirationItems(pool, range),
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
      date_basis: "created_at",
      generated_at: new Date().toISOString(),
      event_count: events.length,
      digest_count: Object.values(digests).reduce((sum, items) => sum + items.length, 0),
      digest_count_by_category: digestCountByCategory,
      long_form_count: longForm.length,
      inspiration_count: inspiration.length,
    },
  };
}

async function loadEvents(pool: Pool, range: ShanghaiDayRange): Promise<BriefEvent[]> {
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
      where created_at >= $1::timestamptz
        and created_at < $2::timestamptz
        and coalesce(display_rank, ai_rank) is not null
      order by coalesce(display_rank, ai_rank) asc, created_at asc, id asc
      limit 10
    `,
    [range.startUtc, range.endUtc],
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
      order by pc.event_id asc, coalesce(ra.published_at, ra.collected_at) asc, s.name asc, pc.id asc
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
        and pc.created_at >= $1::timestamptz
        and pc.created_at < $2::timestamptz
      order by pc.category asc, coalesce(pc.display_rank, pc.ai_rank) asc, pc.created_at asc, pc.id asc
    `,
    [range.startUtc, range.endUtc],
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
        and pc.created_at >= $1::timestamptz
        and pc.created_at < $2::timestamptz
      order by coalesce(pc.display_rank, pc.ai_rank) asc, pc.created_at asc, pc.id asc
      limit 10
    `,
    [range.startUtc, range.endUtc],
  );

  return result.rows.map(toBriefContentItem);
}

async function loadInspirationItems(
  pool: Pool,
  range: ShanghaiDayRange,
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
        and pc.created_at >= $1::timestamptz
        and pc.created_at < $2::timestamptz
      order by pc.created_at asc, pc.id asc
    `,
    [range.startUtc, range.endUtc],
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
