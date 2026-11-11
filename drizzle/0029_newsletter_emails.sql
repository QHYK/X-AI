CREATE TABLE "newsletter_emails" (
  "gmail_message_id" text PRIMARY KEY NOT NULL,
  "raw_message" jsonb NOT NULL,
  "subject" text,
  "sender" text,
  "received_at" timestamp with time zone,
  "collected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source_id" uuid REFERENCES "public"."sources"("id"),
  "source_name" text,
  "parse_status" text DEFAULT 'collected' NOT NULL,
  "parser_version" integer,
  "module_mapping" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_stage" text,
  "error_message" text,
  "parsed_at" timestamp with time zone,
  "imported_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "newsletter_emails_raw_object_check" CHECK (jsonb_typeof("raw_message") = 'object'),
  CONSTRAINT "newsletter_emails_mapping_array_check" CHECK (jsonb_typeof("module_mapping") = 'array'),
  CONSTRAINT "newsletter_emails_status_check" CHECK ("parse_status" in ('collected','success','skipped','unsupported','conflict','failed'))
);
--> statement-breakpoint
CREATE INDEX "newsletter_emails_source_received_idx" ON "newsletter_emails" ("source_name", "received_at");
--> statement-breakpoint
CREATE INDEX "newsletter_emails_status_idx" ON "newsletter_emails" ("parse_status");
