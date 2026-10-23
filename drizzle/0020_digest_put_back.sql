ALTER TABLE "processed_contents" ADD COLUMN "put_back_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "processed_contents" ADD CONSTRAINT "processed_contents_put_back_check"
  CHECK (put_back_at IS NULL OR (routing = 'digest' AND ai_rank IS NULL AND display_rank IS NOT NULL));
