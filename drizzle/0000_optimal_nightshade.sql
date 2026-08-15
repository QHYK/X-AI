CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_date" date NOT NULL,
	"title" text NOT NULL,
	"title_zh" text NOT NULL,
	"entities" text[],
	"entities_zh" text[],
	"summary" text NOT NULL,
	"summary_zh" text NOT NULL,
	"source_perspectives" jsonb NOT NULL,
	"conflicting_information" text[],
	"external_context" jsonb,
	"ai_rank" integer,
	"display_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"feedback_type" text NOT NULL,
	"before_value" jsonb,
	"after_value" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_article_id" uuid NOT NULL,
	"routing" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[],
	"topics" text[],
	"topics_zh" text[],
	"entities" text[],
	"entities_zh" text[],
	"content_type" text,
	"title_zh" text,
	"summary" text,
	"summary_zh" text,
	"event_id" uuid,
	"ai_rank" integer,
	"display_rank" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_contents_routing_check" CHECK ("processed_contents"."routing" in ('event', 'digest', 'long_form', 'inspiration'))
);
--> statement-breakpoint
CREATE TABLE "raw_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"source_item_origin_id" text,
	"title" text NOT NULL,
	"url" text,
	"author" text,
	"published_at" timestamp with time zone,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_text" text,
	"image_url" text,
	"source_tags" text[],
	"metadata" jsonb,
	"stage1_status" text NOT NULL,
	"stage1_processed_at" timestamp with time zone,
	"processing_error" text
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"source_type" text,
	"url" text NOT NULL,
	"collection_method" text NOT NULL,
	"priority" text NOT NULL,
	"enabled" boolean NOT NULL,
	"event_candidate" boolean NOT NULL,
	"source_digest_candidate" boolean NOT NULL,
	"language" text NOT NULL,
	"availability" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "processed_contents" ADD CONSTRAINT "processed_contents_raw_article_id_raw_articles_id_fk" FOREIGN KEY ("raw_article_id") REFERENCES "public"."raw_articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_contents" ADD CONSTRAINT "processed_contents_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_articles" ADD CONSTRAINT "raw_articles_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_event_date_idx" ON "events" USING btree ("event_date");--> statement-breakpoint
CREATE INDEX "events_display_rank_idx" ON "events" USING btree ("display_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_contents_raw_article_id_unique" ON "processed_contents" USING btree ("raw_article_id");--> statement-breakpoint
CREATE INDEX "processed_contents_routing_idx" ON "processed_contents" USING btree ("routing");--> statement-breakpoint
CREATE INDEX "processed_contents_event_id_idx" ON "processed_contents" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "processed_contents_display_rank_idx" ON "processed_contents" USING btree ("display_rank");--> statement-breakpoint
CREATE INDEX "raw_articles_source_id_idx" ON "raw_articles" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "raw_articles_published_at_idx" ON "raw_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "raw_articles_stage1_status_idx" ON "raw_articles" USING btree ("stage1_status");