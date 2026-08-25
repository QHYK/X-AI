/**
 * RSS 采集与标准化模块，是 Workflow 的原始输入边界。
 *
 * 负责从启用 Source 读取 feed、保留采集元数据，并以来源 ID 或 URL 实现可重复执行的去重写入。
 */
import Parser from "rss-parser";
import type { Pool, PoolClient } from "pg";

export type RssSource = {
  id: string;
  name: string;
  category: string;
  sourceType: string | null;
  url: string;
};

export type NormalizedRawArticle = {
  sourceItemOriginId: string | null;
  title: string;
  url: string | null;
  author: string | null;
  publishedAt: Date | null;
  contentText: string | null;
  imageUrl: string | null;
  sourceTags: string[] | null;
  metadata: Record<string, unknown> | null;
};

export type SourceCollectionResult = {
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  status: "success" | "failure";
  lookbackDays: number;
  fetchedItemCount: number;
  windowItemCount: number;
  insertedItemCount: number;
  skippedDuplicateCount: number;
  skippedOutOfWindowCount: number;
  skippedInvalidCount: number;
  error: string | null;
};

export type RssCollectionSummary = {
  sourceCount: number;
  successSourceCount: number;
  failureSourceCount: number;
  fetchedItemCount: number;
  windowItemCount: number;
  insertedItemCount: number;
  skippedDuplicateCount: number;
  skippedOutOfWindowCount: number;
  skippedInvalidCount: number;
  results: SourceCollectionResult[];
};

type ContentChoice = {
  field: string | null;
  text: string | null;
  fields: Record<string, { present: boolean; textLength: number }>;
};

const RSS_CONCURRENCY = Number(process.env.RSS_COLLECTOR_CONCURRENCY ?? 4);
const RSS_FETCH_TIMEOUT_MS = Number(process.env.RSS_FETCH_TIMEOUT_MS ?? 20_000);
const REGULAR_LOOKBACK_DAYS = 7;
const POLICY_LOOKBACK_DAYS = 90;

const parser = new Parser<Record<string, unknown>, Record<string, unknown>>({
  customFields: {
    feed: ["language", "copyright", "generator", "lastBuildDate", "updated", "image"],
    item: [
      ["content:encoded", "contentEncoded"],
      ["content:encodedSnippet", "contentEncodedSnippet"],
      ["dc:creator", "dcCreator"],
      ["dc:date", "dcDate"],
      ["atom:id", "atomId"],
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["media:description", "mediaDescription"],
      ["media:credit", "mediaCredit"],
      ["media:title", "mediaTitle"],
      ["itunes:image", "itunesImage"],
      "image",
      "source",
      "comments",
    ],
  },
});

const COMMON_ITEM_KEYS = new Set([
  "creator",
  "title",
  "link",
  "pubDate",
  "author",
  "content",
  "contentSnippet",
  "guid",
  "id",
  "url",
  "summary",
  "description",
  "category",
  "categories",
  "isoDate",
  "content:encoded",
  "contentEncoded",
  "content:encodedSnippet",
  "contentEncodedSnippet",
  "dc:creator",
  "dcCreator",
  "dcDate",
  "atomId",
  "atom:id",
  "media:content",
  "mediaContent",
  "media:thumbnail",
  "mediaThumbnail",
  "media:description",
  "mediaDescription",
  "media:credit",
  "mediaCredit",
  "media:title",
  "mediaTitle",
  "itunes:image",
  "itunesImage",
  "image",
  "source",
  "comments",
  "enclosure",
]);

/** 并发采集全部启用的 RSS Source，并返回按来源可追踪的汇总结果。 */
export async function collectRssSources(pool: Pool): Promise<RssCollectionSummary> {
  const sources = await loadEnabledRssSources(pool);
  const results = await runWithConcurrency(
    sources,
    Math.max(1, RSS_CONCURRENCY),
    (source) => collectRssSource(pool, source),
  );

  return summarizeResults(results);
}

export async function loadEnabledRssSources(pool: Pool): Promise<RssSource[]> {
  const result = await pool.query<RssSource>(
    `
      select
        id,
        name,
        category,
        source_type as "sourceType",
        url
      from sources
      where collection_method = 'RSS'
        and enabled = true
      order by name
    `,
  );

  return result.rows;
}

