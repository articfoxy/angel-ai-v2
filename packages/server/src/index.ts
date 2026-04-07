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

// Auth routes (no auth middleware)
app.use('/api/auth', authRouter);

// Protected routes
app.use('/api/sessions', authenticateToken, sessionsRouter);
app.use('/api/memory', authenticateToken, memoryRouter);
app.use('/api/skills', authenticateToken, skillsRouter);
app.use('/api/voiceprint', authenticateToken, voiceprintRouter);

// Socket.io
setupSocketHandlers(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Angel AI v2 server running on port ${PORT}`);
});
