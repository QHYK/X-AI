import Parser from "rss-parser";
import { inspect } from "node:util";

type NormalizedRawArticle = {
  source_item_origin_id: string | null;
  title: string;
  url: string | null;
  author: string | null;
  published_at: string | null;
  content_text: string;
  image_url: string | null;
  source_tags: string[] | null;
  metadata: Record<string, unknown> | null;
};

type FeedSource = {
  name: string;
  url: string;
};

type FieldPresence = {
  feedFields: Set<string>;
  itemFields: Set<string>;
  contentFields: Set<string>;
  stableMappings: Set<keyof NormalizedRawArticle>;
  metadataFields: Set<string>;
  feedItemCount: number | null;
  errors: string[];
};

type SpikeResult = {
  source: FeedSource;
  normalizedItems: NormalizedRawArticle[];
  report: FieldPresence;
};

const SOURCES: FeedSource[] = [
  {
    name: "Bloomberg Technology",
    url: "https://feeds.bloomberg.com/technology/news.rss",
  },
  {
    name: "Dow Jones",
    url: "https://feeds.content.dowjones.io/public/rss/socialeconomyfeed",
  },
  {
    name: "BLS",
    url: "https://www.bls.gov/feed/bls_latest.rss",
  },
  {
    name: "TechCrunch",
    url: "https://techcrunch.com/feed/",
  },
  {
    name: "Nature Chemistry",
    url: "https://www.nature.com/subjects/chemistry.rss",
  },
  {
    name: "SemiAnalysis",
    url: "https://semianalysis.com/feed/",
  },
  {
    name: "NASA Image of the Day",
    url: "https://www.nasa.gov/rss/image_of_the_day.rss",
  },
];

const ITEMS_PER_SOURCE = 3;

const parser = new Parser<Record<string, unknown>, Record<string, unknown>>({
  customFields: {
    feed: [
      "language",
      "copyright",
      "generator",
      "lastBuildDate",
      "updated",
      "image",
    ],
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

async function main() {
  const results: SpikeResult[] = [];

  for (const source of SOURCES) {
    results.push(await inspectSource(source));
  }

  for (const result of results) {
    printSourceOutput(result);
  }

  printFinalReport(results);
}

async function inspectSource(source: FeedSource): Promise<SpikeResult> {
  const report = emptyReport();

  try {
    const feedXml = await fetchFeedXml(source.url);
    const feed = await parser.parseString(feedXml);
    collectKeys(feed, report.feedFields, ["items"]);
    report.feedItemCount = feed.items.length;

    const items = feed.items.slice(0, ITEMS_PER_SOURCE);
    const normalizedItems = items.map((item) => {
      collectKeys(item, report.itemFields);
      collectContentFieldPresence(item, report.contentFields);

      const normalized = normalizeItem(item, source, report);
      for (const key of Object.keys(normalized) as (keyof NormalizedRawArticle)[]) {
        const value = normalized[key];
        if (
          value !== null &&
          !(Array.isArray(value) && value.length === 0) &&
          !(typeof value === "string" && value.trim() === "")
        ) {
          report.stableMappings.add(key);
        }
      }

      return normalized;
    });

    return {
      source,
      normalizedItems,
      report,
    };
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return {
      source,
      normalizedItems: [],
      report,
    };
  }
}

async function fetchFeedXml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "user-agent":
        "Mozilla/5.0 (compatible; X-AI-field RSS spike; +https://example.local/rss-spike)",
    },
  });

  if (!response.ok) {
    throw new Error(`Status code ${response.status}`);
  }

  return response.text();
}

function normalizeItem(
  item: Record<string, unknown>,
  source: FeedSource,
  report: FieldPresence,
): NormalizedRawArticle {
  const contentChoice = chooseContentText(item);
  const metadata = buildMetadata(item, source, contentChoice.field, report);

  return {
    source_item_origin_id:
      stringValue(item.guid) ?? stringValue(item.atomId) ?? stringValue(item.id) ?? null,
    title: stringValue(item.title) ?? "",
    url: stringValue(item.link) ?? stringValue(item.url) ?? null,
    author:
      stringValue(item.creator) ??
      stringValue(item.dcCreator) ??
      stringValue(item.author) ??
      null,
    published_at:
      normalizeDate(item.isoDate) ??
      normalizeDate(item.pubDate) ??
      normalizeDate(item.dcDate) ??
      null,
    content_text: contentChoice.text,
    image_url: extractImageUrl(item),
    source_tags: extractCategories(item),
    metadata,
  };
}

