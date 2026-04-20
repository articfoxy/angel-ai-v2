import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { extractAveragedFeatures, cosineSimilarity, type AudioFeatures } from './audio-features.service';

interface DeepgramConfig {
  onTranscript: (data: {
    id: string;
    text: string;
    speaker?: string;
    speakerLabel?: string;
    timestamp: number;
    isFinal: boolean;
  }) => void;
  onSpeakerIdentified: (speakerId: string, label: string) => void;
  onError?: (error: string) => void;
  onConnectionStatus?: (status: 'connected' | 'reconnecting' | 'disconnected') => void;
  voiceprint?: any | null;  // AudioFeatures from voiceprint enrollment
  sessionId: string;
  userId: string;
  /** Keywords to boost recognition for, e.g. ["kubernetes:2", "LTV:CAC:1.5"] */
  keywords?: string[];
  /** Speech locale hint, e.g. "en-US", "en-GB". Falls back to "multi" if not set. */
  speechLocale?: string;
  /** Session mode — translation mode uses shorter endpointing for clause-level segments */
  mode?: string;
}

const CONNECTION_TIMEOUT_MS = 5000;
const MAX_BUFFERED_CHUNKS = 10;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_STALE_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1000;

/** Deepgram closes idle connections after ~10s of silence. Send keepalive every 5s. */
const KEEPALIVE_INTERVAL_MS = 5000;

export class DeepgramService {
  private connection: any = null;
  private config: DeepgramConfig;
  private speakerMap: Map<number, string> = new Map();
  private speakerCounts: Map<number, number> = new Map();
  private ownerIdentified = false;
  private sessionStartTime: number = 0;
  private ready = false;
  private audioBuffer: Buffer[] = [];
  private pendingWrites: Promise<any>[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioTime: number = 0;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private totalReconnectCycles = 0;
  private lastReconnectSuccessTime = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastTranscriptTime: number = 0;
  private sessionActive = true;
  private speakerAudioBuffers: Map<number, Buffer[]> = new Map();
  private audioTimestamps: { buffer: Buffer; timestamp: number }[] = [];
  private episodeWriteErrors = 0;

  constructor(config: DeepgramConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const apiKey = process.env.DEEPGRAM_API_KEY || '';
    if (!apiKey) {
      console.error('[Deepgram] DEEPGRAM_API_KEY is not set! Transcription will fail.');
    } else {
      console.log(`[Deepgram] Connecting with API key: ${apiKey.substring(0, 5)}...`);
    }
    const deepgram = createClient(apiKey);

    // Always use multilingual mode — conversations may mix languages
    // (e.g. someone speaks Chinese, owner speaks English). The speech
    // locale setting is reserved for future single-language optimizations.
    const language = 'multi';

    const dgOptions: Record<string, unknown> = {
      model: 'nova-3',
      language,
      smart_format: true,
      diarize: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: true,
      // Translation mode: 80ms endpointing for clause-level segments (faster translation)
      // Other modes: 150ms for full-sentence segments (more context for insights)
      endpointing: this.config.mode === 'translation' || this.config.mode === 'hybrid' ? 80 : 150,
      vad_events: true,
      no_delay: true,
    };

    // Keyword boosting: improves recognition for specific terms
    if (this.config.keywords && this.config.keywords.length > 0) {
      dgOptions.keywords = this.config.keywords;
    }

    console.log(`[Deepgram] Mode: ${this.config.mode || 'default'}, Language: ${dgOptions.language}, Endpointing: ${dgOptions.endpointing}ms`);
    this.connection = deepgram.listen.live(dgOptions);

    // Wait for the connection to actually open before returning.
    // Audio sent before Open fires is silently dropped by Deepgram.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Close the dangling connection to prevent resource leak
        try { this.connection.finish(); } catch {}
        this.connection = null;
        reject(new Error(`Deepgram connection timed out after ${CONNECTION_TIMEOUT_MS}ms for session ${this.config.sessionId}`));
      }, CONNECTION_TIMEOUT_MS);

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        this.sessionStartTime = Date.now();
        this.ready = true;

