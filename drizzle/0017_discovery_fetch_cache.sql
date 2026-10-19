CREATE TABLE "discovery_fetch_cache" (
  "normalized_url" text PRIMARY KEY NOT NULL,
  "normalized_final_url" text NOT NULL,
  "original_url" text NOT NULL,
  "final_url" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'success' NOT NULL,
  "markdown" text NOT NULL,
  "is_complete" boolean NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  CONSTRAINT "discovery_fetch_cache_success_check" CHECK ("status" = 'success' and length(trim("markdown")) > 0),
  CONSTRAINT "discovery_fetch_cache_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);
--> statement-breakpoint
CREATE INDEX "discovery_fetch_cache_final_url_idx" ON "discovery_fetch_cache" ("normalized_final_url");
