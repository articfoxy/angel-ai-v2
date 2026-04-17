-- One-shot destructive migration for Angel Memory OS rebuild.
-- Drops all old memory tables so db push can recreate fresh.
-- Preserves: User, Session (core), Skill, Voiceprint.
--
-- This is idempotent — safe to re-run. DROP TABLE IF EXISTS.
-- Once applied and committed, the marker below prevents re-runs.

DO $$
BEGIN
  -- Mark via a schema comment so we don't re-run destructively
  IF NOT EXISTS (
    SELECT 1 FROM pg_description
    WHERE description = 'angel-memory-os-v2'
      AND objoid = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    -- Drop old v1 memory tables
    DROP TABLE IF EXISTS "Memory" CASCADE;
    DROP TABLE IF EXISTS "CoreMemory" CASCADE;
    DROP TABLE IF EXISTS "Relationship" CASCADE;
    DROP TABLE IF EXISTS "Reflection" CASCADE;
    DROP TABLE IF EXISTS "Entity" CASCADE;
    DROP TABLE IF EXISTS "Episode" CASCADE;

    -- Mark applied
    COMMENT ON SCHEMA public IS 'angel-memory-os-v2';
    RAISE NOTICE 'Angel Memory OS v2 migration: old memory tables dropped.';
  ELSE
    RAISE NOTICE 'Angel Memory OS v2 migration: already applied, skipping.';
  END IF;
END $$;
