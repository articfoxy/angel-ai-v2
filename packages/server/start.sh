#!/bin/sh
set -e

DB_HOST="postgres.railway.internal"
DB_USER="angelai"
DB_NAME="angelai_v2"
export PGPASSWORD=angelai2026secure

echo "Creating pgvector extension..."
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || echo "pgvector extension creation skipped (may already exist or DB not ready)"

echo "One-shot destructive memory OS migration (idempotent via schema marker)..."
if [ -f prisma/reset-memory-os.sql ]; then
  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f prisma/reset-memory-os.sql 2>&1 || echo "Memory OS reset skipped"
fi

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo "Prisma push completed with warnings"

echo "Creating vector indexes (IVFFlat requires rows — failures non-fatal)..."
psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" <<'EOSQL' 2>&1 || true
DO $$
BEGIN
  IF (SELECT count(*) FROM "Fact" WHERE embedding IS NOT NULL) > 10 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_fact_embedding ON "Fact" USING hnsw (embedding vector_cosine_ops)';
    RAISE NOTICE 'Created idx_fact_embedding (HNSW)';
  END IF;
  IF (SELECT count(*) FROM "Episode" WHERE embedding IS NOT NULL) > 10 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_episode_embedding ON "Episode" USING hnsw (embedding vector_cosine_ops)';
    RAISE NOTICE 'Created idx_episode_embedding (HNSW)';
  END IF;
  IF (SELECT count(*) FROM "Reflection" WHERE embedding IS NOT NULL) > 10 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_reflection_embedding ON "Reflection" USING hnsw (embedding vector_cosine_ops)';
    RAISE NOTICE 'Created idx_reflection_embedding (HNSW)';
  END IF;
  IF (SELECT count(*) FROM "Observation" WHERE embedding IS NOT NULL) > 100 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_observation_embedding ON "Observation" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    RAISE NOTICE 'Created idx_observation_embedding (IVFFlat)';
  END IF;
  IF (SELECT count(*) FROM "Entity" WHERE embedding IS NOT NULL) > 0 THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_entity_embedding ON "Entity" USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
    RAISE NOTICE 'Created idx_entity_embedding';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Vector index creation: % — non-fatal', SQLERRM;
END;
$$;
EOSQL

echo "Starting server..."
exec node dist/index.js
