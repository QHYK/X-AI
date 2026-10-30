ALTER TABLE "discovery_candidates" ADD COLUMN "category" text;
--> statement-breakpoint
ALTER TABLE "discovery_candidates" ADD CONSTRAINT "discovery_candidates_category_check"
  CHECK ("category" IS NULL OR "category" IN (
    'technology', 'business', 'math_physics', 'life_chemistry',
    'earth_environment', 'history', 'social_culture'
  ));
