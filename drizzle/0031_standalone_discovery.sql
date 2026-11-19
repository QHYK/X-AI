ALTER TABLE discovery_runs DROP CONSTRAINT discovery_runs_relationship_check;
--> statement-breakpoint
ALTER TABLE discovery_runs ADD CONSTRAINT discovery_runs_relationship_check CHECK (
 (run_type = 'regular' AND parent_run_id IS NULL AND source_lead_id IS NULL)
 OR (run_type = 'single_lead' AND parent_run_id IS NOT NULL AND source_lead_id IS NOT NULL)
 OR (run_type = 'open' AND source_lead_id IS NULL)
);
