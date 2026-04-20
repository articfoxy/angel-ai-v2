/**
 * WorkingStateService (Layer B) — ephemeral session scratchpad with TTL.
 *
 * Stores short-lived truth for the current session:
 *   - current_topic
 *   - open_loops       (unanswered questions, pending commitments)
 *   - active_meeting
 *   - pending_tool_calls
 *   - interruption_mode
 *   - last_confirmed_intent
 *
 * Written synchronously by the memory judge. Read on every prompt
 * construction. Purged on session end and by a periodic TTL sweep.
 */
import { prisma } from '../../index';

export type WorkingStateKey =
  | 'current_topic'
  | 'open_loops'
  | 'active_meeting'
  | 'pending_tool_calls'
  | 'interruption_mode'
  | 'last_confirmed_intent'
  | 'attention_state'
  | 'temporary_constraints';

const DEFAULT_TTL_MS: Record<WorkingStateKey, number> = {
  current_topic: 15 * 60_000,
  open_loops: 2 * 60 * 60_000,
  active_meeting: 2 * 60 * 60_000,
  pending_tool_calls: 30 * 60_000,
  interruption_mode: 30 * 60_000,
  last_confirmed_intent: 10 * 60_000,
  attention_state: 10 * 60_000,
  temporary_constraints: 60 * 60_000,
};

// Sentinel for rows not scoped to a specific session. Must be used CONSISTENTLY
// for where + create paths; otherwise Prisma generates mismatched SQL and
// lookups don't find the rows that were upserted.
const NO_SESSION = '';

function sidFor(sessionId: string | null | undefined): string {
  return sessionId ?? NO_SESSION;
}

export class WorkingStateService {
  async set(userId: string, sessionId: string | null, key: WorkingStateKey, value: any, ttlMs?: number): Promise<void> {
    const ttl = ttlMs ?? DEFAULT_TTL_MS[key];
    const ttlAt = new Date(Date.now() + ttl);
    const sid = sidFor(sessionId);
    await prisma.workingState.upsert({
      where: { userId_sessionId_key: { userId, sessionId: sid, key } },
      create: { userId, sessionId: sid, key, value, ttlAt },
      update: { value, ttlAt },
    });
  }

  async get(userId: string, sessionId: string | null, key: WorkingStateKey): Promise<any | null> {
    const row = await prisma.workingState.findUnique({
      where: { userId_sessionId_key: { userId, sessionId: sidFor(sessionId), key } },
    });
    if (!row) return null;
    if (row.ttlAt && row.ttlAt.getTime() < Date.now()) {
      // Expired — clean up lazily
      await prisma.workingState.delete({ where: { id: row.id } }).catch(() => {});
      return null;
    }
    return row.value;
  }

  /** Append to an array-valued key (open_loops, pending_tool_calls). */
  async append(userId: string, sessionId: string | null, key: WorkingStateKey, item: any, ttlMs?: number): Promise<void> {
    const current = (await this.get(userId, sessionId, key)) || [];
    if (!Array.isArray(current)) return this.set(userId, sessionId, key, [item], ttlMs);
    // Dedupe by stringified equality
    const key_s = JSON.stringify(item);
    const filtered = current.filter((x: any) => JSON.stringify(x) !== key_s);
    filtered.push(item);
    // Cap arrays at 20 items to prevent unbounded growth
    const capped = filtered.slice(-20);
    await this.set(userId, sessionId, key, capped, ttlMs);
  }

  /** Remove an item from an array-valued key (e.g. close an open_loop). */
  async removeFromList(userId: string, sessionId: string | null, key: WorkingStateKey, match: (item: any) => boolean): Promise<void> {
    const current = await this.get(userId, sessionId, key);
    if (!Array.isArray(current)) return;
    const filtered = current.filter((x) => !match(x));
    await this.set(userId, sessionId, key, filtered);
  }

  /** Get all live entries for a session — for prompt rendering. */
  async getAll(userId: string, sessionId: string | null): Promise<Record<string, any>> {
    const rows = await prisma.workingState.findMany({
      where: { userId, sessionId: sidFor(sessionId) },
    });
    const out: Record<string, any> = {};
    const now = Date.now();
    for (const r of rows) {
      if (r.ttlAt && r.ttlAt.getTime() < now) continue;
      out[r.key] = r.value;
    }
    return out;
  }

  /** Keys stored in WorkingState but rendered by a dedicated formatter elsewhere.
   *  Excluded from the default <working_state> block to avoid double-injection
   *  (LLM sees intents as both raw JSON here AND formatted <active_intents>). */
  private static readonly KEYS_RENDERED_ELSEWHERE = new Set<string>([
    'intent_stack',
  ]);

  /** Render working state as a compact prompt block. */
  async renderForPrompt(userId: string, sessionId: string | null): Promise<string> {
    const state = await this.getAll(userId, sessionId);
    const keys = Object.keys(state).filter(
      (k) => !WorkingStateService.KEYS_RENDERED_ELSEWHERE.has(k),
    );
    if (keys.length === 0) return '';
    const lines: string[] = [];
    for (const k of keys) {
      const v = state[k];
      if (v == null || (Array.isArray(v) && v.length === 0)) continue;
      if (typeof v === 'string') {
        lines.push(`${k}: ${v.slice(0, 200)}`);
      } else {
        lines.push(`${k}: ${JSON.stringify(v).slice(0, 400)}`);
      }
    }
    if (lines.length === 0) return '';
    return `<working_state>\n${lines.join('\n')}\n</working_state>`;
  }

  /** Clear all working state for a session (called on session end).
   *  Also purges NO_SESSION-scoped rows for this user so orphaned
   *  session-less state doesn't leak into the next session.
   *  TTL sweep handles long-lived NO_SESSION rows otherwise. */
  async clearSession(userId: string, sessionId: string): Promise<void> {
    await prisma.workingState.deleteMany({
      where: { userId, sessionId: { in: [sessionId, NO_SESSION] } },
    });
  }

  /** TTL sweep — called from the retention job. */
  async purgeExpired(): Promise<number> {
    const res = await prisma.workingState.deleteMany({
      where: { ttlAt: { lt: new Date() } },
    });
    return res.count;
  }
}
