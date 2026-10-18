// D2
// 从 Daily Pipeline 读取 Event、Digest、Long-form 等数据，整理成 D2 的输入
import type { DiscoveryInputContentIds } from '../db/schema.js';
import { resolveDailyScope } from '../lib/daily-scope.js';
import { getDailyBriefForDailyDate, type DailyBriefQueryable } from '../lib/daily-brief.js';

export type DiscoveryDailyDatePair = readonly [string, string];

export type DiscoveryInputItem = {
  id: string;
  dailyDate: string;
  kind: 'event' | 'digest' | 'long_form';
  directEligible: boolean;
  title: string;
  titleZh: string | null;
  summary: string | null;
  summaryZh: string | null;
  category: string | null;
  tags: string[];
  tagsZh: string[];
  sources: string[];
};

export type DiscoveryDailyInput = {
  dailyDate: string;
  events: DiscoveryInputItem[];
  digests: DiscoveryInputItem[];
  longForm: DiscoveryInputItem[];
};

export type DiscoveryWindowInput = {
  dailyDates: DiscoveryDailyDatePair;
  days: [DiscoveryDailyInput, DiscoveryDailyInput];
  contentIds: DiscoveryInputContentIds;
};

/**
 * Reads the exact public Brief selection for two explicit Daily dates, then
 * strips URLs and presentation-only fields before D2 receives the input.
 * The current Brief Event query has no display cutoff; Long-form keeps its
 * existing public cutoff through the shared query.
 */
export async function readDiscoveryDailyWindow(
  pool: DailyBriefQueryable,
  dailyDates: DiscoveryDailyDatePair,
): Promise<DiscoveryWindowInput> {
  const normalizedDates = validateDiscoveryDailyDates(dailyDates);
  const days = await Promise.all(
    normalizedDates.map((dailyDate) => readDiscoveryDaily(pool, dailyDate)),
  );

  return {
    dailyDates: normalizedDates,
    days: [days[0], days[1]],
    contentIds: toDiscoveryInputContentIds(days),
  };
}

export function validateDiscoveryDailyDates(
  dailyDates: DiscoveryDailyDatePair,
): DiscoveryDailyDatePair {
  const [startDate, endDate] = dailyDates;
  resolveDailyScope(startDate);
  resolveDailyScope(endDate);

  if (startDate >= endDate) {
    throw new Error('Discovery requires two distinct Daily dates in ascending order.');
  }

  return [startDate, endDate];
}

async function readDiscoveryDaily(
  pool: DailyBriefQueryable,
  dailyDate: string,
): Promise<DiscoveryDailyInput> {
  const brief = await getDailyBriefForDailyDate(pool, dailyDate);

  const events = brief.events.map<DiscoveryInputItem>((event) => ({
    id: event.id,
    dailyDate,
    kind: 'event',
    directEligible: false,
    title: event.title,
    titleZh: event.title_zh,
    summary: event.summary,
    summaryZh: event.summary_zh,
    category: null,
    tags: event.tags,
    tagsZh: event.tags_zh,
    sources: unique(event.sources.map((source) => source.source)),
  }));

  const digests = Object.entries(brief.digests).flatMap(([category, items]) =>
    items.map<DiscoveryInputItem>((item) => ({
      id: item.id,
      dailyDate,
      kind: 'digest',
      directEligible: false,
      title: item.title,
      titleZh: item.title_zh,
      summary: item.summary,
      summaryZh: item.summary_zh,
      category,
      tags: [],
      tagsZh: [],
      sources: [item.source],
    })),
  );

  const longForm = brief.long_form.map<DiscoveryInputItem>((item) => ({
    id: item.id,
    dailyDate,
    kind: 'long_form',
    directEligible: false,
    title: item.title,
    titleZh: item.title_zh,
    summary: item.summary,
    summaryZh: item.summary_zh,
    category: null,
    tags: [],
    tagsZh: [],
    sources: [item.source],
  }));

  const eligibleIds = await loadDirectEligibleContentIds(
    pool,
    [...digests, ...longForm].map((item) => item.id),
  );

  return {
    dailyDate,
    events,
    digests: digests.map((item) => ({ ...item, directEligible: eligibleIds.has(item.id) })),
    longForm: longForm.map((item) => ({
      ...item,
      directEligible: eligibleIds.has(item.id),
    })),
  };
}

async function loadDirectEligibleContentIds(
  pool: DailyBriefQueryable,
  contentIds: string[],
): Promise<Set<string>> {
  if (contentIds.length === 0) return new Set();

  const result = await pool.query<{ id: string }>(
    `select pc.id
      from processed_contents pc
      join raw_articles ra on ra.id = pc.raw_article_id
      where pc.id = any($1::uuid[])
        and (
          coalesce(nullif(btrim(ra.full_content_text), ''), '') <> ''
          or char_length(btrim(coalesce(ra.content_text, ''))) >= 3000
        )`,
    [contentIds],
  );

  return new Set(result.rows.map((row) => row.id));
}

export function toDiscoveryInputContentIds(
  days: readonly DiscoveryDailyInput[],
): DiscoveryInputContentIds {
  return {
    event: days.flatMap((day) =>
      day.events.map((item) => ({ dailyDate: day.dailyDate, id: item.id })),
    ),
    digest: days.flatMap((day) =>
      day.digests.map((item) => ({ dailyDate: day.dailyDate, id: item.id })),
    ),
    longForm: days.flatMap((day) =>
      day.longForm.map((item) => ({ dailyDate: day.dailyDate, id: item.id })),
    ),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
