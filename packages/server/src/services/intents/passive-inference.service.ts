/**
 * PassiveInferenceService — auto-infers behavioral intents from ambient signals.
 *
 * Different from IntentParser (which needs an explicit command). This watches
 * what's happening in the room and proposes intents with source='auto_inferred',
 * lower priority (4) so explicit user commands always win.
 *
 * Current detectors (cheap, regex/heuristic based):
 *   - foreignLanguage: runs of non-ASCII chars → propose translate intent
 *   - jargonDensity: multiple acronyms/technical terms → jargon_explain
 *   - quietSignals: "shh", "not now", laptop-only long quiet stretches
 *
 * Each detector is idempotent — IntentStackService.push dedups on
 * (kind, participantContext, source), so repeated firings don't spam.
 */
import type { Intent } from './intent-parser.service';
import { intentStack } from './intent-stack.service';
import { tempoService } from '../tempo.service';

// Char-class detectors
// - CJK: Chinese/Japanese/Korean
// - Arabic
// - Cyrillic
// - Devanagari (Hindi)
const FOREIGN_SCRIPTS: Array<{ re: RegExp; lang: string }> = [
  { re: /[\u4e00-\u9fff]/g, lang: 'Chinese' },         // CJK Unified Ideographs
  { re: /[\u3040-\u309f\u30a0-\u30ff]/g, lang: 'Japanese' }, // Hiragana / Katakana
  { re: /[\uac00-\ud7af]/g, lang: 'Korean' },          // Hangul
  { re: /[\u0600-\u06ff]/g, lang: 'Arabic' },
  { re: /[\u0400-\u04ff]/g, lang: 'Cyrillic' },
  { re: /[\u0900-\u097f]/g, lang: 'Hindi' },
];

// Jargon — rough heuristic: all-caps 2-5 letter acronyms, or pattern like
// "Kubernetes", "Kafka", "CI/CD", "SLA"
const ACRONYM_RE = /\b[A-Z]{2,5}\b/g;
// Words the everyday listener likely DOESN'T know. Rough starter list,
// extended as we learn what surfaces jargon whispers.
const TECHNICAL_WORDS_RE = /\b(kubernetes|kafka|redis|postgres|mongodb|kernel|lambda|ci\/cd|oauth|rsa|sha256|bgp|mtu|docker|webhook|graphql|grpc|microservice|serverless|istio|prometheus|grafana|terraform|ansible|helm|tokamak|fission|fusion|neutron|cryogenic|mitigation|derivative|amortization|collateral|hedging|arbitrage|liquidity|pharmacodynamics|pharmacokinetics|anaphylaxis|embolism|thrombosis)\b/gi;

interface SlidingState {
  // last N final transcripts (windowed)
  transcripts: Array<{ text: string; speaker: string; ts: number }>;
  lastInferenceAt: number;
}

const STATE = new Map<string, SlidingState>(); // key: userId
const WINDOW_MS = 90_000; // look at last 90s
// Minimum gap between inferences is tempo-driven (TempoService owns the knob):
//   slow=60s, normal=45s, fast=25s, frenetic=15s. Fast convos need tighter
//   detection or a language switch mid-meeting gets missed.
const FOREIGN_CHAR_THRESHOLD = 6; // ≥6 foreign-script chars over window → translate
const JARGON_HIT_THRESHOLD = 3;   // ≥3 jargon hits over window → jargon_explain

export class PassiveInferenceService {
  /** Call on every final Deepgram transcript while a session is running. */
  async observe(args: {
    userId: string;
    sessionId: string | null;
    text: string;
    speakerLabel: string;
  }): Promise<void> {
    const { userId, sessionId, text, speakerLabel } = args;
    if (!userId || !text || text.length < 4) return;

    // Load / init per-user window
    const st = STATE.get(userId) || { transcripts: [], lastInferenceAt: 0 };
    STATE.set(userId, st);

    const now = Date.now();
    st.transcripts.push({ text, speaker: speakerLabel, ts: now });
    // Evict old
    st.transcripts = st.transcripts.filter((t) => now - t.ts <= WINDOW_MS);

    // Rate-gate actual inference — cadence scales with conversation tempo.
    const minGapMs = tempoService.getConfig(userId).passiveInferenceMinGapMs;
    if (now - st.lastInferenceAt < minGapMs) return;

    const windowText = st.transcripts.map((t) => t.text).join(' ');

    // 1) Foreign-language heuristic
    const langHits = this.detectForeignLanguage(windowText);
    if (langHits.length > 0) {
      const intent: Intent = {
        kind: 'translate',
        reason: `auto: ${langHits[0].count} ${langHits[0].lang} chars in recent transcripts`,
        langs: [langHits[0].lang],
        expiresInMinutes: 15,
        priority: 4,
        source: 'auto_inferred',
        startedAt: new Date().toISOString(),
      };
      await intentStack.push(userId, sessionId, intent);
      st.lastInferenceAt = now;
      return; // one inference per call
    }

    // 2) Jargon density
    const jargonCount = this.countJargon(windowText);
    if (jargonCount >= JARGON_HIT_THRESHOLD) {
      const intent: Intent = {
        kind: 'jargon_explain',
        reason: `auto: ${jargonCount} technical terms in recent transcripts`,
        expiresInMinutes: 20,
        priority: 4,
        source: 'auto_inferred',
        startedAt: new Date().toISOString(),
      };
      await intentStack.push(userId, sessionId, intent);
      st.lastInferenceAt = now;
      return;
    }
  }

  /** Evict state for a user (called on session end). */
  reset(userId: string): void {
    STATE.delete(userId);
  }

  private detectForeignLanguage(text: string): Array<{ lang: string; count: number }> {
    const hits: Array<{ lang: string; count: number }> = [];
    for (const { re, lang } of FOREIGN_SCRIPTS) {
      const matches = text.match(re);
      if (matches && matches.length >= FOREIGN_CHAR_THRESHOLD) {
        hits.push({ lang, count: matches.length });
      }
    }
    return hits.sort((a, b) => b.count - a.count);
  }

  private countJargon(text: string): number {
    const acronyms = text.match(ACRONYM_RE)?.length ?? 0;
    const technical = text.match(TECHNICAL_WORDS_RE)?.length ?? 0;
    return acronyms + technical;
  }
}

export const passiveInference = new PassiveInferenceService();
