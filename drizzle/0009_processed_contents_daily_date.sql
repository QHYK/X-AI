ALTER TABLE "processed_contents" ADD COLUMN "daily_date" date;
--> statement-breakpoint
CREATE INDEX "processed_contents_daily_date_idx" ON "processed_contents" USING btree ("daily_date");