function chooseContentText(item: Record<string, unknown>): {
  field: string | null;
  text: string;
  fields: Record<string, { present: boolean; textLength: number }>;
} {
  const candidates = [
    ["contentEncoded", item.contentEncoded],
    ["content", item.content],
    ["contentSnippet", item.contentSnippet],
    ["summary", item.summary],
    ["description", item.description],
    ["mediaDescription", item.mediaDescription],
  ] as const;

  const fields: Record<string, { present: boolean; textLength: number }> = {};
  let best: { field: string | null; text: string; score: number } = {
    field: null,
    text: "",
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

function buildMetadata(
  item: Record<string, unknown>,
  source: FeedSource,
  selectedContentField: string | null,
  report: FieldPresence,
): Record<string, unknown> | null {
  const contentChoice = chooseContentText(item);
  const metadata: Record<string, unknown> = {
    source_name: source.name,
    source_feed_url: source.url,
    content_field_status: contentChoice.fields,
    selected_content_field: selectedContentField,
  };

  for (const [key, value] of Object.entries(item)) {
    if (COMMON_ITEM_KEYS.has(key) || value === undefined || value === null) {
      continue;
    }

    metadata[key] = value;
    report.metadataFields.add(key);
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
      report.metadataFields.add(key);
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
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

function normalizeDate(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
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

function collectKeys(
  value: Record<string, unknown>,
  target: Set<string>,
  ignoredKeys: string[] = [],
) {
  const ignored = new Set(ignoredKeys);

  for (const key of Object.keys(value)) {
    if (!ignored.has(key)) {
      target.add(key);
    }
  }
}

function collectContentFieldPresence(item: Record<string, unknown>, target: Set<string>) {
  for (const key of [
    "contentEncoded",
    "content",
    "contentSnippet",
    "summary",
    "description",
    "mediaDescription",
  ]) {
    if (stringValue(item[key])) {
      target.add(key);
    }
  }
}

function emptyReport(): FieldPresence {
  return {
    feedFields: new Set(),
    itemFields: new Set(),
    contentFields: new Set(),
    stableMappings: new Set(),
    metadataFields: new Set(),
    feedItemCount: null,
    errors: [],
  };
}

function printSourceOutput(result: SpikeResult) {
  console.log(`\n## ${result.source.name}`);
  console.log(result.source.url);

  if (result.report.errors.length > 0) {
    console.log(
      JSON.stringify(
        {
          error: result.report.errors.join("; "),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(JSON.stringify(result.normalizedItems, null, 2));
}

function printFinalReport(results: SpikeResult[]) {
  console.log("\n# Final Report");

  for (const result of results) {
    const report = result.report;
    console.log(`\n## ${result.source.name}`);
    console.log(
      `1. RSS fields: feed_items=${report.feedItemCount ?? 0}; normalized_items=${result.normalizedItems.length}; feed=${formatSet(report.feedFields)}; item=${formatSet(report.itemFields)}`,
    );
    console.log(`2. Stable mappings: ${formatSet(report.stableMappings)}`);
    console.log(`3. Metadata-only fields: ${formatSet(report.metadataFields)}`);
    console.log(
      `   Content fields observed: ${formatSet(report.contentFields)}. Per-item content field status is stored in metadata.content_field_status.`,
    );
    console.log(
      `4. Parse status: ${report.errors.length > 0 ? `failed (${report.errors.join("; ")})` : "ok"}`,
    );
  }

  const failedSources = results.filter((result) => result.report.errors.length > 0);
  const imageCoverage = results.map((result) => ({
    source: result.source.name,
    imageItems: result.normalizedItems.filter((item) => item.image_url).length,
    totalItems: result.normalizedItems.length,
  }));

  console.log("\n## Schema Notes");
  console.log(
    [
      "The proposed raw_articles shape is sufficient for this spike: IDs, title, URL, author, published time, readable text, image URL, tags, and metadata cover the tested feeds.",
      "Do not add source-specific columns yet. Fields like media credit/title, comments, source feed object, and parser extras are uneven and fit metadata.",
      "Keep metadata.content_field_status because feeds vary between content, content:encoded, contentSnippet, description, and media description.",
      "Consider making content_text nullable only if empty RSS summaries should be stored; otherwise keep it required and filter empty items before DB insertion.",
      `Parsing failures: ${failedSources.length === 0 ? "none" : failedSources.map((result) => result.source.name).join(", ")}.`,
      `Image coverage: ${imageCoverage.map((entry) => `${entry.source} ${entry.imageItems}/${entry.totalItems}`).join("; ")}.`,
    ].join("\n"),
  );
}

function formatSet(values: Set<unknown>): string {
  if (values.size === 0) {
    return "(none)";
  }

  return [...values].map((value) => inspect(value, { depth: 2, breakLength: 120 })).join(", ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
