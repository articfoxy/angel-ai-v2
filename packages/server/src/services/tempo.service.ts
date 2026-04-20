/**
 * TempoService — one source of truth for conversation velocity.
 *
 * Every proactive loop in Angel (judge, heartbeat, passive inference, entity
 * prefetch, realtime trigger) used to be a static constant. That's wrong.
 *
 * A fast-moving meeting needs tight loops or Angel falls behind the thread.
 * A quiet afternoon with the user thinking out loud needs the OPPOSITE —
 * tight loops become constant noise.
 *
 * So we measure words-per-minute over a 60s sliding window per user, bucket
 * into four tempo bands, and every gate reads its cadence from the current
 * band. One knob, consistent behavior across the whole system.
 *
 *   slow      < 30 wpm   (monologue, quiet, idle)
 *   normal    30-80 wpm  (casual conversation)
 *   fast      80-140 wpm (engaged meeting)
 *   frenetic  > 140 wpm  (debate, sales call, rapid-fire)
 */

export type Tempo = 'slow' | 'normal' | 'fast' | 'frenetic';

export interface TempoConfig {
  /** Judge + retrieval refresh every N final transcripts. */
  judgeEveryNTranscripts: number;
  /** Heartbeat tick interval (ms). Drives calendar/commitment/intent checks. */
  heartbeatMs: number;
  /** Minimum gap between passive-inference firings per user (ms). */
  passiveInferenceMinGapMs: number;
  /** Minimum gap between entity-prefetch embedding calls per session (ms). */
  entityPrefetchCooldownMs: number;
  /** Lines the Realtime brain buffers before auto-responding. Higher = less
   *  interruption in fast convos, lower = more responsive in slow ones. */
  realtimeTriggerLines: number;
}

export const TEMPO_BANDS: Record<Tempo, TempoConfig> = {
  slow: {
    judgeEveryNTranscripts: 15,
    heartbeatMs: 240_000,
    passiveInferenceMinGapMs: 60_000,
    entityPrefetchCooldownMs: 20_000,
    realtimeTriggerLines: 1,
  },
  normal: {
    judgeEveryNTranscripts: 10,
    heartbeatMs: 180_000,
    passiveInferenceMinGapMs: 45_000,
    entityPrefetchCooldownMs: 12_000,
    realtimeTriggerLines: 2,
  },
  fast: {
    judgeEveryNTranscripts: 6,
    heartbeatMs: 90_000,
    passiveInferenceMinGapMs: 25_000,
    entityPrefetchCooldownMs: 8_000,
    realtimeTriggerLines: 3,
  },
  frenetic: {
    judgeEveryNTranscripts: 4,
    heartbeatMs: 60_000,
    passiveInferenceMinGapMs: 15_000,
    entityPrefetchCooldownMs: 6_000,
    realtimeTriggerLines: 4,
  },
};

interface Sample { words: number; ts: number; }

const WINDOW_MS = 60_000; // 60-second sliding window
// Tempo bands derived from typical human speech: casual conversation
// runs ~120-150 wpm per speaker; meetings average lower with pauses.
const THRESHOLD_NORMAL = 30;
const THRESHOLD_FAST = 80;
const THRESHOLD_FRENETIC = 140;

const STATE = new Map<string, Sample[]>(); // keyed by userId
const LAST_TEMPO = new Map<string, Tempo>(); // for tempo-change logging

// Soft cap so extremely long server uptime with many users doesn't leak the
// maps unboundedly if some sessions never hit cleanupSession() (crash, panic).
// 10k is ~200kb of memory and well above realistic concurrent-user counts.
const MAX_TRACKED_USERS = 10_000;
const EVICTION_SWEEP_AT = 11_000; // evict the oldest 1000 entries when we cross this

export class TempoService {
  /** Record one final transcript's word count. Call on every Deepgram final. */
  record(userId: string, wordCount: number): void {
    if (!userId || wordCount <= 0) return;
    const now = Date.now();
    const samples = STATE.get(userId) ?? [];
    samples.push({ words: wordCount, ts: now });
    // Trim to window on every write so the array can't grow unbounded
    const fresh = samples.filter((s) => now - s.ts <= WINDOW_MS);
    STATE.set(userId, fresh);
    if (STATE.size > EVICTION_SWEEP_AT) this.sweepOldest(EVICTION_SWEEP_AT - MAX_TRACKED_USERS);
  }

  /** Words per minute over the last 60s. 0 if no samples. */
  getWordsPerMinute(userId: string): number {
    const samples = STATE.get(userId);
    if (!samples || samples.length === 0) return 0;
    const now = Date.now();
    const fresh = samples.filter((s) => now - s.ts <= WINDOW_MS);
    if (fresh.length === 0) return 0;
    const totalWords = fresh.reduce((a, s) => a + s.words, 0);
    // Use actual span, floored at 5s so a single recent utterance doesn't
    // explode to absurd wpm (e.g. 4 words in 500ms = 480 wpm)
    const spanMs = Math.max(5_000, now - fresh[0].ts);
    return (totalWords / spanMs) * 60_000;
  }

  /** Current tempo band. Called by every adaptive gate. */
  getTempo(userId: string): Tempo {
    const wpm = this.getWordsPerMinute(userId);
    const next: Tempo =
      wpm < THRESHOLD_NORMAL ? 'slow'
      : wpm < THRESHOLD_FAST ? 'normal'
      : wpm < THRESHOLD_FRENETIC ? 'fast'
      : 'frenetic';
    // Log transitions only — useful for tuning, not spammy
    const prev = LAST_TEMPO.get(userId);
    if (prev !== next) {
      LAST_TEMPO.set(userId, next);
      if (prev) {
        console.log(`[tempo] ${userId.slice(0, 8)} ${prev} → ${next} (${wpm.toFixed(0)} wpm)`);
      }
    }
    return next;
  }

  /** Config for the current tempo. Hot path — called from every loop. */
  getConfig(userId: string): TempoConfig {
    return TEMPO_BANDS[this.getTempo(userId)];
  }

  /** Called on session end so state doesn't leak across sessions. */
  reset(userId: string): void {
    STATE.delete(userId);
    LAST_TEMPO.delete(userId);
  }

  /** LRU-ish eviction: drop the oldest N user entries (by last sample ts).
   *  Called when the map exceeds the soft cap — defends against the edge
   *  case where cleanupSession never fires (process panic, crash). */
  private sweepOldest(n: number): void {
    const entries: Array<{ uid: string; lastTs: number }> = [];
    for (const [uid, samples] of STATE) {
      const last = samples.length > 0 ? samples[samples.length - 1].ts : 0;
      entries.push({ uid, lastTs: last });
    }
    entries.sort((a, b) => a.lastTs - b.lastTs);
    for (let i = 0; i < Math.min(n, entries.length); i++) {
      STATE.delete(entries[i].uid);
      LAST_TEMPO.delete(entries[i].uid);
    }
    console.log(`[tempo] swept ${n} stale user entries (cap ${MAX_TRACKED_USERS})`);
  }
}

export const tempoService = new TempoService();
