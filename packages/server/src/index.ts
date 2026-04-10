import dotenv from 'dotenv';
dotenv.config();

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
import { authenticateToken } from './middleware/auth';
import { setupSocketHandlers } from './services/socket.service';

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

// Socket.io
setupSocketHandlers(io);

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
  try {
    await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
    console.log('[db] pgvector extension enabled');
    // Create HNSW vector indices (works on empty tables, unlike IVFFlat)
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_memory_embedding
      ON "Memory" USING hnsw (embedding vector_cosine_ops)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_entity_embedding
      ON "Entity" USING hnsw (embedding vector_cosine_ops)
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS idx_reflection_embedding
      ON "Reflection" USING hnsw (embedding vector_cosine_ops)
    `);
    console.log('[db] Vector indices ready');
  } catch (err: any) {
    // Non-fatal: pgvector may not be available on some PostgreSQL hosts
    console.warn('[db] pgvector setup skipped:', err?.message?.slice(0, 100));
  }
}

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Angel AI v2 server running on port ${PORT}`);
  });
});
