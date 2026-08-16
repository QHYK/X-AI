ALTER TABLE "events" RENAME COLUMN "event_tags" TO "tags";--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "event_tags_zh" TO "tags_zh";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN "conflicting_information";