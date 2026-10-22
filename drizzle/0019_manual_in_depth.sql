ALTER TABLE "discovery_candidates" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_candidates" DROP CONSTRAINT "discovery_candidates_path_check";
--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_path_check"
  CHECK (discovery_path IN ('direct', 'topic', 'open', 'manual'));
--> statement-breakpoint
ALTER TABLE "discovery_candidates" DROP CONSTRAINT "discovery_candidates_lead_check";
--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_lead_check"
  CHECK ((discovery_path IN ('direct', 'topic') AND source_lead_id IS NOT NULL)
      OR (discovery_path IN ('open', 'manual') AND source_lead_id IS NULL));
--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_run_check"
  CHECK ((discovery_path = 'manual' AND run_id IS NULL)
      OR (discovery_path <> 'manual' AND run_id IS NOT NULL));
