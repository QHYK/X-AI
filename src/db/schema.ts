import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const sources = pgTable("sources", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  sourceType: text("source_type"),
  url: text("url").notNull(),
  collectionMethod: text("collection_method").notNull(),
  priority: text("priority").notNull(),
  enabled: boolean("enabled").notNull(),
  eventCandidate: boolean("event_candidate").notNull(),
  sourceDigestCandidate: boolean("source_digest_candidate").notNull(),
  language: text("language").notNull(),
  availability: text("availability"),
  notes: text("notes"),
  ...timestamps,
});

export const rawArticles = pgTable(
  "raw_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id),
    sourceItemOriginId: text("source_item_origin_id"),
    title: text("title").notNull(),
    url: text("url"),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull().defaultNow(),
    contentText: text("content_text"),
    imageUrl: text("image_url"),
    sourceTags: text("source_tags").array(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    stage1Status: text("stage1_status").notNull(),
    stage1ProcessedAt: timestamp("stage1_processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
  },
  (table) => [
    index("raw_articles_source_id_idx").on(table.sourceId),
    index("raw_articles_published_at_idx").on(table.publishedAt),
    index("raw_articles_stage1_status_idx").on(table.stage1Status),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventDate: date("event_date").notNull(),
    title: text("title").notNull(),
    titleZh: text("title_zh").notNull(),
    eventTags: text("event_tags").array(),
    eventTagsZh: text("event_tags_zh").array(),
    entities: text("entities").array(),
    entitiesZh: text("entities_zh").array(),
    summary: text("summary").notNull(),
    summaryZh: text("summary_zh").notNull(),
    sourcePerspectives: jsonb("source_perspectives").notNull(),
    conflictingInformation: text("conflicting_information").array(),
    externalContext: jsonb("external_context"),
    aiRank: integer("ai_rank"),
    displayRank: integer("display_rank"),
    ...timestamps,
  },
  (table) => [
    index("events_event_date_idx").on(table.eventDate),
    index("events_display_rank_idx").on(table.displayRank),
  ],
);

export const processedContents = pgTable(
  "processed_contents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rawArticleId: uuid("raw_article_id")
      .notNull()
      .references(() => rawArticles.id),
    routing: text("routing").notNull(),
    category: text("category").notNull(),
    tags: text("tags").array(),
    entities: text("entities").array(),
    entitiesZh: text("entities_zh").array(),
    titleZh: text("title_zh"),
    summary: text("summary"),
    summaryZh: text("summary_zh"),
    eventId: uuid("event_id").references(() => events.id),
    aiRank: integer("ai_rank"),
    displayRank: integer("display_rank"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("processed_contents_raw_article_id_unique").on(table.rawArticleId),
    index("processed_contents_routing_idx").on(table.routing),
    index("processed_contents_event_id_idx").on(table.eventId),
    index("processed_contents_display_rank_idx").on(table.displayRank),
    check(
      "processed_contents_routing_check",
      sql`${table.routing} in ('event', 'digest', 'long_form', 'inspiration')`,
    ),
  ],
);

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  feedbackType: text("feedback_type").notNull(),
  beforeValue: jsonb("before_value"),
  afterValue: jsonb("after_value"),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type RawArticle = typeof rawArticles.$inferSelect;
export type NewRawArticle = typeof rawArticles.$inferInsert;
export type ProcessedContent = typeof processedContents.$inferSelect;
export type NewProcessedContent = typeof processedContents.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
