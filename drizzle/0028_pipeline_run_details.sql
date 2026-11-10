ALTER TABLE "pipeline_runs" ADD COLUMN "details" jsonb NOT NULL DEFAULT '{}'::jsonb;
