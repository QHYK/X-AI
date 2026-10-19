ALTER TABLE "in_depth_candidates"
  ADD COLUMN "editorial_summary" text,
  ADD COLUMN "editorial_why_worth_reading" text,
  ADD COLUMN "editorial_extra_info" text;
--> statement-breakpoint
-- Abort rather than discard legacy title/author or other unexpected nonempty data.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "in_depth_candidates"
    WHERE "editorial_overrides" IS NOT NULL
      AND jsonb_typeof("editorial_overrides") <> 'object'
  ) THEN
    RAISE EXCEPTION 'Editorial migration aborted: editorial_overrides must be an object or SQL NULL';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "in_depth_candidates" AS candidate
    CROSS JOIN LATERAL jsonb_each(candidate."editorial_overrides") AS entry(key, value)
    WHERE (
      entry.key NOT IN ('summary', 'whyWorthReading', 'extra_info')
      AND entry.value NOT IN ('null'::jsonb, '""'::jsonb)
    ) OR (
      entry.key IN ('summary', 'whyWorthReading', 'extra_info')
      AND jsonb_typeof(entry.value) NOT IN ('string', 'null')
    )
  ) THEN
    RAISE EXCEPTION 'Editorial migration aborted: unsupported legacy keys or non-string introduction values; preserve these values before retrying';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "in_depth_candidates"
SET "editorial_summary" = "editorial_overrides" ->> 'summary',
    "editorial_why_worth_reading" = "editorial_overrides" ->> 'whyWorthReading',
    "editorial_extra_info" = "editorial_overrides" ->> 'extra_info';
--> statement-breakpoint
-- Verify the exact backfill before removing its source, including NULL and empty strings.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "in_depth_candidates"
    WHERE "editorial_summary" IS DISTINCT FROM ("editorial_overrides" ->> 'summary')
       OR "editorial_why_worth_reading" IS DISTINCT FROM ("editorial_overrides" ->> 'whyWorthReading')
       OR "editorial_extra_info" IS DISTINCT FROM ("editorial_overrides" ->> 'extra_info')
  ) THEN
    RAISE EXCEPTION 'Editorial migration aborted: backfill verification failed';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "in_depth_candidates" DROP COLUMN "editorial_overrides";
