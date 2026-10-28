CREATE OR REPLACE FUNCTION guard_prompt_version() RETURNS trigger LANGUAGE plpgsql AS $$
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
    GROUP BY coalesce(f->>'key', f->>'slot') HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate fragment slots';
  END IF;
  FOR ref IN SELECT * FROM jsonb_array_elements(NEW.body->'fragments') LOOP
    IF ref ? 'key' THEN
      IF ref ? 'slot' OR jsonb_typeof(ref->'key') <> 'string' OR ref->>'key' IS NULL
        OR NOT EXISTS (SELECT 1 FROM prompt_registry r WHERE r.key=ref->>'key' AND r.kind='fragment')
        OR (ref ? 'activeKey' AND ref->>'key' IS DISTINCT FROM ref->>'activeKey')
        OR (NOT ref ? 'activeKey' AND ref->>'key' IN ('xfield.identity','daily_brief.editorial','discover.editorial'))
      THEN RAISE EXCEPTION 'Invalid Fragment Key reference'; END IF;
    END IF;
    IF ref ? 'activeKey' THEN
      IF registry_kind <> 'request' OR ref ? 'versionId'
        OR jsonb_typeof(ref) <> 'object'
        OR (NOT ref ? 'key' AND (ref->>'slot' IS NULL OR ref->>'slot' !~ '^[a-z][a-z0-9_]*$'))
        OR ref->>'activeKey' IS NULL OR jsonb_typeof(ref->'activeKey') <> 'string'
        OR ref->>'activeKey' NOT IN ('xfield.identity', 'daily_brief.editorial', 'discover.editorial')
        OR NOT EXISTS (
          SELECT 1 FROM prompt_registry r JOIN prompt_versions v ON v.id = r.active_version_id
          WHERE r.key = ref->>'activeKey' AND r.kind = 'fragment'
            AND v.registry_id = r.id AND v.status = 'published'
        ) THEN RAISE EXCEPTION 'Invalid active fragment reference'; END IF;
      CONTINUE;
    END IF;
    IF jsonb_typeof(ref) <> 'object' OR ref->>'versionId' IS NULL
      OR (NOT ref ? 'key' AND (ref->>'slot' IS NULL OR ref->>'slot' !~ '^[a-z][a-z0-9_]*$')) THEN
      RAISE EXCEPTION 'Invalid fragment reference';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM prompt_versions v JOIN prompt_registry r ON r.id = v.registry_id
      WHERE v.id = (ref->>'versionId')::uuid AND r.kind = 'fragment' AND v.status = 'published'
        AND (NOT ref ? 'key' OR r.key=ref->>'key')
    ) THEN RAISE EXCEPTION 'Reference must resolve to a published fragment'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
