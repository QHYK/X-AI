CREATE TABLE prompt_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  kind text NOT NULL CONSTRAINT prompt_registry_kind_check CHECK (kind IN ('request', 'fragment')),
  workflow text NOT NULL,
  step text NOT NULL,
  request_type text NOT NULL,
  display_name text NOT NULL,
  active_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_registry_key_unique UNIQUE (key)
);
--> statement-breakpoint
CREATE TABLE prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_id uuid NOT NULL REFERENCES prompt_registry(id),
  version integer NOT NULL CONSTRAINT prompt_versions_version_check CHECK (version > 0),
  status text NOT NULL CONSTRAINT prompt_versions_status_check CHECK (status IN ('draft', 'published')),
  body jsonb NOT NULL CONSTRAINT prompt_versions_body_check CHECK (jsonb_typeof(body) = 'object'),
  content_hash text NOT NULL CONSTRAINT prompt_versions_content_hash_check CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  source_commit text,
  legacy_version text,
  change_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_registry_version_unique UNIQUE (registry_id, version),
  CONSTRAINT prompt_versions_id_registry_unique UNIQUE (id, registry_id)
);
--> statement-breakpoint
ALTER TABLE prompt_registry ADD CONSTRAINT prompt_registry_active_same_registry_fk
  FOREIGN KEY (active_version_id, id) REFERENCES prompt_versions(id, registry_id);
--> statement-breakpoint
CREATE FUNCTION guard_prompt_registry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.key, NEW.kind) IS DISTINCT FROM (OLD.id, OLD.key, OLD.kind) THEN
    RAISE EXCEPTION 'Prompt registry identity is immutable';
  END IF;
  IF NEW.active_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM prompt_versions WHERE id = NEW.active_version_id
      AND registry_id = NEW.id AND status = 'published'
  ) THEN RAISE EXCEPTION 'Active must be a published version of this registry'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER prompt_registry_guard BEFORE INSERT OR UPDATE ON prompt_registry
  FOR EACH ROW EXECUTE FUNCTION guard_prompt_registry();
--> statement-breakpoint
CREATE FUNCTION guard_prompt_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  registry_kind text;
  ref jsonb;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.status = 'published' THEN
    RAISE EXCEPTION 'Published prompt versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.registry_id, NEW.version, NEW.created_at)
      IS DISTINCT FROM (OLD.id, OLD.registry_id, OLD.version, OLD.created_at) THEN
    RAISE EXCEPTION 'Prompt version identity is immutable';
  END IF;
  SELECT kind INTO STRICT registry_kind FROM prompt_registry WHERE id = NEW.registry_id;
  IF NOT (NEW.body ?& ARRAY['systemInstructions', 'userTemplate', 'variants', 'fragments'])
    OR jsonb_typeof(NEW.body->'systemInstructions') NOT IN ('string', 'null')
    OR jsonb_typeof(NEW.body->'userTemplate') NOT IN ('string', 'null')
    OR jsonb_typeof(NEW.body->'variants') <> 'object'
    OR jsonb_typeof(NEW.body->'fragments') <> 'array' THEN
    RAISE EXCEPTION 'Invalid prompt body';
  END IF;
  IF registry_kind = 'fragment' AND (
    jsonb_array_length(NEW.body->'fragments') <> 0 OR NEW.body->'variants' <> '{}'::jsonb
    OR NEW.body->'userTemplate' <> 'null'::jsonb
  ) THEN RAISE EXCEPTION 'Shared fragments cannot have nested references or roles'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.body->'fragments') f
    GROUP BY f->>'slot' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate fragment slots';
  END IF;
  FOR ref IN SELECT * FROM jsonb_array_elements(NEW.body->'fragments') LOOP
    IF jsonb_typeof(ref) <> 'object' OR ref->>'slot' IS NULL
      OR ref->>'versionId' IS NULL OR ref->>'slot' !~ '^[a-z][a-z0-9_]*$' THEN
      RAISE EXCEPTION 'Invalid fragment reference';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM prompt_versions v JOIN prompt_registry r ON r.id = v.registry_id
      WHERE v.id = (ref->>'versionId')::uuid AND r.kind = 'fragment' AND v.status = 'published'
    ) THEN RAISE EXCEPTION 'Reference must resolve to a published fragment'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER prompt_version_guard BEFORE INSERT OR UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION guard_prompt_version();
