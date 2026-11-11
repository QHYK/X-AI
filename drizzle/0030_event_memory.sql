ALTER TABLE "memories" DROP CONSTRAINT "memories_type_check";
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_type_check"
CHECK ("type" in ('general', 'topic', 'source', 'content', 'event'));
