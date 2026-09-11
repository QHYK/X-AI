CREATE TABLE "event_groups" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "daily_date" date NOT NULL, "event_hint" text NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "updated_at" timestamp with time zone DEFAULT now() NOT NULL);
--> statement-breakpoint
CREATE TABLE "event_group_items" ("event_group_id" uuid NOT NULL, "processed_content_id" uuid NOT NULL);
--> statement-breakpoint
CREATE TABLE "stage4_runs" ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL, "daily_date" date NOT NULL, "review_run_id" uuid NOT NULL, "status" text NOT NULL, "expected_count" integer NOT NULL, "success_count" integer DEFAULT 0 NOT NULL, "created_at" timestamp with time zone DEFAULT now() NOT NULL, "completed_at" timestamp with time zone);
--> statement-breakpoint
ALTER TABLE "event_review_items" ADD COLUMN "event_group_id" uuid;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "stage4_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "publication_status" text DEFAULT 'published' NOT NULL;
--> statement-breakpoint
ALTER TABLE "event_group_items" ADD CONSTRAINT "egi_group_fk" FOREIGN KEY ("event_group_id") REFERENCES "event_groups"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "event_group_items" ADD CONSTRAINT "egi_content_fk" FOREIGN KEY ("processed_content_id") REFERENCES "processed_contents"("id");
--> statement-breakpoint
ALTER TABLE "event_review_items" ADD CONSTRAINT "eri_group_fk" FOREIGN KEY ("event_group_id") REFERENCES "event_groups"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_stage4_run_fk" FOREIGN KEY ("stage4_run_id") REFERENCES "stage4_runs"("id");
--> statement-breakpoint
CREATE INDEX "event_groups_daily_date_idx" ON "event_groups" ("daily_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "egi_group_content_unique" ON "event_group_items" ("event_group_id","processed_content_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "egi_content_unique" ON "event_group_items" ("processed_content_id");
--> statement-breakpoint
CREATE INDEX "stage4_runs_daily_date_idx" ON "stage4_runs" ("daily_date");
--> statement-breakpoint
CREATE UNIQUE INDEX "stage4_runs_review_unique" ON "stage4_runs" ("review_run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "eri_run_group_unique" ON "event_review_items" ("review_run_id","event_group_id");
--> statement-breakpoint
DROP INDEX "events_event_review_item_id_unique";
--> statement-breakpoint
CREATE INDEX "events_stage4_run_id_idx" ON "events" ("stage4_run_id");
--> statement-breakpoint
CREATE INDEX "events_publication_status_idx" ON "events" ("publication_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "events_run_review_item_unique" ON "events" ("stage4_run_id","event_review_item_id");
