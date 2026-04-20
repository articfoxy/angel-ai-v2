/**
 * HeartbeatService — session-scoped 3-minute pulse.
 *
 * Runs while a session is active (mic listening OR app open). Different from
 * graphile-worker cron (which runs 24/7 across all users). Heartbeat is the
 * *in-session* "what do I need to surface right now?" loop.
 *
 * Each tick:
 *   1. Expire stale intents
 *   2. Check upcoming calendar events — propose pre-brief if <15min away
 *   3. Check due commitments — propose reminder
 *   4. Light reflection on last window — propose insight if something notable
 *   5. Prune working_state open_loops user resolved in conversation
 *
 * All proposals route through ResponseOrchestrator.
 */
import { prisma } from '../../index';
import { responseOrchestrator } from './orchestrator.service';

const HEARTBEAT_INTERVAL_MS = 3 * 60_000; // 3 min

interface HeartbeatContext {
  userId: string;
  sessionId: string | null;
  openaiKey: string;
  /** Called when the intent stack changes (expiration). The socket handler
   *  uses this to re-render the brain's system prompt so the expired
   *  intent stops influencing responses. Safe to be async. */
  onIntentsChanged?: () => void;
}

const timers = new Map<string, ReturnType<typeof setInterval>>();

export class HeartbeatService {
  /** Start heartbeat for a user's session. Idempotent. */
  start(ctx: HeartbeatContext): void {
    const key = `${ctx.userId}:${ctx.sessionId || 'no-session'}`;
    if (timers.has(key)) return;

    const tick = () => {
      this.tick(ctx).catch((err) => {
        console.warn('[heartbeat] tick failed:', err?.message?.slice(0, 100));
      });
    };

    // Fire first tick after 60s to avoid racing session:start setup
    const initial = setTimeout(() => {
      tick();
      const iv = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      timers.set(key, iv);
    }, 60_000);

    // Store the timeout handle so stop() can clear it
    timers.set(key, initial as any);
  }

  /** Stop the heartbeat for this session. */
  stop(userId: string, sessionId: string | null): void {
    const key = `${userId}:${sessionId || 'no-session'}`;
    const iv = timers.get(key);
    if (iv) {
      clearInterval(iv);
      clearTimeout(iv as any);
      timers.delete(key);
    }
  }

  private async tick(ctx: HeartbeatContext): Promise<void> {
    const t0 = Date.now();

    // Run each check in isolation — one failing shouldn't prevent others
    await Promise.allSettled([
      this.checkUpcomingEvents(ctx),
      this.checkDueCommitments(ctx),
      this.expireIntents(ctx),
      this.expireWorkingState(ctx),
    ]);

    const elapsed = Date.now() - t0;
    if (elapsed > 500) console.log(`[heartbeat] tick ${ctx.userId.slice(0, 8)} (${elapsed}ms)`);
  }

  /** Expire time-bound intents (e.g. "translate for 30 min"). Broadcasts
   * the updated list so the client can drop chips in real time, and asks
   * the socket handler to rebuild the brain's system prompt so the expired
   * intent stops steering responses. */
  private async expireIntents(ctx: HeartbeatContext): Promise<void> {
    try {
      const { intentStack } = await import('../intents/intent-stack.service');
      const expired = await intentStack.purgeExpired(ctx.userId, ctx.sessionId);
      if (expired.length > 0) {
        // Gentle whisper when an explicit-command intent times out
        for (const i of expired) {
          if (i.source === 'user_command') {
            await responseOrchestrator.propose({
              userId: ctx.userId,
              kind: 'status',
              importance: 3,
              content: `✓ Intent expired: ${i.kind}`,
              dedupKey: `intent-expire-${i.id}`,
            }).catch(() => {});
          }
        }
        // Drop the expired intent fragment from the live prompt
        try { ctx.onIntentsChanged?.(); } catch {}
      }
    } catch {}
  }

  /** T-minus calendar check: anything in next 15 min? */
  private async checkUpcomingEvents(ctx: HeartbeatContext): Promise<void> {
    const now = new Date();
    const in15Min = new Date(Date.now() + 15 * 60_000);
    const events = await prisma.calendarEvent.findMany({
      where: {
        userId: ctx.userId,
        status: 'active',
        startAt: { gte: now, lte: in15Min },
      },
      orderBy: { startAt: 'asc' },
      take: 3,
    }).catch(() => []);

    for (const ev of events) {
      const minsAway = Math.round((ev.startAt.getTime() - now.getTime()) / 60_000);
      // Propose a pre-brief (Phase B's BriefComposer will handle rich version;
      // for now, bare reminder to prove the pipeline works)
      await responseOrchestrator.propose({
        userId: ctx.userId,
        kind: 'pre_brief',
        importance: 7,
        content: `${ev.title} in ${minsAway} min${minsAway !== 1 ? 's' : ''}${ev.location ? ' · ' + ev.location : ''}`,
        dedupKey: `cal-${ev.id}-${Math.floor(ev.startAt.getTime() / 300_000)}`, // dedup per 5-min window
        data: { eventId: ev.id },
      });
    }
  }

  /** Any commitments due in the next hour or already missed? */
  private async checkDueCommitments(ctx: HeartbeatContext): Promise<void> {
    const now = new Date();
    const in1Hour = new Date(Date.now() + 60 * 60_000);
    const due = await prisma.commitment.findMany({
      where: {
        userId: ctx.userId,
        status: 'open',
        dueDate: { lte: in1Hour },
        OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: new Date(Date.now() - 6 * 3600_000) } }],
      },
      orderBy: { dueDate: 'asc' },
      take: 5,
    }).catch(() => []);

    for (const c of due) {
      const isOverdue = c.dueDate && c.dueDate.getTime() < now.getTime();
      await responseOrchestrator.propose({
        userId: ctx.userId,
        kind: 'reminder',
        importance: isOverdue ? 8 : 6,
        content: isOverdue
          ? `Overdue: ${c.description} (to ${c.toName})`
          : `Due soon: ${c.description} (to ${c.toName})`,
        dedupKey: `commit-${c.id}`,
        data: { commitmentId: c.id },
      });
      // Mark reminded so we don't spam every 3 min
      await prisma.commitment.update({
        where: { id: c.id },
        data: { reminderSentAt: now },
      }).catch(() => {});
    }
  }

  /** Purge expired working_state rows */
  private async expireWorkingState(ctx: HeartbeatContext): Promise<void> {
    await prisma.workingState.deleteMany({
      where: { userId: ctx.userId, ttlAt: { lt: new Date() } },
    }).catch(() => {});
  }
}

export const heartbeatService = new HeartbeatService();