        // Flush any audio that arrived while we were connecting
        for (const chunk of this.audioBuffer) {
          this.connection.send(chunk);
        }
        this.audioBuffer = [];

        console.log(`Deepgram connected for session ${this.config.sessionId}`);

        // Start keepalive: send silent audio frames if no real audio arrives
        // for a while. Deepgram drops idle connections after ~10s.
        this.lastAudioTime = Date.now();
        this.keepaliveTimer = setInterval(() => {
          if (!this.connection || !this.ready) return;
          const silenceMs = Date.now() - this.lastAudioTime;
          if (silenceMs > KEEPALIVE_INTERVAL_MS) {
            // Send 100ms of silence (16kHz * 2 bytes * 0.1s = 3200 bytes of zeros)
            const silence = Buffer.alloc(3200);
            try { this.connection.send(silence); } catch {}
          }
        }, KEEPALIVE_INTERVAL_MS);

        this.startHeartbeat();
        this.config.onConnectionStatus?.('connected');

        resolve();
      });

      // If the connection errors before Open, reject immediately
      this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
        clearTimeout(timeout);
        // Try to extract the HTTP response body for 400/401 errors
        const httpResponse = err?.response;
        if (httpResponse && typeof httpResponse.on === 'function') {
          let body = '';
          httpResponse.on('data', (chunk: any) => { body += chunk; });
          httpResponse.on('end', () => {
            console.error(`[Deepgram] HTTP ${httpResponse.statusCode} response body:`, body);
          });
        }
        const errMsg = err?.message || err?.error || (typeof err === 'string' ? err : JSON.stringify(err));
        console.error(`[Deepgram] Connection error for session ${this.config.sessionId}:`, errMsg);
        console.error(`[Deepgram] Full error object keys:`, Object.keys(err || {}));
        console.error(`[Deepgram] Options sent:`, JSON.stringify(dgOptions));
        reject(new Error(`Deepgram error: ${errMsg}`));
      });
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      this.lastTranscriptTime = Date.now();
      const transcript = data.channel?.alternatives?.[0];
      if (!transcript?.transcript) return;

      const words = transcript.words || [];
      const speaker = words[0]?.speaker;
      const isFinal = data.is_final;

      // Track speaker counts for owner identification
      if (speaker !== undefined && isFinal) {
        const count = this.speakerCounts.get(speaker) || 0;
        this.speakerCounts.set(speaker, count + 1);

        // Identify owner once we have enough data.
        // With voiceprint: wait longer (15 segments) so audio buffers have enough
        // frames for meaningful feature extraction and similarity scoring.
        // Without voiceprint: 10 segments is enough for frequency-based heuristic.
        if (!this.ownerIdentified) {
          const totalCount = Array.from(this.speakerCounts.values()).reduce((a, b) => a + b, 0);
          const threshold = this.config.voiceprint ? 15 : 10;
          if (totalCount >= threshold) {
            this.identifyOwner();
          }
        }
      }

      // Buffer audio for voiceprint matching
      if (isFinal && speaker !== undefined && this.config.voiceprint) {
        const segStart = this.sessionStartTime + (data.start ?? 0) * 1000;
        const segEnd = segStart + (data.duration ?? 0) * 1000;
        const segmentAudio = this.audioTimestamps
          .filter(a => a.timestamp >= segStart - 500 && a.timestamp <= segEnd + 500)
          .map(a => a.buffer);
        if (segmentAudio.length > 0) {
          if (!this.speakerAudioBuffers.has(speaker)) {
            this.speakerAudioBuffers.set(speaker, []);
          }
          const buf = this.speakerAudioBuffers.get(speaker)!;
          buf.push(...segmentAudio);
          // Cap at 30 frames per speaker to prevent memory leak in long sessions.
          // 30 frames is more than enough for feature extraction (we use up to 20).
          if (buf.length > 30) {
            this.speakerAudioBuffers.set(speaker, buf.slice(-30));
          }
        }
      }

      const speakerLabel = this.getSpeakerLabel(speaker);
      const segmentId = isFinal ? uuid() : `interim-${speaker ?? 'unknown'}`;

      this.config.onTranscript({
        id: segmentId,
        text: transcript.transcript,
        speaker: speaker !== undefined ? `speaker_${speaker}` : undefined,
        speakerLabel,
        timestamp: Date.now(),
        isFinal,
      });

      // Store final segments as Observations (Layer C — append-only raw events).
      // The MemoryJudgeService batches these into Episodes + Facts on triggers.
      // Route through ObservationService so privacy-mode + classification applies.
      if (isFinal && transcript.transcript.trim()) {
        const observedAt = new Date(this.sessionStartTime + (data.start ?? 0) * 1000);
        const content = transcript.transcript;
        const writePromise = (async () => {
          try {
            const { ObservationService } = await import('./memory/observation.service');
            const { policyService } = await import('./memory/policy.service');
            const [obs, profile] = await Promise.all([
              Promise.resolve(new ObservationService()),
              policyService.profileFor(this.config.userId),
            ]);
            const id = await obs.write({
              sessionId: this.config.sessionId,
              userId: this.config.userId,
              observedAt,
              modality: 'audio_transcript',
              source: 'deepgram',
              speaker: speakerLabel || `speaker_${speaker ?? 'unknown'}`,
              content,
              importance: 5,
              extractorVersions: { asr: 'deepgram-nova-2' },
            }, profile.privacyMode);
            if (!id) {
              // Policy denied persistence — log at debug level, not an error
              // (this is expected behavior in privacy_meeting mode)
            }
          } catch (err: any) {
            this.episodeWriteErrors++;
            console.error(`[Deepgram] Observation save error (#${this.episodeWriteErrors}):`, err?.message);
            if (this.episodeWriteErrors === 5) {
              console.warn(`[Deepgram] ${this.episodeWriteErrors} observation write failures — transcript data may be lost`);
              this.config.onError?.('Some transcript data could not be saved. Session will continue.');
            }
          }
        })();

        // Track pending writes so we can await them before closing
        this.pendingWrites.push(writePromise);
        writePromise.finally(() => {
          this.pendingWrites = this.pendingWrites.filter((p) => p !== writePromise);
        });
      }
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error('Deepgram error:', err);
      // Don't call this.close() here — it sets sessionActive=false and prevents
      // the Close event handler from triggering auto-reconnect.
      // The Close event will fire after Error, and that's where reconnect happens.
      // Only emit an informational error to the client.
      if (this.config.onError) {
        this.config.onError(`Deepgram streaming error: ${err?.message || 'unknown'}`);
      }
    });

    this.connection.on(LiveTranscriptionEvents.Close, async () => {
      console.warn(`[Deepgram] Connection closed for session ${this.config.sessionId}`);
      this.ready = false;
      if (this.sessionActive && !this.reconnecting) {
        this.config.onConnectionStatus?.('reconnecting');
        await this.attemptReconnect();
      }
    });

    this.connection.on(LiveTranscriptionEvents.Unhandled, (data: any) => {
      console.warn(`[Deepgram] Unhandled event for session ${this.config.sessionId}:`, data);
    });

    this.connection.on(LiveTranscriptionEvents.Metadata, () => {
      this.lastTranscriptTime = Date.now();
    });
  }

  private identifyOwner() {
    if (this.config.voiceprint) {
      this.identifyOwnerHybrid();
    } else {
      this.identifyOwnerByFrequency();
    }
  }

  private identifyOwnerByFrequency() {
    let maxSpeaker = 0;
    let maxCount = 0;

    this.speakerCounts.forEach((count, speaker) => {
      if (count > maxCount) {
        maxCount = count;
        maxSpeaker = speaker;
      }
    });

    this.speakerMap.set(maxSpeaker, 'Owner');
    this.config.onSpeakerIdentified(`speaker_${maxSpeaker}`, 'Owner');

    // Label other speakers
    const letters = ['A', 'B', 'C', 'D', 'E'];
    let letterIdx = 0;
    this.speakerCounts.forEach((_, speaker) => {
      if (speaker !== maxSpeaker) {
        const label = `Person ${letters[letterIdx] || letterIdx}`;
        this.speakerMap.set(speaker, label);
        this.config.onSpeakerIdentified(`speaker_${speaker}`, label);
        letterIdx++;
      }
    });

    this.ownerIdentified = true;
  }

  private identifyOwnerHybrid() {
    const scores: Map<number, number> = new Map();
    let totalCount = 0;
    this.speakerCounts.forEach(c => totalCount += c);

    this.speakerCounts.forEach((count, speaker) => {
      const frequency = count / totalCount;
      let similarity = 0;
      const audioBuffers = this.speakerAudioBuffers.get(speaker);
      if (audioBuffers && audioBuffers.length >= 3 && this.config.voiceprint) {
        try {
          const frames = audioBuffers.slice(0, 20);
          const speakerFeatures = extractAveragedFeatures(frames);
          similarity = cosineSimilarity(speakerFeatures, this.config.voiceprint);
        } catch (err) {
          console.warn(`[Deepgram] Feature extraction failed for speaker ${speaker}:`, err);
        }
      }
      const confidence = Math.min(count / 10, 1.0);
      const score = 0.6 * similarity + 0.3 * confidence + 0.1 * frequency;
      scores.set(speaker, score);
    });

    let maxSpeaker = 0, maxScore = -1;
    scores.forEach((score, speaker) => {
      if (score > maxScore) { maxScore = score; maxSpeaker = speaker; }
    });

    console.log(`[Deepgram] Hybrid owner ID - scores:`, Object.fromEntries(scores), `winner: speaker_${maxSpeaker}`);

    this.speakerMap.set(maxSpeaker, 'Owner');
    this.config.onSpeakerIdentified(`speaker_${maxSpeaker}`, 'Owner');

    const letters = ['A', 'B', 'C', 'D', 'E'];
    let letterIdx = 0;
    this.speakerCounts.forEach((_, speaker) => {
      if (speaker !== maxSpeaker) {
        const label = `Person ${letters[letterIdx] || String(letterIdx)}`;
        this.speakerMap.set(speaker, label);
        this.config.onSpeakerIdentified(`speaker_${speaker}`, label);
        letterIdx++;
      }
    });
    this.ownerIdentified = true;
  }

  private getSpeakerLabel(speaker?: number): string | undefined {
    if (speaker === undefined) return undefined;
    return this.speakerMap.get(speaker) || `Speaker ${speaker}`;
  }

  getSpeakers(): Record<string, string> {
    const speakers: Record<string, string> = {};
    this.speakerMap.forEach((label, speaker) => {
      speakers[`speaker_${speaker}`] = label;
    });
    return speakers;
  }

  sendAudio(data: Buffer) {
    if (!this.connection) return;

    const now = Date.now();
    this.lastAudioTime = now;

    // Only buffer timestamps while owner identification is pending (voiceprint matching)
    if (!this.ownerIdentified && this.config.voiceprint) {
      this.audioTimestamps.push({ buffer: data, timestamp: now });
      // Prune old entries every 100 chunks (~5s at 50ms interval) instead of every call
      if (this.audioTimestamps.length % 100 === 0) {
        const cutoff = now - 60_000;
        this.audioTimestamps = this.audioTimestamps.filter(a => a.timestamp > cutoff);
      }
    }

    if (this.ready) {
      this.connection.send(data);
    } else if (this.audioBuffer.length < MAX_BUFFERED_CHUNKS) {
      // Buffer audio until the connection is ready (up to MAX_BUFFERED_CHUNKS)
      this.audioBuffer.push(data);
    }
    // Chunks beyond the buffer limit are dropped to avoid unbounded memory growth
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || !this.sessionActive) return;

    // Cap total reconnect cycles per session to prevent infinite reconnect loops
    this.totalReconnectCycles++;
    if (this.totalReconnectCycles > 10) {
      console.error(`[Deepgram] Max total reconnect cycles (10) exceeded for session ${this.config.sessionId}`);
      this.config.onConnectionStatus?.('disconnected');
      this.config.onError?.('Transcription connection unstable. Please restart the session.');
      return;
    }

    // Cooldown: don't reconnect if last success was <5s ago (likely flapping)
    if (this.lastReconnectSuccessTime && Date.now() - this.lastReconnectSuccessTime < 5000) {
      console.warn(`[Deepgram] Reconnect cooldown — last success was ${Date.now() - this.lastReconnectSuccessTime}ms ago`);
      return;
    }

    this.reconnecting = true;
    this.stopHeartbeat();

    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.connection) { try { this.connection.finish(); } catch {} this.connection = null; }
    this.ready = false;

    // Reset speaker identification — Deepgram may re-assign speaker numbers
    // on the new connection. The voiceprint matching will re-identify correctly.
    this.ownerIdentified = false;
    this.speakerCounts.clear();
    this.speakerMap.clear();
    this.speakerAudioBuffers.clear();

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      if (!this.sessionActive) break;
      const delay = RECONNECT_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[Deepgram] Reconnect attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} for session ${this.config.sessionId} (delay: ${delay}ms)`);
      await new Promise(r => setTimeout(r, delay));
      if (!this.sessionActive) break;
      try {
        await this.connect();
        this.reconnecting = false;
        this.reconnectAttempts = 0;
        this.lastReconnectSuccessTime = Date.now();
        this.config.onConnectionStatus?.('connected');
        console.log(`[Deepgram] Reconnected successfully for session ${this.config.sessionId}`);
        return;
      } catch (err) {
        console.error(`[Deepgram] Reconnect attempt ${attempt} failed:`, err);
      }
    }
    this.reconnecting = false;
    this.config.onConnectionStatus?.('disconnected');
    this.config.onError?.('Transcription connection lost. Please restart the session.');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastTranscriptTime = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (!this.sessionActive || !this.ready || this.reconnecting) return;
      const silenceSinceTranscript = Date.now() - this.lastTranscriptTime;
      const audioFlowing = (Date.now() - this.lastAudioTime) < 5000;
      if (silenceSinceTranscript > HEARTBEAT_STALE_MS && audioFlowing) {
        console.warn(`[Deepgram] Heartbeat: no transcript for ${silenceSinceTranscript}ms despite audio flowing. Reconnecting.`);
        this.config.onConnectionStatus?.('reconnecting');
        this.attemptReconnect();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  /**
   * Wait for all pending episode writes to complete.
   * Call this before processing session data to ensure all episodes are saved.
   */
  async flush(): Promise<void> {
    if (this.pendingWrites.length > 0) {
      console.log(`[Deepgram] Flushing ${this.pendingWrites.length} pending episode writes...`);
      await Promise.allSettled(this.pendingWrites);
      this.pendingWrites = [];
    }
  }

  async close(): Promise<void> {
    this.sessionActive = false;
    this.stopHeartbeat();

    // Stop keepalive first
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    // Flush pending writes before closing
    await this.flush();

    if (this.connection) {
      try { this.connection.finish(); } catch {}
      this.connection = null;
    }
    this.ready = false;
    this.audioBuffer = [];
    this.speakerAudioBuffers.clear();
    this.audioTimestamps = [];
  }
}
