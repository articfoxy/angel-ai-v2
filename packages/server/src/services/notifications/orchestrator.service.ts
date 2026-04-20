/**
 * ResponseOrchestrator — the single output gate.
 *
 * Every brain, detector, and heartbeat tick proposes a response through this
 * service. It decides:
 *   - which channel(s): in-session whisper, TTS, push notification, digest
 *   - whether to talk at all (dedup, interruption budget, quiet hours)
 *   - how to sequence multiple simultaneous proposals
 *
 * This is the "quiet enough to trust" engine. Without it, adding more
 * detectors makes Angel spammy. With it, Angel stays in the background
 * until it has something worth saying.
 */
import { Server as SocketServer } from 'socket.io';
import { pushService, type PushCategory } from './push.service';

export type ResponseChannel = 'whisper' | 'tts' | 'push' | 'digest';

export interface ProposeArgs {
  userId: string;
  kind: 'pre_brief' | 'contradiction' | 'reminder' | 'insight' | 'digest' | 'mode_switch' | 'error' | 'status';
  importance: number; // 1-10
  content: string; // <= 280 chars recommended
  detail?: string;
  data?: Record<string, unknown>;
  channels?: ResponseChannel[]; // override; default inferred
  dedupKey?: string; // suppress duplicates within a window
  quietHours?: boolean; // honor user's quiet hours
}

interface UserBudget {
  userId: string;
  dayStart: number;
  pushes: number;
  dedupMap: Map<string, number>;
}

const BUDGETS = new Map<string, UserBudget>();
const BUDGET_PER_DAY = 12; // max pushes/day unless importance >= 9
const DEDUP_WINDOW_MS = 30 * 60_000; // 30 min
const QUIET_HOURS_LOCAL = { start: 22, end: 7 }; // 10pm-7am local

export class ResponseOrchestrator {
  private io: SocketServer | null = null;

  /** Attach the socket.io server so we can route in-session whispers. */
  bindSocketServer(io: SocketServer): void {
    this.io = io;
  }

  /** Main entry: a brain/cron proposes a response; we route. */
  async propose(args: ProposeArgs): Promise<{ delivered: ResponseChannel[]; suppressed?: string }> {
    const budget = this.getBudget(args.userId);

    // Dedup — same dedupKey within the window is suppressed
    if (args.dedupKey) {
      const lastSeen = budget.dedupMap.get(args.dedupKey);
      if (lastSeen && Date.now() - lastSeen < DEDUP_WINDOW_MS) {
        return { delivered: [], suppressed: 'dedup' };
      }
    }

    // Quiet hours check (importance 9+ overrides)
    const isQuietHours = this.isQuietHours();
    if (isQuietHours && args.importance < 9 && args.quietHours !== false) {
      // Downgrade push to digest
      args.channels = args.channels?.filter((c) => c !== 'push') ?? ['digest'];
    }

    // Infer channels if not specified
    const channels = args.channels ?? this.pickChannels(args);

    // Check if user has an active socket (we have an active session?)
    const sessionActive = this.hasActiveSocket(args.userId);

    const delivered: ResponseChannel[] = [];

    // In-session: whisper + tts go through the existing socket pipeline
    if (sessionActive && (channels.includes('whisper') || channels.includes('tts'))) {
      this.emitWhisper(args);
      delivered.push('whisper');
      if (channels.includes('tts')) delivered.push('tts');
    }

    // Out-of-session push — enforce budget unless importance is critical
    if (channels.includes('push') && !sessionActive) {
      const overBudget = budget.pushes >= BUDGET_PER_DAY && args.importance < 9;
      if (!overBudget) {
        const res = await pushService.send({
          userId: args.userId,
          title: this.titleFor(args),
          body: args.content,
          category: this.categoryFor(args.kind),
          data: args.data,
          importance: args.importance,
        });
        if (res.sent > 0) {
          budget.pushes++;
          delivered.push('push');
        }
      } else {
        return { delivered, suppressed: 'budget' };
      }
    }

    if (args.dedupKey) budget.dedupMap.set(args.dedupKey, Date.now());
    return { delivered };
  }

  /** Default channel inference. */
  private pickChannels(args: ProposeArgs): ResponseChannel[] {
    const sessionActive = this.hasActiveSocket(args.userId);
    switch (args.kind) {
      case 'pre_brief':
        // In-session: whisper + tts. Out of session: push.
        return sessionActive ? ['whisper', 'tts'] : ['push'];
      case 'contradiction':
        return sessionActive ? ['whisper', 'tts'] : ['push'];
      case 'reminder':
        // Always push (user wants to know even if app is backgrounded)
        return sessionActive ? ['whisper', 'tts'] : ['push'];
      case 'insight':
        return sessionActive ? ['whisper'] : ['push']; // no TTS — less intrusive
      case 'digest':
        return sessionActive ? ['whisper'] : ['push'];
      case 'mode_switch':
      case 'status':
        return ['whisper']; // in-session only, no TTS
      case 'error':
        return ['whisper'];
      default:
        return ['whisper'];
    }
  }

  private categoryFor(kind: ProposeArgs['kind']): PushCategory {
    switch (kind) {
      case 'pre_brief':      return 'pre_brief';
      case 'contradiction':  return 'social';
      case 'reminder':       return 'reminder';
      case 'insight':        return 'insight';
      case 'digest':         return 'digest';
      default:               return 'insight';
    }
  }

  private titleFor(args: ProposeArgs): string {
    switch (args.kind) {
      case 'pre_brief':      return '📋 Pre-brief';
      case 'contradiction':  return '⚠️ Heads up';
      case 'reminder':       return '⏰ Reminder';
      case 'insight':        return '💡 Angel noticed';
      case 'digest':         return '📅 Your brief';
      default:               return 'Angel';
    }
  }

  private emitWhisper(args: ProposeArgs): void {
    if (!this.io) return;
    // Broadcast to all sockets for this user (room = userId)
    this.io.to(`user:${args.userId}`).emit('whisper', {
      id: args.data?.whisperId || `orch-${Date.now()}`,
      type: this.whisperTypeFor(args.kind),
      content: args.content,
      detail: args.detail,
      createdAt: new Date().toISOString(),
      data: args.data,
    });
  }

  private whisperTypeFor(kind: ProposeArgs['kind']): string {
    switch (kind) {
      case 'pre_brief':     return 'pre_brief';
      case 'contradiction': return 'warning';
      case 'reminder':      return 'action';
      case 'insight':       return 'insight';
      case 'digest':        return 'insight';
      case 'mode_switch':   return 'mode_switch';
      case 'error':         return 'warning';
      default:              return 'insight';
    }
  }

  private hasActiveSocket(userId: string): boolean {
    if (!this.io) return false;
    const room = this.io.sockets.adapter.rooms.get(`user:${userId}`);
    return !!room && room.size > 0;
  }

  private getBudget(userId: string): UserBudget {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayStart = today.getTime();
    const existing = BUDGETS.get(userId);
    if (existing && existing.dayStart === dayStart) return existing;
    // New day — reset
    const fresh: UserBudget = { userId, dayStart, pushes: 0, dedupMap: new Map() };
    BUDGETS.set(userId, fresh);
    return fresh;
  }

  private isQuietHours(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const { start, end } = QUIET_HOURS_LOCAL;
    if (start > end) {
      // Wraps midnight (e.g. 22 to 7)
      return hour >= start || hour < end;
    }
    return hour >= start && hour < end;
  }
}

export const responseOrchestrator = new ResponseOrchestrator();
