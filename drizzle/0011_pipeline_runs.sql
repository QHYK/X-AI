CREATE TABLE "pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "daily_date" date NOT NULL,
  "step" text NOT NULL,
  "status" text NOT NULL,
  "trigger_source" text NOT NULL,
  "provider" text,
  "model" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pipeline_runs_daily_step_started_idx" ON "pipeline_runs" USING btree ("daily_date","step","started_at" DESC);
