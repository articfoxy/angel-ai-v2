#!/usr/bin/env npx ts-node
/**
 * Angel AI — Claude Code Worker Agent
 *
 * Run this on any machine with Claude Code installed.
 * It connects to the Angel server, receives coding tasks,
 * executes them via the Claude CLI, and streams results back.
 *
 * Usage:
 *   npx ts-node packages/worker/index.ts \
 *     --server https://server-production-ff34.up.railway.app \
 *     --token <your-angel-auth-token> \
 *     --name "MacBook Pro"
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, fallback = ''): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

const SERVER_URL = getArg('server', 'https://server-production-ff34.up.railway.app');
const AUTH_TOKEN = getArg('token');
const MACHINE_NAME = getArg('name', require('os').hostname());

if (!AUTH_TOKEN) {
  console.error('Error: --token is required. Get your auth token from Angel AI app settings.');
  process.exit(1);
}

const WS_URL = `${SERVER_URL.replace(/^http/, 'ws')}/ws/worker?token=${encodeURIComponent(AUTH_TOKEN)}&name=${encodeURIComponent(MACHINE_NAME)}`;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;

function connect() {
  console.log(`[Angel Worker] Connecting to ${SERVER_URL} as "${MACHINE_NAME}"...`);

  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    reconnectAttempts = 0;
    console.log('[Angel Worker] Connected! Waiting for tasks...');
  });

  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'registered') {
        console.log(`[Angel Worker] Registered as worker ${msg.workerId} (${msg.name})`);
      } else if (msg.type === 'task') {
        handleTask(msg.taskId, msg.prompt, msg.context);
      }
    } catch (err) {
      console.error('[Angel Worker] Failed to parse message:', err);
    }
  });

  ws.on('close', (code: number) => {
    console.log(`[Angel Worker] Disconnected (code: ${code})`);
    attemptReconnect();
  });

  ws.on('error', (err: Error) => {
    console.error('[Angel Worker] WebSocket error:', err.message);
  });
}

function attemptReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT) {
    console.error('[Angel Worker] Max reconnect attempts reached. Exiting.');
    process.exit(1);
  }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  console.log(`[Angel Worker] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT})...`);
  setTimeout(connect, delay);
}

function handleTask(taskId: string, prompt: string, context?: string) {
  console.log(`\n[Angel Worker] 📋 Task received: ${taskId}`);
  console.log(`[Angel Worker] Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`);

  // Build the full prompt with context
  const fullPrompt = context
    ? `Context from a live conversation:\n${context}\n\nTask: ${prompt}`
    : prompt;

  // Execute via Claude CLI
  const claude = spawn('claude', ['--print', '--message', fullPrompt], {
    cwd: process.env.HOME,
    env: { ...process.env },
    shell: true,
  });

  let result = '';
  let chunkBuffer = '';

  claude.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    result += text;
    chunkBuffer += text;

    // Send chunks every ~500 chars for streaming progress
    if (chunkBuffer.length >= 500) {
      sendMessage({ type: 'chunk', taskId, text: chunkBuffer });
      chunkBuffer = '';
    }
  });

  claude.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    // Claude CLI prints status to stderr — not an error
    if (text.includes('Thinking') || text.includes('⠋') || text.includes('⠹')) return;
    console.error(`[Angel Worker] stderr: ${text.trim()}`);
  });

  claude.on('close', (code: number) => {
    // Flush remaining chunk
    if (chunkBuffer) sendMessage({ type: 'chunk', taskId, text: chunkBuffer });

    if (code === 0) {
      sendMessage({ type: 'complete', taskId, result });
      console.log(`[Angel Worker] ✅ Task ${taskId} completed (${result.length} chars)`);
    } else {
      sendMessage({ type: 'error', taskId, error: result || `Claude CLI exited with code ${code}` });
      console.log(`[Angel Worker] ❌ Task ${taskId} failed (exit code ${code})`);
    }
  });

  claude.on('error', (err: Error) => {
    sendMessage({ type: 'error', taskId, error: `Failed to spawn Claude CLI: ${err.message}` });
    console.error(`[Angel Worker] ❌ Failed to spawn Claude CLI:`, err.message);
  });
}

function sendMessage(msg: Record<string, unknown>) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Start
connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Angel Worker] Shutting down...');
  ws?.close();
  process.exit(0);
});
