CREATE TABLE "memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "content" text NOT NULL,
  "type" text DEFAULT 'general' NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "memories_type_check" CHECK ("type" IN ('general', 'topic', 'source', 'content')),
  CONSTRAINT "memories_content_check" CHECK (length(btrim("content")) > 0)
);
