import dotenv from 'dotenv';
dotenv.config();

// Telemetry MUST initialize before anything else so auto-instrumentation
// can patch http/pg/express as they're imported.
import { initTelemetry } from './telemetry';
initTelemetry();

import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import { authRouter } from './routes/auth';
import { sessionsRouter } from './routes/sessions';
import { memoryRouter } from './routes/memory';
import { skillsRouter } from './routes/skills';
import { voiceprintRouter } from './routes/voiceprint';
import { voicesRouter } from './routes/voices';
import { workersRouter } from './routes/workers';
import { authenticateToken } from './middleware/auth';
import { setupSocketHandlers } from './services/socket.service';
import { codeWorkerHub } from './services/codeworker.service';

export const prisma = new PrismaClient();

const app = express();
const server = http.createServer(app);
// React Native (and other native mobile) clients don't send an Origin header,
// so wildcard origin is the correct setting for a mobile-first Socket.io server.
// If a web client is added later, replace '*' with an explicit allowlist.
const io = new SocketServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0' }));

// Detailed readiness probe — infra status
app.get('/health/ready', async (_, res) => {
  const checks: Record<string, any> = {};
  try { await prisma.$queryRawUnsafe('SELECT 1'); checks.db = 'ok'; }
  catch (e: any) { checks.db = `err: ${e?.message?.slice(0, 80)}`; }
  try {
    const { RawAssetService } = await import('./services/storage/raw-asset.service');
    const svc = new RawAssetService();
    checks.raw_archive = svc.isEnabled ? (await svc.ping() ? 'ok' : 'unreachable') : 'disabled';
  } catch { checks.raw_archive = 'err'; }
  checks.otel = process.env.OTEL_ENABLED === 'true' ? 'enabled' : 'disabled';
  checks.jobs = 'running'; // we'd need a handle to the runner to actually check
  res.json({ status: Object.values(checks).every((v) => v === 'ok' || v === 'disabled' || v === 'enabled' || v === 'running') ? 'ok' : 'degraded', checks, version: '2.0.0' });
});

// Debug endpoint — check env vars (authenticated to prevent key prefix leaks)
app.get('/debug/env', authenticateToken, (_, res) => {
  res.json({
    deepgram: process.env.DEEPGRAM_API_KEY ? 'set' : 'MISSING',
    openai: process.env.OPENAI_API_KEY ? 'set' : 'MISSING',
    jwt_secret: process.env.JWT_SECRET ? 'set' : 'MISSING',
    database_url: process.env.DATABASE_URL ? 'set' : 'MISSING',
    node_env: process.env.NODE_ENV || 'unset',
    port: process.env.PORT || '3000',
  });
});

// Debug endpoint — test OpenAI Realtime API connectivity (authenticated)
app.get('/debug/realtime', authenticateToken, async (_, res) => {
  const WebSocket = (await import('ws')).default;
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return res.json({ status: 'error', message: 'No OPENAI_API_KEY' });

  const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
  const events: string[] = [];

  try {
    const ws = new WebSocket(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'OpenAI-Beta': 'realtime=v1' },
    });

    const result = await new Promise<any>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ status: 'timeout', events });
      }, 8000);

      ws.on('open', () => events.push('ws:open'));
      ws.on('message', (data: any) => {
        const evt = JSON.parse(data.toString());
        events.push(evt.type + (evt.error ? `: ${JSON.stringify(evt.error)}` : ''));
        if (evt.type === 'session.created') {
          clearTimeout(timeout);
          ws.close();
          resolve({ status: 'ok', sessionId: evt.session?.id, events });
        }
        if (evt.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          resolve({ status: 'error', error: evt.error, events });
        }
      });
      ws.on('error', (err: any) => {
        clearTimeout(timeout);
        resolve({ status: 'ws_error', message: err.message, events });
      });
    });

    res.json(result);
  } catch (err: any) {
    res.json({ status: 'exception', message: err.message });
  }
});

