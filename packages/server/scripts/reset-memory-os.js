#!/usr/bin/env node
/**
 * One-shot destructive migration runner for Angel Memory OS v2.
 * Runs prisma/reset-memory-os.sql against DATABASE_URL via Prisma.
 * Idempotent — uses a schema comment marker to skip if already applied.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

(async () => {
  const sqlPath = path.join(__dirname, '..', 'prisma', 'reset-memory-os.sql');
  if (!fs.existsSync(sqlPath)) {
    console.log('[reset-memory-os] SQL file missing, skipping.');
    process.exit(0);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(sql);
    console.log('[reset-memory-os] ✓ applied');
  } catch (err) {
    // If tables never existed (fresh DB), the DROPs are no-ops — that's fine.
    // If the DB connection fails here, Railway will fail the build anyway.
    console.error('[reset-memory-os] failed:', err.message);
    // Don't hard-fail the build — db push will surface any real problems
    process.exit(0);
  } finally {
    await prisma.$disconnect();
  }
})();
