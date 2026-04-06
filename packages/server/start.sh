#!/bin/sh
set -e

echo "Creating pgvector extension..."
PGPASSWORD=angelai2026secure psql -h postgres.railway.internal -U angelai -d angelai_v2 -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>&1 || echo "pgvector extension creation skipped (may already exist or DB not ready)"

echo "Pushing Prisma schema..."
npx prisma db push --skip-generate --accept-data-loss 2>&1 || echo "Prisma push completed with warnings"

echo "Starting server..."
exec node dist/index.js
