ALTER TABLE "stage4_runs" ADD COLUMN "selection_snapshot" jsonb;
--> statement-breakpoint
ALTER TABLE "stage4_runs" ADD CONSTRAINT "stage4_runs_selection_snapshot_object_check"
CHECK ("selection_snapshot" IS NULL OR jsonb_typeof("selection_snapshot") = 'object');
