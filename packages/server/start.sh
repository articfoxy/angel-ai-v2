#!/bin/sh
set -e

DB_HOST="postgres.railway.internal"
DB_USER="angelai"
DB_NAME="angelai_v2"
export PGPASSWORD=angelai2026secure

echo "Creating pgvector extension..."
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || echo "pgvector extension creation skipped (may already exist or DB not ready)"

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo "Prisma push completed with warnings"

echo "Creating vector indexes (ivfflat requires rows to exist — failures are non-fatal)..."
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<'EOSQL' 2>&1 || true
DO $$
BEGIN
  -- Memory embedding index
  IF (SELECT count(*) FROM "Memory" WHERE embedding IS NOT NULL) > 0 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_memory_embedding ON "Memory" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    RAISE NOTICE 'Created idx_memory_embedding';
  ELSE
    RAISE NOTICE 'Skipping idx_memory_embedding — no rows with embeddings yet';
  END IF;

  -- Entity embedding index
  IF (SELECT count(*) FROM "Entity" WHERE embedding IS NOT NULL) > 0 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_entity_embedding ON "Entity" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    RAISE NOTICE 'Created idx_entity_embedding';
  ELSE
    RAISE NOTICE 'Skipping idx_entity_embedding — no rows with embeddings yet';
  END IF;

  -- Reflection embedding index
  IF (SELECT count(*) FROM "Reflection" WHERE embedding IS NOT NULL) > 0 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_reflection_embedding ON "Reflection" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    RAISE NOTICE 'Created idx_reflection_embedding';
  ELSE
    RAISE NOTICE 'Skipping idx_reflection_embedding — no rows with embeddings yet';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Vector index creation failed: % — this is non-fatal, indexes will be created on next deploy', SQLERRM;
END;
$$;
EOSQL

echo "Starting server..."
exec node dist/index.js
