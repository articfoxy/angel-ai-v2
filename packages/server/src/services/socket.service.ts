import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { SearchService } from './search.service';
import { RealtimeService, buildAngelInstructions } from './realtime.service';
import { ExtractionService } from './memory/extraction.service';
import { runPostSessionReflection } from './memory/reflection.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MAX_SESSION_DURATION_MS = 7_200_000; // 2 hours
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes with no new transcript

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
      if (realtime) {
        await realtime.close();
        realtime = null;
      }
      if (deepgram) {
        await deepgram.close();
        deepgram = null;
      }
      transcriptBuffer = [];
      currentSessionId = null;
    }

    socket.on('session:start', async (payload: {
      sessionId: string;
      byok?: { provider: string; apiKey: string; model?: string };
      speech?: { language?: string; keywords?: string[] };
      instructions?: string;
      ownerLanguage?: string;
    }) => {
      const { sessionId } = payload;
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      // Guard: if connections already exist (e.g., rapid reconnect),
      // clean them up before creating new ones to prevent orphaned connections.
      if (deepgram || realtime) {
        console.log(`[session] Cleaning up existing connections before re-start for session ${sessionId}`);
        await cleanupSession();
      }

      transcriptBuffer = [];
      currentSessionId = sessionId;
      const userId = socket.userId;

      // Initialize OpenAI Realtime API for always-active Angel
      const openaiKey = payload.byok?.provider === 'openai' && payload.byok?.apiKey
        ? payload.byok.apiKey
        : process.env.OPENAI_API_KEY || '';

      if (openaiKey) {
        const userInstructions = payload.instructions || 'Help me with jargon and provide useful insights.';
        const ownerLanguage = payload.ownerLanguage || 'English';
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
            transcriptBuffer.push(`[${label}]: ${data.text}`);
            if (transcriptBuffer.length > 60) {
              transcriptBuffer = transcriptBuffer.slice(-40);
            }

            // Feed transcript to Realtime API (always-active Angel)
            if (realtime) {
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

                // Small delay to let the owner finish their sentence, then force respond
                const wakeDelayTimer = setTimeout(async () => {
                  try {
                    if (realtime) {
                      realtime.forceRespond();
                    }
                  } catch (err) {
                    console.error('[agent] Wake word response error:', err);
                  }
                  // forceRespond is async via WebSocket — set max thinking indicator
                  // Clear the outer reference before setting the new timeout
                  angelThinkingTimer = setTimeout(() => {
                    angelProcessing = false;
                    socket.emit('angel:thinking', { active: false });
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
        language: payload.speech?.language,
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

      // Clean up timers, Realtime, and Deepgram
      clearAllTimers();

      // Close Realtime API connection
      if (realtime) {
        await realtime.close();
        realtime = null;
      }

      // Grab speakers before closing Deepgram
      const speakers = deepgram ? deepgram.getSpeakers() : {};

      if (deepgram) {
        // Await close to flush all pending episode writes before extraction
        await deepgram.close();
        deepgram = null;
      }

      if (socket.userId) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), status: 'processing', speakers },
        });

        // Post-session: extract memories, entities, reflections
        const userId = socket.userId;
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

      transcriptBuffer = [];
      currentSessionId = null;
      angelProcessing = false;
      if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      cleanupSession();
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
