CREATE TABLE "event_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_run_id" uuid NOT NULL,
	"daily_date" date NOT NULL,
	"event_temp_id" text NOT NULL,
	"event_hint" text NOT NULL,
	"ai_rank" integer NOT NULL,
	"display_rank" integer NOT NULL,
	"member_content_ids" uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "event_review_items_daily_date_idx" ON "event_review_items" USING btree ("daily_date");--> statement-breakpoint
CREATE UNIQUE INDEX "event_review_items_run_temp_unique" ON "event_review_items" USING btree ("review_run_id","event_temp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_review_items_run_ai_rank_unique" ON "event_review_items" USING btree ("review_run_id","ai_rank");--> statement-breakpoint
CREATE UNIQUE INDEX "event_review_items_run_display_rank_unique" ON "event_review_items" USING btree ("review_run_id","display_rank");