// Debug endpoint — test Deepgram connectivity with various parameter combos
app.get('/debug/deepgram', authenticateToken, async (_, res) => {
  const { createClient, LiveTranscriptionEvents } = await import('@deepgram/sdk');
  const key = process.env.DEEPGRAM_API_KEY || '';
  if (!key) return res.json({ status: 'error', message: 'No DEEPGRAM_API_KEY' });

  // Test multiple parameter combos to isolate which one causes 400
  const tests = [
    { label: 'multi', opts: { model: 'nova-3', language: 'multi', smart_format: true, diarize: true, encoding: 'linear16', sample_rate: 16000, channels: 1, interim_results: true, endpointing: 150, vad_events: true, no_delay: true } },
    { label: 'en', opts: { model: 'nova-3', language: 'en', smart_format: true, diarize: true, encoding: 'linear16', sample_rate: 16000, channels: 1, interim_results: true, endpointing: 150, vad_events: true, no_delay: true } },
    { label: 'multi-minimal', opts: { model: 'nova-3', language: 'multi', encoding: 'linear16', sample_rate: 16000 } },
  ];

  const results: any[] = [];
  for (const test of tests) {
    try {
      const dg = createClient(key);
      const conn = dg.listen.live(test.opts as any);
      const result = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => { try { conn.finish(); } catch {} resolve('timeout'); }, 5000);
        conn.on(LiveTranscriptionEvents.Open, () => { clearTimeout(timeout); conn.finish(); resolve('ok'); });
        conn.on(LiveTranscriptionEvents.Error, (err: any) => { clearTimeout(timeout); try { conn.finish(); } catch {} resolve(`error: ${err?.message || JSON.stringify(err)}`); });
      });
      results.push({ label: test.label, result });
    } catch (err: any) {
      results.push({ label: test.label, result: `exception: ${err.message}` });
    }
  }

  res.json({ results });
});

// Public routes (no auth middleware)
app.use('/api/auth', authRouter);

// Protected routes
app.use('/api/voices', authenticateToken, voicesRouter);
app.use('/api/sessions', authenticateToken, sessionsRouter);
app.use('/api/memory', authenticateToken, memoryRouter);
app.use('/api/skills', authenticateToken, skillsRouter);
app.use('/api/voiceprint', authenticateToken, voiceprintRouter);
app.use('/api/workers', authenticateToken, workersRouter);

// Socket.io
setupSocketHandlers(io);

// WebSocket upgrade for Claude Code workers (separate from socket.io)
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // Socket.io handles its own upgrades — only intercept /ws/worker
  if (!req.url?.startsWith('/ws/worker')) return;

  // Parse auth token and machine name from URL params
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  const machineName = url.searchParams.get('name') || 'Unknown Machine';

  if (!token) { socket.destroy(); return; }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
    wss.handleUpgrade(req, socket, head, (ws) => {
      const workerId = codeWorkerHub.registerWorker(payload.userId, machineName, ws);

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          switch (msg.type) {
            case 'projects':
              codeWorkerHub.setWorkerProjects(workerId, msg.projects || []);
              break;
            case 'chunk':
              codeWorkerHub.handleChunk(workerId, msg.taskId, msg.text);
              break;
            case 'complete':
              codeWorkerHub.handleComplete(workerId, msg.taskId, msg.result || '');
              break;
            case 'error':
              codeWorkerHub.handleError(workerId, msg.taskId, msg.error || 'Unknown error');
              break;
            case 'ping':
              try { ws.send(JSON.stringify({ type: 'pong' })); } catch {}
              break;
          }
        } catch {}
      });
      ws.on('ping', () => { try { ws.pong(); } catch {} });

      // Server-side heartbeat: detect dead connections (terminate if no pong in 60s)
      let isAlive = true;
      ws.on('pong', () => { isAlive = true; });
      const heartbeat = setInterval(() => {
        if (!isAlive) { try { ws.terminate(); } catch {} return; }
        isAlive = false;
        try { ws.ping(); } catch {}
      }, 30000);

      let removed = false;
      const cleanupWorker = () => { if (!removed) { removed = true; clearInterval(heartbeat); codeWorkerHub.removeWorker(workerId); } };
      ws.on('close', cleanupWorker);
      ws.on('error', cleanupWorker);

      ws.send(JSON.stringify({ type: 'registered', workerId, name: machineName }));
    });
  } catch {
    socket.destroy();
  }
});

// Startup safety checks
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'dev-secret') {
  const level = process.env.NODE_ENV === 'production' ? 'ERROR' : 'WARN';
  console[level === 'ERROR' ? 'error' : 'warn'](
    `[${level}] JWT_SECRET is ${!process.env.JWT_SECRET ? 'not set' : '"dev-secret"'} — using insecure fallback. Set a strong JWT_SECRET in production!`
  );
}

