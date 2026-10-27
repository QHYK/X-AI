ALTER TABLE stage4_runs ADD COLUMN prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE stage4_runs ADD CONSTRAINT stage4_runs_prompt_versions_object_check
  CHECK (jsonb_typeof(prompt_versions) = 'object');
