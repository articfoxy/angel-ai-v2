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
app.use(express.json());

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0' }));

// Debug endpoint — check env vars and test Deepgram connection
app.get('/debug/env', (_, res) => {
  const dgKey = process.env.DEEPGRAM_API_KEY || '';
  const oaiKey = process.env.OPENAI_API_KEY || '';
  res.json({
    deepgram: dgKey ? `set (${dgKey.substring(0, 8)}...)` : 'MISSING',
    openai: oaiKey ? `set (${oaiKey.substring(0, 8)}...)` : 'MISSING',
    jwt_secret: process.env.JWT_SECRET ? 'set' : 'MISSING',
    database_url: process.env.DATABASE_URL ? 'set' : 'MISSING',
    node_env: process.env.NODE_ENV || 'unset',
    port: process.env.PORT || '3000',
  });
});

// Auth routes (no auth middleware)
app.use('/api/auth', authRouter);

// Protected routes
app.use('/api/sessions', authenticateToken, sessionsRouter);
app.use('/api/memory', authenticateToken, memoryRouter);
app.use('/api/skills', authenticateToken, skillsRouter);

// Socket.io
setupSocketHandlers(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Angel AI v2 server running on port ${PORT}`);
});
