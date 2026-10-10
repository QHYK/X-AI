CREATE TABLE "content_read_more" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content_id" uuid NOT NULL REFERENCES "processed_contents"("id") ON DELETE cascade,
  "summary_zh" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "content_read_more_content_id_unique" ON "content_read_more" USING btree ("content_id");
