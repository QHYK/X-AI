CREATE TABLE "discovery_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "parent_run_id" uuid,
  "source_lead_id" text,
  "run_type" text NOT NULL,
  "trigger_source" text NOT NULL,
  "status" text NOT NULL,
  "end_reason" text,
  "window_start_date" date,
  "window_end_date" date,
  "input_content_ids" jsonb,
  "selection_output" jsonb,
  "config_snapshot" jsonb,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "error_summary" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_runs_parent_run_id_discovery_runs_id_fk"
    FOREIGN KEY ("parent_run_id") REFERENCES "public"."discovery_runs"("id"),
  CONSTRAINT "discovery_runs_type_check"
    CHECK ("run_type" IN ('regular', 'single_lead', 'open')),
  CONSTRAINT "discovery_runs_trigger_source_check"
    CHECK ("trigger_source" IN ('schedule', 'manual')),
  CONSTRAINT "discovery_runs_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'partial', 'failed', 'blocked')),
  CONSTRAINT "discovery_runs_end_reason_check"
    CHECK ("end_reason" IS NULL OR "end_reason" IN ('candidates_found', 'no_candidates', 'timeout', 'budget_exhausted', 'upstream_not_ready', 'error')),
  CONSTRAINT "discovery_runs_relationship_check"
    CHECK (
      ("run_type" = 'regular' AND "parent_run_id" IS NULL AND "source_lead_id" IS NULL)
      OR ("run_type" = 'single_lead' AND "parent_run_id" IS NOT NULL AND "source_lead_id" IS NOT NULL)
      OR ("run_type" = 'open' AND "parent_run_id" IS NOT NULL AND "source_lead_id" IS NULL)
    ),
  CONSTRAINT "discovery_runs_parent_not_self_check"
    CHECK ("parent_run_id" IS NULL OR "parent_run_id" <> "id"),
  CONSTRAINT "discovery_runs_window_check"
    CHECK (
      ("window_start_date" IS NULL AND "window_end_date" IS NULL)
      OR ("window_start_date" IS NOT NULL AND "window_end_date" IS NOT NULL AND "window_start_date" <= "window_end_date")
    )
);
--> statement-breakpoint
CREATE INDEX "discovery_runs_parent_run_id_idx"
  ON "discovery_runs" USING btree ("parent_run_id");
--> statement-breakpoint
CREATE INDEX "discovery_runs_status_started_at_idx"
  ON "discovery_runs" USING btree ("status", "started_at");
--> statement-breakpoint
CREATE TABLE "discovery_trace_spans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "trace_id" text NOT NULL,
  "span_id" text NOT NULL,
  "parent_span_id" text,
  "span_type" text NOT NULL,
  "name" text,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "status" text,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_trace_spans_run_id_discovery_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "discovery_trace_spans_run_started_idx"
  ON "discovery_trace_spans" USING btree ("run_id", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "discovery_trace_spans_trace_span_unique"
  ON "discovery_trace_spans" USING btree ("trace_id", "span_id");
--> statement-breakpoint
CREATE TABLE "discovery_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "discovery_path" text NOT NULL,
  "source_content_type" text,
  "source_content_id" uuid,
  "source_lead_id" text,
  "topic_context" jsonb,
  "url" text NOT NULL,
  "normalized_url" text,
  "title" text,
  "title_zh" text,
  "author" text,
  "publication" text,
  "content_type" text,
  "published_at" timestamp with time zone,
  "estimated_duration_minutes" integer,
  "summary" text,
  "why_worth_reading" text,
  "extra_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "evidence" jsonb,
  "evaluation" jsonb,
  "status" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_candidates_run_id_discovery_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "public"."discovery_runs"("id") ON DELETE cascade,
  CONSTRAINT "discovery_candidates_path_check"
    CHECK ("discovery_path" IN ('direct', 'topic', 'open')),
  CONSTRAINT "discovery_candidates_source_check"
    CHECK (
      ("source_content_type" IS NULL AND "source_content_id" IS NULL)
      OR ("source_content_type" IN ('event', 'processed_content') AND "source_content_id" IS NOT NULL)
    ),
  CONSTRAINT "discovery_candidates_lead_check"
    CHECK (
      ("discovery_path" IN ('direct', 'topic') AND "source_lead_id" IS NOT NULL)
      OR ("discovery_path" = 'open' AND "source_lead_id" IS NULL)
    ),
  CONSTRAINT "discovery_candidates_content_type_check"
    CHECK ("content_type" IS NULL OR "content_type" IN ('article', 'video', 'podcast')),
  CONSTRAINT "discovery_candidates_status_check"
    CHECK ("status" IN ('discovered', 'evaluated', 'selected', 'rejected', 'unverifiable')),
  CONSTRAINT "discovery_candidates_extra_info_object_check"
    CHECK (jsonb_typeof("extra_info") = 'object')
);
--> statement-breakpoint
CREATE INDEX "discovery_candidates_run_path_idx"
  ON "discovery_candidates" USING btree ("run_id", "discovery_path");
--> statement-breakpoint
CREATE INDEX "discovery_candidates_run_lead_idx"
  ON "discovery_candidates" USING btree ("run_id", "source_lead_id");
--> statement-breakpoint
CREATE INDEX "discovery_candidates_normalized_url_idx"
  ON "discovery_candidates" USING btree ("normalized_url");
--> statement-breakpoint
CREATE TABLE "in_depth_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "discovery_candidate_id" uuid NOT NULL,
  "review_status" text NOT NULL,
  "editorial_notes" text,
  "editorial_overrides" jsonb,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "in_depth_candidates_discovery_candidate_id_discovery_candidates_id_fk"
    FOREIGN KEY ("discovery_candidate_id") REFERENCES "public"."discovery_candidates"("id") ON DELETE cascade,
  CONSTRAINT "in_depth_candidates_review_status_check"
    CHECK ("review_status" IN ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "in_depth_candidates_candidate_unique"
  ON "in_depth_candidates" USING btree ("discovery_candidate_id");
--> statement-breakpoint
CREATE INDEX "in_depth_candidates_review_created_idx"
  ON "in_depth_candidates" USING btree ("review_status", "created_at");