const PORT = process.env.PORT || 3000;

// Enable pgvector extension and create indices on startup (idempotent)
async function initDatabase() {
  // pgvector extension — independent
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('[db] pgvector extension enabled');
  } catch (err: any) {
    console.warn('[db] pgvector extension setup skipped:', err?.message?.slice(0, 100));
  }

  // One-shot Memory OS v2 migration — idempotent via schema comment marker.
  // Drops old v1 memory tables so the Prisma-managed schema can recreate fresh.
  // (start.sh also runs prisma db push, but we do the destructive drop here
  //  from inside the server process to guarantee it runs regardless of start.sh.)
  try {
    const marker = await prisma.$queryRawUnsafe<any[]>(
      `SELECT 1 FROM pg_description
       WHERE description = 'angel-memory-os-v2'
         AND objoid = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`,
    );
    if (!marker || marker.length === 0) {
      console.log('[db] Applying Angel Memory OS v2 destructive migration...');
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Memory" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "CoreMemory" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Relationship" CASCADE`);
      // Don't drop Reflection/Entity/Episode — Prisma db push in start.sh
      // restructures them via ALTER. But older Episode/Entity/Reflection had
      // column types incompatible with v2 schema — safer to wipe and let
      // db push recreate them.
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Reflection" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Entity" CASCADE`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "Episode" CASCADE`);
      await prisma.$executeRawUnsafe(`COMMENT ON SCHEMA public IS 'angel-memory-os-v2'`);
      console.log('[db] ✓ v2 destructive migration applied — old tables dropped');
    }
  } catch (err: any) {
    console.warn('[db] v2 migration skipped/failed:', err?.message?.slice(0, 200));
  }

  // Run `prisma db push` from within Node so the v2 schema gets materialized
  // even if start.sh didn't execute its commands. Safe: --accept-data-loss is
  // needed because we just dropped old tables above, and it's idempotent on
  // subsequent boots.
  try {
    const { spawnSync } = await import('child_process');
    const res = spawnSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      encoding: 'utf8',
      timeout: 60_000,
      env: process.env,
    });
    if (res.status === 0) {
      console.log('[db] ✓ prisma db push applied v2 schema');
    } else {
      console.warn('[db] prisma db push non-zero exit:', res.status, (res.stdout || '').slice(0, 300), (res.stderr || '').slice(0, 300));
    }
  } catch (err: any) {
    console.warn('[db] prisma db push failed to spawn:', err?.message?.slice(0, 200));
  }

  // HNSW vector indices on v2 memory tables — each wrapped individually so
  // one failure doesn't skip the others.
  const vectorTables = ['Fact', 'Episode', 'Reflection', 'Observation', 'Entity'];
  for (const table of vectorTables) {
    try {
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "idx_${table.toLowerCase()}_embedding" ON "${table}" USING hnsw (embedding vector_cosine_ops)`,
      );
    } catch (err: any) {
      console.warn(`[db] index on ${table} skipped:`, err?.message?.slice(0, 100));
    }
  }
  console.log('[db] Vector indices ready');

  // Clean up orphaned sessions from previous server instances/deploys
  try {
    const cleaned = await prisma.session.updateMany({
      where: { status: { in: ['active', 'processing'] } },
      data: { status: 'ended', endedAt: new Date() },
    });
    if (cleaned.count > 0) {
      console.log(`[db] Cleaned ${cleaned.count} orphaned sessions from previous deploy`);
    }
  } catch (err: any) {
    console.warn('[db] orphaned session cleanup skipped:', err?.message?.slice(0, 100));
  }
}

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Angel AI v2 server running on port ${PORT}`);
    // Start graphile-worker durable job queue (cron + retries + scheduling)
    import('./services/jobs').then(({ startJobRunner }) => startJobRunner()).catch((e) =>
      console.warn('[jobs] failed to start:', e?.message),
    );
  });
});

// Graceful shutdown — flush telemetry + stop workers
const shutdown = async (signal: string) => {
  console.log(`[shutdown] received ${signal}`);
  try {
    const { stopJobRunner } = await import('./services/jobs');
    await stopJobRunner();
  } catch {}
  try {
    const { shutdownTelemetry } = await import('./telemetry');
    await shutdownTelemetry();
  } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
