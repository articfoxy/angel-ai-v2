/**
 * IntentStackService — manages the active behavioral-intent stack per session.
 *
 * Stores in WorkingState.key='intent_stack'. Every brain-prompt assembly reads
 * this. Heartbeat expires items on every tick.
 *
 * Broadcasts 'intents:update' to the user's socket room whenever the stack
 * changes so the client can render active-intent chips in sync.
 */
import { Server as SocketServer } from 'socket.io';
import { prisma } from '../../index';
import { WorkingStateService } from '../memory/working-state.service';
import type { Intent } from './intent-parser.service';

export class IntentStackService {
  private ws: WorkingStateService;
  private io: SocketServer | null = null;

  constructor() {
    this.ws = new WorkingStateService();
  }

  /** Attach socket.io so we can broadcast intent updates to the user's room. */
  bindSocketServer(io: SocketServer): void {
    this.io = io;
  }

  async push(userId: string, sessionId: string | null, intent: Intent): Promise<void> {
    const current = await this.list(userId, sessionId);
    // Dedup: if the same kind + participantContext already exists, replace
    const filtered = current.filter((i) =>
      !(i.kind === intent.kind &&
        i.participantContext === intent.participantContext &&
        i.source === intent.source),
    );
    filtered.push({ ...intent, id: intent.id || `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
    // Cap at 8 — too many active intents = noisy prompt
    const capped = filtered.slice(-8);
    await this.ws.set(userId, sessionId, 'intent_stack' as any, capped, 24 * 3600 * 1000);
    await this.broadcast(userId, sessionId);
  }

  async list(userId: string, sessionId: string | null): Promise<Intent[]> {
    const raw = await this.ws.get(userId, sessionId, 'intent_stack' as any);
    if (!Array.isArray(raw)) return [];
    return raw.filter((i): i is Intent => !!i && typeof i.kind === 'string');
  }

  async active(userId: string, sessionId: string | null): Promise<Intent[]> {
    const all = await this.list(userId, sessionId);
    const now = Date.now();
    return all.filter((i) => {
      if (i.expiresInMinutes) {
        const startMs = new Date(i.startedAt).getTime();
        const expiresMs = startMs + i.expiresInMinutes * 60_000;
        return now < expiresMs;
      }
      // Semantic expirations handled by heartbeat
      return true;
    });
  }

  /** Purge time-based expirations. Called by heartbeat. */
  async purgeExpired(userId: string, sessionId: string | null): Promise<Intent[]> {
    const all = await this.list(userId, sessionId);
    const now = Date.now();
    const expired: Intent[] = [];
    const live = all.filter((i) => {
      if (i.expiresInMinutes) {
        const startMs = new Date(i.startedAt).getTime();
        if (now > startMs + i.expiresInMinutes * 60_000) {
          expired.push(i);
          return false;
        }
      }
      return true;
    });
    if (expired.length > 0) {
      await this.ws.set(userId, sessionId, 'intent_stack' as any, live, 24 * 3600 * 1000);
      await this.broadcast(userId, sessionId);
    }
    return expired;
  }

  /** Remove an intent by id. */
  async remove(userId: string, sessionId: string | null, intentId: string): Promise<void> {
    const all = await this.list(userId, sessionId);
    const filtered = all.filter((i) => i.id !== intentId);
    await this.ws.set(userId, sessionId, 'intent_stack' as any, filtered, 24 * 3600 * 1000);
    await this.broadcast(userId, sessionId);
  }

  /** Remove all intents for this session. */
  async clear(userId: string, sessionId: string | null): Promise<void> {
    await this.ws.set(userId, sessionId, 'intent_stack' as any, [], 24 * 3600 * 1000);
    await this.broadcast(userId, sessionId);
  }

  /** Render active intents as a compact prompt fragment. */
  async renderForPrompt(userId: string, sessionId: string | null): Promise<string> {
    const intents = await this.active(userId, sessionId);
    if (intents.length === 0) return '';
    const lines = intents.map((i) => {
      const parts = [`intent: ${i.kind}`];
      if (i.langs?.length) parts.push(`langs: ${i.langs.join(', ')}`);
      if (i.participantContext) parts.push(`context: ${i.participantContext}`);
      if (i.reason) parts.push(`reason: "${i.reason.slice(0, 80)}"`);
      return '- ' + parts.join(' · ');
    });
    return `<active_intents>\n${lines.join('\n')}\n</active_intents>`;
  }

  /** Emit the current active list to the user's socket room. */
  private async broadcast(userId: string, sessionId: string | null): Promise<void> {
    if (!this.io) return;
    try {
      const intents = await this.active(userId, sessionId);
      this.io.to(`user:${userId}`).emit('intents:update', { intents });
    } catch (err: any) {
      console.warn('[intent-stack] broadcast failed:', err?.message?.slice(0, 100));
    }
  }

  /** Force a broadcast of the current list (useful after socket reconnect). */
  async broadcastNow(userId: string, sessionId: string | null): Promise<void> {
    return this.broadcast(userId, sessionId);
  }
}

export const intentStack = new IntentStackService();