async function collectRssSource(pool: Pool, source: RssSource): Promise<SourceCollectionResult> {
  const lookbackDays = getLookbackDays(source);
  const baseResult: SourceCollectionResult = {
    sourceId: source.id,
    sourceName: source.name,
    sourceUrl: source.url,
    status: "failure",
    lookbackDays,
    fetchedItemCount: 0,
    windowItemCount: 0,
    insertedItemCount: 0,
    skippedDuplicateCount: 0,
    skippedOutOfWindowCount: 0,
    skippedInvalidCount: 0,
    error: null,
  };

  try {
    const feedXml = await fetchFeedXml(source.url);
    const feed = await parser.parseString(feedXml);
    const cutoff = getCutoffDate(lookbackDays);

    baseResult.fetchedItemCount = feed.items.length;

    const client = await pool.connect();
    try {
      for (const item of feed.items) {
        const article = normalizeItem(item, source);
        if (!article.title) {
          baseResult.skippedInvalidCount += 1;
          continue;
        }

        if (!isInLookbackWindow(article.publishedAt, cutoff)) {
          baseResult.skippedOutOfWindowCount += 1;
          continue;
        }

        baseResult.windowItemCount += 1;

        const dedupeKey = getDedupeKey(article);
        if (!dedupeKey) {
          baseResult.skippedInvalidCount += 1;
          continue;
        }

        if (await rawArticleExists(client, source.id, dedupeKey)) {
          baseResult.skippedDuplicateCount += 1;
          continue;
        }

        await insertRawArticle(client, source.id, article);
        baseResult.insertedItemCount += 1;
      }
    } finally {
      client.release();
    }

    return {
      ...baseResult,
      status: "success",
    };
  } catch (error) {
    return {
      ...baseResult,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
        "user-agent":
          "Mozilla/5.0 (compatible; X-AI-field RSS collector; +https://example.local/rss-collector)",
      },
    });

    if (!response.ok) {
      throw new Error(`Status code ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeItem(
  item: Record<string, unknown>,
  source: RssSource,
): NormalizedRawArticle {
  const contentChoice = chooseContentText(item);

  return {
    sourceItemOriginId:
      stringValue(item.guid) ?? stringValue(item.atomId) ?? stringValue(item.id) ?? null,
    title: stringValue(item.title) ?? "",
    url: stringValue(item.link) ?? stringValue(item.url) ?? null,
    author:
      stringValue(item.creator) ??
      stringValue(item.dcCreator) ??
      stringValue(item.author) ??
      null,
    publishedAt:
      parseDate(item.isoDate) ?? parseDate(item.pubDate) ?? parseDate(item.dcDate) ?? null,
    contentText: contentChoice.text,
    imageUrl: extractImageUrl(item),
    sourceTags: extractCategories(item),
    metadata: buildMetadata(item, source, contentChoice),
  };
}

/**
 * 从不同 feed 字段选取最可用的正文，同时记录字段状态。
 * 偏好完整正文但仍允许摘要回退，以适应来源格式的不一致。
 */
function chooseContentText(item: Record<string, unknown>): ContentChoice {
  const candidates = [
    ["contentEncoded", item.contentEncoded],
    ["content", item.content],
    ["contentSnippet", item.contentSnippet],
    ["summary", item.summary],
    ["description", item.description],
    ["mediaDescription", item.mediaDescription],
  ] as const;

  const fields: ContentChoice["fields"] = {};
  let best: { field: string | null; text: string | null; score: number } = {
    field: null,
    text: null,
    score: -1,
  };

  for (const [field, value] of candidates) {
    const rawText = stringValue(value);
    const text = cleanText(rawText);
    fields[field] = {
      present: rawText !== null,
      textLength: text.length,
    };

    if (!text) {
      continue;
    }

    const score = text.length + contentPreferenceBoost(field);
    if (score > best.score) {
      best = { field, text, score };
    }
  }

  return {
    field: best.field,
    text: best.text,
    fields,
  };
}

function contentPreferenceBoost(field: string): number {
  switch (field) {
    case "contentEncoded":
      return 500;
    case "content":
      return 350;
    case "description":
    case "summary":
      return 150;
    case "contentSnippet":
      return 50;
    default:
      return 0;
  }
}

function buildMetadata(
  item: Record<string, unknown>,
  source: RssSource,
  contentChoice: ContentChoice,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    collector: "rss",
    source_name: source.name,
    source_feed_url: source.url,
    content_field_status: contentChoice.fields,
    selected_content_field: contentChoice.field,
  };

  for (const [key, value] of Object.entries(item)) {
    if (COMMON_ITEM_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }

    metadata[key] = value;
  }

  for (const key of [
    "contentEncodedSnippet",
    "mediaDescription",
    "mediaCredit",
    "mediaTitle",
    "source",
    "comments",
  ]) {
    if (item[key] !== undefined && item[key] !== null) {
      metadata[key] = item[key];
    }
  }

  return metadata;
}

function extractImageUrl(item: Record<string, unknown>): string | null {
  const enclosureUrl = objectStringValue(item.enclosure, "url");
  if (enclosureUrl && isLikelyImage(enclosureUrl, objectStringValue(item.enclosure, "type"))) {
    return enclosureUrl;
  }

  const mediaContentUrl = firstObjectStringValue(item.mediaContent, "url");
  if (mediaContentUrl) {
    return mediaContentUrl;
  }

  const mediaThumbnailUrl = firstObjectStringValue(item.mediaThumbnail, "url");
  if (mediaThumbnailUrl) {
    return mediaThumbnailUrl;
  }

  const itunesImageUrl =
    objectStringValue(item.itunesImage, "href") ?? stringValue(item.itunesImage);
  if (itunesImageUrl) {
    return itunesImageUrl;
  }

  const imageUrl =
    objectStringValue(item.image, "url") ??
    objectStringValue(item.image, "href") ??
    stringValue(item.image);
  if (imageUrl) {
    return imageUrl;
  }

  return extractFirstImageFromHtml(
    stringValue(item.contentEncoded) ??
      stringValue(item.content) ??
      stringValue(item.description) ??
      "",
  );
}

function extractCategories(item: Record<string, unknown>): string[] | null {
  const rawCategories = Array.isArray(item.categories)
    ? item.categories
    : item.category
      ? [item.category]
      : [];

  const categories = rawCategories
    .map((category) => {
      if (typeof category === "string") {
        return category.trim();
      }

      if (category && typeof category === "object") {
        const record = category as Record<string, unknown>;
        return stringValue(record._) ?? objectStringValue(record.$, "term") ?? stringValue(record.term);
      }

      return null;
    })
    .filter((category): category is string => Boolean(category));

  return categories.length > 0 ? [...new Set(categories)] : null;
}

type DedupeKey =
  | { kind: "origin_id"; value: string }
  | { kind: "url"; value: string };

function getDedupeKey(article: NormalizedRawArticle): DedupeKey | null {
  if (article.sourceItemOriginId) {
    return {
      kind: "origin_id",
      value: article.sourceItemOriginId,
    };
  }

  if (article.url) {
    return {
      kind: "url",
      value: article.url,
    };
  }

  return null;
}

/** 根据 source 内稳定 origin ID 优先、URL 回退的规则检查重复，保障 RSS 重跑幂等。 */
async function rawArticleExists(
  client: PoolClient,
  sourceId: string,
  dedupeKey: DedupeKey,
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    dedupeKey.kind === "origin_id"
      ? `
          select id
          from raw_articles
          where source_id = $1
            and source_item_origin_id = $2
          limit 1
        `
      : `
          select id
          from raw_articles
          where source_id = $1
            and url = $2
          limit 1
        `,
    [sourceId, dedupeKey.value],
  );

  return result.rowCount !== null && result.rowCount > 0;
}

async function insertRawArticle(
  client: PoolClient,
  sourceId: string,
  article: NormalizedRawArticle,
) {
  await client.query(
    `
      insert into raw_articles (
        source_id,
        source_item_origin_id,
        title,
        url,
        author,
        published_at,
        collected_at,
        content_text,
        image_url,
        source_tags,
        metadata,
        stage1_status
      )
      values ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, 'pending')
    `,
    [
      sourceId,
      article.sourceItemOriginId,
      article.title,
      article.url,
      article.author,
      article.publishedAt,
      article.contentText,
      article.imageUrl,
      article.sourceTags,
      JSON.stringify(article.metadata),
    ],
  );
}

function getLookbackDays(source: RssSource): number {
  const sourceType = source.sourceType?.toLowerCase() ?? "";
  if (source.category === "Policy" || sourceType.includes("government")) {
    return POLICY_LOOKBACK_DAYS;
  }

  return REGULAR_LOOKBACK_DAYS;
}

function getCutoffDate(lookbackDays: number): Date {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
  return cutoff;
}

function isInLookbackWindow(publishedAt: Date | null, cutoff: Date): boolean {
  return publishedAt === null || publishedAt >= cutoff;
}

function parseDate(value: unknown): Date | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value: string | null): string {
  if (!value) {
    return "";
  }

  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function objectStringValue(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return stringValue(record[key]) ?? objectStringValue(record.$, key);
}

function firstObjectStringValue(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = objectStringValue(item, key);
      if (found) {
        return found;
      }
    }
    return null;
  }

  return objectStringValue(value, key);
}

function isLikelyImage(url: string, mimeType: string | null): boolean {
  if (mimeType?.startsWith("image/")) {
    return true;
  }

  return /\.(avif|gif|jpe?g|png|webp)(\?|#|$)/i.test(url);
}

function extractFirstImageFromHtml(html: string): string | null {
  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  return match?.[1] ?? null;
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;

  async function runWorker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()),
  );

  return results;
}

function summarizeResults(results: SourceCollectionResult[]): RssCollectionSummary {
  return {
    sourceCount: results.length,
    successSourceCount: results.filter((result) => result.status === "success").length,
    failureSourceCount: results.filter((result) => result.status === "failure").length,
    fetchedItemCount: sumBy(results, (result) => result.fetchedItemCount),
    windowItemCount: sumBy(results, (result) => result.windowItemCount),
    insertedItemCount: sumBy(results, (result) => result.insertedItemCount),
    skippedDuplicateCount: sumBy(results, (result) => result.skippedDuplicateCount),
    skippedOutOfWindowCount: sumBy(results, (result) => result.skippedOutOfWindowCount),
    skippedInvalidCount: sumBy(results, (result) => result.skippedInvalidCount),
    results,
  };
}

function sumBy<T>(items: T[], getValue: (item: T) => number): number {
  return items.reduce((sum, item) => sum + getValue(item), 0);
}
