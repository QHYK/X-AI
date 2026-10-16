ALTER TABLE "discovery_runs"
  ADD COLUMN "execution_state" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "discovery_runs"
  ADD CONSTRAINT "discovery_runs_execution_state_object_check"
  CHECK (jsonb_typeof("execution_state") = 'object');
