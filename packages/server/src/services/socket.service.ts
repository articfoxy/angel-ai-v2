import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { SearchService } from './search.service';
import { RealtimeService, buildAngelInstructions } from './realtime.service';
import { ExtractionService } from './memory/extraction.service';
import { runPostSessionReflection } from './memory/reflection.service';
import { CartesiaTTSService } from './tts.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MAX_SESSION_DURATION_MS = 7_200_000; // 2 hours
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes with no new transcript
const ALLOWED_OWNER_LANGUAGES = ['English', 'Chinese', 'Malay', 'Spanish', 'French', 'Japanese', 'Korean', 'Hindi'];
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY || '';
const DEFAULT_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

export function setupSocketHandlers(io: Server) {
  const search = new SearchService();

  // Auth middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
      if ((payload as any).type === 'refresh') {
        return next(new Error('Access token required'));
      }
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`Client connected: ${socket.userId}`);
    let deepgram: DeepgramService | null = null;
    let realtime: RealtimeService | null = null;
    let transcriptBuffer: string[] = [];
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSessionId: string | null = null;
    let tts: CartesiaTTSService | null = null;
    let ttsPlaying = false; // Echo gate: true while TTS audio plays on client
    let ttsEchoTimer: ReturnType<typeof setTimeout> | null = null; // Safety timeout for echo gate

    function clearAllTimers() {
      if (sessionTimer) {
        clearTimeout(sessionTimer);
        sessionTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log(`Session ${currentSessionId} idle timeout (${IDLE_TIMEOUT_MS / 1000}s with no transcript)`);
        socket.emit('session:timeout', {
          sessionId: currentSessionId,
          reason: 'idle',
          message: 'Session timed out due to inactivity',
        });
        cleanupSession();
      }, IDLE_TIMEOUT_MS);
    }

    let angelProcessing = false; // Guard against concurrent angel:activate calls
    let angelThinkingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastActivateTime = 0; // Timestamp-based rate limit for angel:activate

    /**
     * Handle a whisper from the Realtime API — execute any actions and emit to client.
     */
    async function handleRealtimeWhisper(
      userId: string,
      whisper: { type: string; content: string; detail?: string; confidence?: number; action?: 'save_memory' | 'web_search'; actionData?: Record<string, unknown> }
    ): Promise<void> {
      // Execute actions if the model returned a command
      if (whisper.action === 'save_memory' && whisper.actionData) {
        try {
          await prisma.memory.create({
            data: {
              userId,
              content: String(whisper.actionData.content || whisper.content),
              importance: Number(whisper.actionData.importance) || 7,
              category: String(whisper.actionData.category || 'fact'),
              source: currentSessionId || 'voice_command',
            },
          });
          console.log(`[agent] Saved memory for user ${userId}: ${whisper.actionData.content}`);
        } catch (memErr) {
          console.error('[agent] Failed to save memory:', memErr);
          whisper.content = 'Failed to save to memory. I\'ll try again next time.';
          whisper.type = 'warning';
        }
      }

      if (whisper.action === 'web_search' && whisper.actionData?.query) {
        try {
          const results = await search.search(String(whisper.actionData.query));
          const formatted = results
            .map((r) => r.title ? `${r.title}: ${r.snippet}` : r.snippet)
            .join('\n\n');
          whisper.detail = formatted || 'No results found.';
          whisper.content = `🔍 ${whisper.actionData.query}`;
        } catch (searchErr) {
          console.error('[agent] Search failed:', searchErr);
          whisper.detail = 'Search failed. I\'ll answer from my knowledge instead.';
        }
      }

      const card = {
        id: uuid(),
        type: whisper.type,
        content: whisper.content,
        detail: whisper.detail,
        confidence: whisper.confidence,
        createdAt: new Date().toISOString(),
      };
      socket.emit('whisper', card);

      // Speak the whisper via TTS (voice output through AirPods)
      if (tts && tts.isConnected && whisper.content && whisper.content.length >= 3) {
        tts.speak(card.id, whisper.content);
      }

      // Clear thinking indicator as soon as whisper arrives (don't wait for timeout)
      if (angelProcessing) {
        angelProcessing = false;
        if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
        socket.emit('angel:thinking', { active: false });
      }
    }

    async function cleanupSession() {
      clearAllTimers();
      angelProcessing = false;
      if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
      if (testTimer) { clearTimeout(testTimer); testTimer = null; }

      // Close services in parallel for faster cleanup
      const closePromises: Promise<void>[] = [];
      if (realtime) {
        const rt = realtime;
        realtime = null;
        closePromises.push(rt.close().catch((err: any) => console.error('[cleanup] Realtime close error:', err)));
      }
      if (deepgram) {
        const dg = deepgram;
        deepgram = null;
        closePromises.push(dg.close().catch((err: any) => console.error('[cleanup] Deepgram close error:', err)));
      }
      if (tts) {
        const t = tts;
        tts = null;
        ttsPlaying = false;
        if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
        closePromises.push(t.close().catch((err: any) => console.error('[cleanup] TTS close error:', err)));
      }
      if (closePromises.length > 0) {
        await Promise.allSettled(closePromises);
      }

      transcriptBuffer = [];
      currentSessionId = null;
    }

    socket.on('session:start', async (payload: {
      sessionId: string;
      byok?: { provider: string; apiKey: string; model?: string };
      speech?: { keywords?: string[] };
      instructions?: string;
      ownerLanguage?: string;
      voiceId?: string;
    }) => {
      const { sessionId } = payload;
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      // Guard: if connections already exist (e.g., rapid reconnect),
      // clean them up before creating new ones to prevent orphaned connections.
      if (deepgram || realtime || tts) {
        console.log(`[session] Cleaning up existing connections before re-start for session ${sessionId}`);
        await cleanupSession();
      }

      transcriptBuffer = [];
      currentSessionId = sessionId;
      const userId = socket.userId;

      // Validate BYOK key format if provided
      if (payload.byok?.apiKey) {
        const keyStr = String(payload.byok.apiKey).trim();
        if (keyStr.length < 10 || keyStr.length > 200 || /[\s\x00-\x1f]/.test(keyStr)) {
          console.warn(`[session] Invalid BYOK key format from user ${socket.userId}`);
          socket.emit('session:error', { sessionId, message: 'Invalid API key format' });
          await cleanupSession();
          return;
        }
      }

      // Initialize OpenAI Realtime API for always-active Angel
      const openaiKey = payload.byok?.provider === 'openai' && payload.byok?.apiKey
        ? payload.byok.apiKey
        : process.env.OPENAI_API_KEY || '';

      if (openaiKey) {
        const userInstructions = payload.instructions || 'Help me with jargon and provide useful insights.';
        const ownerLanguage = ALLOWED_OWNER_LANGUAGES.includes(payload.ownerLanguage as string)
          ? (payload.ownerLanguage as string)
          : 'English';
        console.log(`[session] Owner language: ${ownerLanguage}, Instructions length: ${userInstructions.length}`);
        realtime = new RealtimeService({
          apiKey: openaiKey,
          instructions: buildAngelInstructions(userInstructions, ownerLanguage),
          onWhisper: (whisper) => {
            handleRealtimeWhisper(userId, whisper).catch((err) => {
              console.error('[Realtime] Whisper handling error:', err);
            });
          },
          onError: (error) => {
            console.error('[Realtime] Error:', error);
          },
          onStatus: (status) => {
            console.log(`[Realtime] Status: ${status}`);
            socket.emit('realtime:status', { status });
          },
        });

        try {
          await realtime.connect();
          console.log(`[session] Realtime API connected for session ${sessionId}`);
        } catch (err) {
          console.error('[session] Realtime API connection failed:', err);
          // Non-fatal — session continues with Deepgram only, no AI whispers
          realtime = null;
        }
      } else {
        console.warn('[session] No OpenAI API key — Realtime AI whispers disabled');
      }

      // Initialize Cartesia TTS for voice output (whispers spoken aloud via AirPods)
      if (CARTESIA_API_KEY) {
        tts = new CartesiaTTSService({
          apiKey: CARTESIA_API_KEY,
          voiceId: payload.voiceId || DEFAULT_VOICE_ID,
          onAudioChunk: (data) => {
            socket.emit('tts:chunk', data);
          },
          onStart: (data) => {
            ttsPlaying = true;
            // Safety timeout: release echo gate after 30s even if client never confirms
            if (ttsEchoTimer) clearTimeout(ttsEchoTimer);
            ttsEchoTimer = setTimeout(() => {
              if (ttsPlaying) {
                console.warn('[TTS] Echo gate safety timeout — releasing after 30s');
                ttsPlaying = false;
              }
              ttsEchoTimer = null;
            }, 30_000);
            socket.emit('tts:start', data);
          },
          onDone: (data) => {
            socket.emit('tts:done', data);
            // ttsPlaying stays true until client confirms playback end via tts:finished
          },
          onError: (error) => {
            console.error('[TTS] Error:', error);
            ttsPlaying = false;
            if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
          },
        });

        try {
          await tts.connect();
          console.log(`[session] TTS connected for session ${sessionId}`);
        } catch (err) {
          console.error('[session] TTS connection failed:', err);
          tts = null;
        }
      }

      // Load voiceprint for owner identification (if enrolled)
      // Wrapped in try-catch — table may not exist yet if migration hasn't run
      let voiceprintRecord: any = null;
      try {
        voiceprintRecord = await prisma.voiceprint.findUnique({
          where: { userId: socket.userId },
        });
      } catch (err) {
        console.warn('[session] Voiceprint lookup failed (table may not exist):', (err as any).code);
      }

      // Initialize Deepgram with diarization
      deepgram = new DeepgramService({
        onTranscript: (data) => {
          socket.emit('transcript', data);

          // Reset idle timer on ANY transcript (including interim results).
          resetIdleTimer();

          // Buffer transcript for whisper generation
          if (data.isFinal && data.text.trim()) {
            const label = data.speakerLabel || data.speaker || 'Unknown';
            transcriptBuffer.push(`[${label}]: ${data.text.slice(0, 500)}`);
            if (transcriptBuffer.length > 60) {
              transcriptBuffer = transcriptBuffer.slice(-40);
            }

            // Feed transcript to Realtime API (always-active Angel)
            // Echo gate: skip during TTS playback to prevent AI responding to its own voice
            if (realtime && !ttsPlaying) {
              realtime.feedTranscript(`[${label}]: ${data.text}`);
            }

            // Voice wake word detection: "hi angel", "hey angel", "yo angel", "ok angel"
            if (label === 'Owner') {
              const lower = data.text.toLowerCase().trim();
              const wakePatterns = /\b(hi|hey|yo|ok|okay)\s+angel\b/;
              if (wakePatterns.test(lower) && !angelProcessing) {
                console.log(`[agent] Wake word detected: "${data.text}"`);
                angelProcessing = true;
                socket.emit('angel:thinking', { active: true });

                // Clear any existing thinking timer before setting new one
                if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); }
                // Small delay to let the owner finish their sentence, then force respond
                const wakeDelayTimer = setTimeout(async () => {
                  // Guard: if angel was deactivated while waiting, don't proceed
                  if (!angelProcessing) return;
                  try {
                    if (realtime) {
                      realtime.forceRespond();
                    }
                  } catch (err) {
                    console.error('[agent] Wake word response error:', err);
                  }
                  // forceRespond is async via WebSocket — set max thinking indicator
                  angelThinkingTimer = setTimeout(() => {
                    if (angelProcessing) {
                      angelProcessing = false;
                      socket.emit('angel:thinking', { active: false });
                    }
                    angelThinkingTimer = null;
                  }, 5000);
                }, 2000); // 2s delay to capture the full sentence after the wake word
                // Track the outer timer so cleanupSession can cancel it
                angelThinkingTimer = wakeDelayTimer;
              }
            }
          }
        },
        onSpeakerIdentified: (speakerId, label) => {
          socket.emit('speaker:identified', { speakerId, label });
        },
        onError: (errorMsg) => {
          socket.emit('session:error', { sessionId, message: errorMsg });
        },
        onConnectionStatus: (status) => {
          socket.emit('deepgram:status', { sessionId, status });
        },
        voiceprint: voiceprintRecord?.features ?? null,
        sessionId,
        userId,
        keywords: payload.speech?.keywords,
      });

      try {
        await deepgram.connect();
      } catch (err: any) {
        const message = err?.message || (typeof err === 'string' ? err : JSON.stringify(err)) || 'Failed to connect to transcription service';
        console.error('Deepgram connection failed:', message, err);
        socket.emit('session:error', { sessionId, message });
        cleanupSession();
        return;
      }

      // Max session duration timeout (2 hours)
      sessionTimer = setTimeout(() => {
        console.log(`Session ${sessionId} hit max duration (${MAX_SESSION_DURATION_MS / 1000}s)`);
        socket.emit('session:timeout', {
          sessionId,
          reason: 'max_duration',
          message: 'Session reached maximum duration of 2 hours',
        });
        cleanupSession();
      }, MAX_SESSION_DURATION_MS);

      // Start idle timer (will be reset on each transcript)
      resetIdleTimer();

      console.log(`Session started: ${sessionId}`);
    });

    socket.on('audio', (audioData: string | Buffer | ArrayBuffer) => {
      // Only accept audio during an active session with a live Deepgram connection
      if (!currentSessionId || !deepgram) return;

      try {
        let buffer: Buffer;

        if (Buffer.isBuffer(audioData)) {
          buffer = audioData;
        } else if (audioData instanceof ArrayBuffer) {
          // Binary transport from mobile (Uint8Array.buffer)
          buffer = Buffer.from(audioData);
        } else if (typeof audioData === 'string') {
          // Legacy base64 transport (fallback)
          buffer = Buffer.from(audioData, 'base64');
        } else {
          return;
        }

        // Reject empty or oversized chunks (max ~256KB ≈ 8s of audio)
        if (buffer.length === 0 || buffer.length > 262144) return;

        deepgram.sendAudio(buffer);
      } catch (err) {
        console.warn('[socket] Failed to process audio chunk:', err);
      }
    });

    // Angel manual activation — button press triggers immediate response via Realtime API
    socket.on('angel:activate', async () => {
      if (!currentSessionId || !socket.userId || angelProcessing) return;

      // Rate limit: reject if called within 5 seconds of last activation
      const now = Date.now();
      if (now - lastActivateTime < 5000) {
        return;
      }
      lastActivateTime = now;
      if (transcriptBuffer.length < 1) {
        socket.emit('whisper', {
          id: uuid(),
          type: 'response',
          content: 'I need some conversation to work with first. Keep talking!',
          createdAt: new Date().toISOString(),
        });
        return;
      }

      angelProcessing = true;
      socket.emit('angel:thinking', { active: true });

      try {
        if (realtime) {
          realtime.forceRespond();
          // forceRespond triggers async response via WebSocket
          // Set a max timeout to clear thinking indicator
          angelThinkingTimer = setTimeout(() => {
            angelProcessing = false;
            socket.emit('angel:thinking', { active: false });
            angelThinkingTimer = null;
          }, 8000);
        } else {
          // No Realtime connection — fallback message
          socket.emit('whisper', {
            id: uuid(),
            type: 'warning',
            content: 'Angel AI is not connected. Check your API key in settings.',
            createdAt: new Date().toISOString(),
          });
          angelProcessing = false;
          socket.emit('angel:thinking', { active: false });
        }
      } catch (err) {
        console.error('[angel:activate] Error:', err);
        socket.emit('whisper', {
          id: uuid(),
          type: 'warning',
          content: 'Something went wrong. Try again in a moment.',
          createdAt: new Date().toISOString(),
        });
        angelProcessing = false;
        socket.emit('angel:thinking', { active: false });
      }
    });

    // TTS client control events
    socket.on('tts:skip', () => {
      if (tts) tts.cancel();
      ttsPlaying = false;
      if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
      socket.emit('tts:cancel', {});
    });

    socket.on('tts:finished', () => {
      ttsPlaying = false;
      if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
    });

    // ── Test conversation mode ──
    let testTimer: ReturnType<typeof setTimeout> | null = null;
    socket.on('session:test', () => {
      if (!currentSessionId || !realtime) return;
      console.log('[test] Starting test conversation');

      const SPEAKERS = [
        { id: 'speaker_0', label: 'Dr. Chen' },
        { id: 'speaker_1', label: 'Dr. Morrison' },
        { id: 'speaker_2', label: 'Dr. Patel' },
      ];

      // Identify speakers
      for (const s of SPEAKERS) {
        socket.emit('speaker:identified', { speakerId: s.id, label: s.label });
      }

      const SCRIPT: { speaker: number; text: string; delay: number }[] = [
        { speaker: 2, delay: 1000, text: "Good morning. Let's review the latest results from the SPARC tokamak high-field test campaign. Sarah, you want to lead us off?" },
        { speaker: 0, delay: 7000, text: "Sure. The big headline — we achieved a plasma current of 8.7 mega-amperes in the latest deuterium-tritium shot. The ion temperature peaked at 120 million Kelvin, well above the Lawson criterion threshold." },
        { speaker: 1, delay: 8000, text: "What about the energy confinement time? Last run we were struggling with neoclassical tearing modes destabilizing the plasma edge." },
        { speaker: 0, delay: 7000, text: "We deployed a new ECCD profile — electron cyclotron current drive — targeting the q equals 2 rational surface. That fully suppressed the NTMs. Energy confinement time improved to 1.4 seconds." },
        { speaker: 2, delay: 7000, text: "And the Q factor? That's what the board is waiting for." },
        { speaker: 0, delay: 6000, text: "Q equals 2.3 for this shot. That's genuine net energy gain. Fusion power output was approximately 140 megawatts thermal against 60 megawatts of auxiliary heating input." },
        { speaker: 1, delay: 8000, text: "I need to flag a materials concern. The tungsten divertor tiles showed significant sputtering erosion — roughly 3 microns per shot. At this rate, we need a replacement cycle every 200 plasma discharges." },
        { speaker: 2, delay: 5000, text: "Is that within the design envelope?" },
        { speaker: 1, delay: 7000, text: "Barely. The neutron flux at the first wall reached 2.4 megawatts per square meter. The RAFM steel — reduced activation ferritic martensitic — is holding up, but we're seeing helium bubble formation at the grain boundaries after 5 dpa." },
        { speaker: 0, delay: 7000, text: "James, what about the silicon carbide fiber composite as an alternative PFC? The thermal shock resistance should be significantly better." },
        { speaker: 1, delay: 8000, text: "We have SiC-f samples under neutron irradiation at the IFMIF facility. Early results are mixed — better radiation hardness, but thermal conductivity degrades 40 percent after 10 displacements per atom." },
        { speaker: 2, delay: 6000, text: "OK, let's move to tritium breeding. We need a TBR above 1.1 for fuel self-sufficiency." },
        { speaker: 0, delay: 7000, text: "The lithium-lead eutectic blanket modules measured a TBR of 1.08 this campaign. Below target. The beryllium neutron multiplier layer needs to be thicker." },
        { speaker: 1, delay: 7000, text: "My MCNP Monte Carlo neutronics simulations suggest increasing the beryllium pebble bed from 2 to 3 centimeters. That should push us to 1.14 TBR with acceptable tritium permeation rates through the EUROFER membrane." },
        { speaker: 0, delay: 8000, text: "Now here's the real breakthrough. We observed a new operating regime we're calling Super H-mode. The pedestal pressure was 30 percent higher than standard H-mode, with zero ELMs — no edge localized modes at all." },
        { speaker: 2, delay: 5000, text: "That's significant. ELM mitigation has been one of our biggest engineering headaches. What's driving it?" },
        { speaker: 0, delay: 8000, text: "The bootstrap current fraction reached 65 percent, which reduces external current drive requirements substantially. Gyrokinetic TGLF simulations show turbulent transport is dominated by trapped electron modes rather than the usual ITG modes. Completely different optimization landscape." },
        { speaker: 1, delay: 8000, text: "On the magnets — the REBCO high-temperature superconducting coils sustained 20 Tesla on axis with zero quench events. And since they operate at 20 Kelvin instead of 4K for legacy NbTi coils, cryoplant power drops 60 percent." },
        { speaker: 0, delay: 7000, text: "Alpha particle confinement was excellent too. Fast-ion loss detectors showed under 5 percent alpha losses. Most 3.5 MeV fusion alphas are thermalizing in the core and driving self-heating. We did see residual toroidal Alfvén eigenmodes above the TAE gap frequency, but ICRH tail modification is keeping them stable." },
        { speaker: 2, delay: 7000, text: "Let's talk path to commercial. Our target is a pilot plant at 500 megawatts electric by 2035. Based on today's data, where do we stand?" },
        { speaker: 0, delay: 6000, text: "If Super H-mode reproduces and we demonstrate Q equals 10, the physics basis is complete. The main risk shifts entirely to engineering." },
        { speaker: 1, delay: 8000, text: "Agreed. Three key engineering gaps: first, structural materials that withstand 20 dpa without property degradation. Second, a tritium fuel cycle processing 300 grams per day with less than one percent inventory losses. Third, extending from 8-second pulses to true steady-state operation — probably needs a full non-inductive current drive solution." },
        { speaker: 2, delay: 7000, text: "What about the stellarator path? Wendelstein 7-X just published their latest results." },
        { speaker: 0, delay: 7000, text: "Stellarators have intrinsic steady-state advantage since they don't rely on inductively-driven plasma current. But the complex 3D magnetic geometry makes divertor engineering extremely difficult. Tokamaks remain the faster path to net electricity." },
        { speaker: 2, delay: 7000, text: "Excellent work. Next DT campaign in three weeks. James, I need your updated neutronics by Friday. Sarah, prepare the Super H-mode reproducibility protocol. Let's make Q equals 10 happen." },
      ];

      let idx = 0;
      let cumDelay = 0;

      const emitNext = () => {
        if (idx >= SCRIPT.length || !currentSessionId) {
          testTimer = null;
          return;
        }
        const seg = SCRIPT[idx];
        const sp = SPEAKERS[seg.speaker];
        const id = `test-final-${idx}`;

        // Emit transcript to client
        socket.emit('transcript', {
          id,
          speaker: sp.id,
          speakerLabel: sp.label,
          text: seg.text,
          isFinal: true,
          timestamp: Date.now(),
        });

        // Buffer transcript (same as normal flow)
        transcriptBuffer.push(`[${sp.label}]: ${seg.text.slice(0, 500)}`);
        if (transcriptBuffer.length > 60) {
          transcriptBuffer = transcriptBuffer.slice(-40);
        }

        // Feed to Realtime AI (respects echo gate)
        if (realtime && !ttsPlaying) {
          realtime.feedTranscript(`[${sp.label}]: ${seg.text}`);
        }

        // Reset idle timer
        resetIdleTimer();

        idx++;
        if (idx < SCRIPT.length) {
          testTimer = setTimeout(emitNext, SCRIPT[idx].delay);
        }
      };

      testTimer = setTimeout(emitNext, SCRIPT[0].delay);
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      // Validate session ownership to prevent another user from stopping a session
      if (!socket.userId) return;
      const sessionRecord = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!sessionRecord) {
        console.warn(`[session:stop] Rejected — user ${socket.userId} does not own session ${sessionId}`);
        return;
      }

      // Grab speakers and flush episodes BEFORE cleanup closes connections
      const speakers = deepgram ? deepgram.getSpeakers() : {};
      if (deepgram) await deepgram.flush();
      const userId = socket.userId;

      // Use shared cleanup (closes realtime, deepgram, clears timers + state)
      await cleanupSession();

      if (userId) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), status: 'processing', speakers },
        });

        // Post-session: extract memories, entities, reflections
        const extraction = new ExtractionService();
        extraction.processSession(sessionId, userId).then(async (extractionResult) => {
          const summary = extractionResult?.summary || 'Session completed';

          await prisma.session.update({
            where: { id: sessionId },
            data: { status: 'ended', summary },
          });

          // Emit session:debrief with comprehensive data
          socket.emit('session:debrief', {
            sessionId,
            summary,
            memoriesExtracted: extractionResult?.memoriesExtracted ?? 0,
            entitiesFound: extractionResult?.entitiesFound ?? 0,
            duration: extractionResult?.duration ?? null,
            completedAt: new Date().toISOString(),
          });

          // Run reflection + maintenance
          runPostSessionReflection(userId).catch((err) => {
            console.error('Post-session reflection/maintenance error:', err);
          });
        }).catch((err) => {
          console.error('Post-session extraction error:', err);
          // Still emit debrief on error so the client knows the session ended
          socket.emit('session:debrief', {
            sessionId,
            summary: 'Session ended but extraction encountered an error',
            error: true,
            completedAt: new Date().toISOString(),
          });
        });
      }

      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      cleanupSession();
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
