import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { InferenceService } from './inference.service';
import { SearchService } from './search.service';
import { ExtractionService } from './memory/extraction.service';
import { runPostSessionReflection } from './memory/reflection.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const WHISPER_INTERVAL_MS = 10000; // Generate whisper every 10s
const MAX_SESSION_DURATION_MS = 7_200_000; // 2 hours
const IDLE_TIMEOUT_MS = 300_000; // 5 minutes with no new transcript

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

interface InferenceConfig {
  provider: 'openai' | 'anthropic' | 'google';
  apiKey: string;
  model?: string;
}

export function setupSocketHandlers(io: Server) {
  const inference = new InferenceService();
  const search = new SearchService();

  // Auth middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`Client connected: ${socket.userId}`);
    let deepgram: DeepgramService | null = null;
    let transcriptBuffer: string[] = [];
    let whisperTimer: ReturnType<typeof setInterval> | null = null;
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSessionId: string | null = null;

    function clearAllTimers() {
      if (whisperTimer) {
        clearInterval(whisperTimer);
        whisperTimer = null;
      }
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

    let byokConfig: InferenceConfig | undefined;
    let recentWhisperContents: string[] = []; // Track last 10 whispers to avoid duplicates
    let angelProcessing = false; // Guard against concurrent angel:activate calls
    let sessionSkillsCache: string[] = []; // Cache skills for angel:activate

    /**
     * Core whisper generation + action execution + emit.
     * Shared between the periodic timer and angel:activate.
     * @param userId - Owner's user ID
     * @param transcript - The transcript text to analyze
     * @param skills - Active session skills
     * @param isActivation - True if triggered by angel:activate (skips dedup for the first response)
     */
    async function generateAndEmitWhisper(
      userId: string,
      transcript: string,
      skills: string[],
      isActivation = false
    ): Promise<void> {
      const whisper = await inference.generateWhisper(
        userId,
        transcript,
        byokConfig,
        skills,
        recentWhisperContents
      );

      if (!whisper) {
        // If this was a manual activation and no whisper was generated, send a "nothing to add" response
        if (isActivation) {
          socket.emit('whisper', {
            id: uuid(),
            type: 'response',
            content: 'Nothing new to add right now. Keep talking and I\'ll jump in when I can help.',
            createdAt: new Date().toISOString(),
          });
        }
        return;
      }

      // Dedup: skip if we already whispered something very similar (except for activations)
      const contentKey = whisper.content.toLowerCase().slice(0, 60);
      if (!isActivation && recentWhisperContents.some(prev => prev === contentKey)) {
        return;
      }
      recentWhisperContents.push(contentKey);
      if (recentWhisperContents.length > 10) {
        recentWhisperContents = recentWhisperContents.slice(-10);
      }

      // Execute actions if the LLM returned a command
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
    }

    function startWhisperTimer(userId: string, sessionSkills: string[]) {
      sessionSkillsCache = sessionSkills; // Cache for angel:activate
      if (whisperTimer) return; // Already running
      whisperTimer = setInterval(async () => {
        if (transcriptBuffer.length < 2) return;

        const recentTranscript = transcriptBuffer.slice(-20).join('\n');
        try {
          await generateAndEmitWhisper(userId, recentTranscript, sessionSkills);
        } catch (err) {
          console.error('Whisper generation error:', err);
        }
      }, WHISPER_INTERVAL_MS);
    }

    async function cleanupSession() {
      clearAllTimers();
      if (deepgram) {
        await deepgram.close();
        deepgram = null;
      }
      transcriptBuffer = [];
      recentWhisperContents = [];
      currentSessionId = null;
    }

    socket.on('session:start', async (payload: {
      sessionId: string;
      byok?: { provider: string; apiKey: string; model?: string };
      speech?: { language?: string; keywords?: string[] };
    }) => {
      const { sessionId } = payload;
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      // Guard: if a Deepgram connection already exists (e.g., rapid reconnect),
      // clean it up before creating a new one to prevent orphaned connections.
      if (deepgram) {
        console.log(`[session] Cleaning up existing Deepgram connection before re-start for session ${sessionId}`);
        await cleanupSession();
      }

      // Store BYOK config if client provided it
      if (payload.byok?.apiKey) {
        byokConfig = {
          provider: (payload.byok.provider as 'openai' | 'anthropic' | 'google') || 'openai',
          apiKey: payload.byok.apiKey,
          model: payload.byok.model,
        };
      } else {
        byokConfig = undefined;
      }

      transcriptBuffer = [];
      currentSessionId = sessionId;
      const userId = socket.userId;

      // Load voiceprint for owner identification (if enrolled)
      const voiceprintRecord = await prisma.voiceprint.findUnique({
        where: { userId: socket.userId },
      });

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

            // Start whisper timer on first real transcript segment (lazy start)
            startWhisperTimer(userId, session.skills);

            // Voice wake word detection: "hi angel", "hey angel", "yo angel", "ok angel"
            if (label === 'Owner') {
              const lower = data.text.toLowerCase().trim();
              const wakePatterns = /\b(hi|hey|yo|ok|okay)\s+angel\b/;
              if (wakePatterns.test(lower) && !angelProcessing) {
                console.log(`[agent] Wake word detected: "${data.text}"`);
                angelProcessing = true;
                socket.emit('angel:thinking', { active: true });

                // Small delay to let the owner finish their sentence
                setTimeout(async () => {
                  try {
                    const recentTranscript = transcriptBuffer.slice(-15).join('\n');
                    await generateAndEmitWhisper(userId, recentTranscript, session.skills, true);
                  } catch (err) {
                    console.error('[agent] Wake word response error:', err);
                  } finally {
                    angelProcessing = false;
                    socket.emit('angel:thinking', { active: false });
                  }
                }, 2000); // 2s delay to capture the full sentence after the wake word
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
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to connect to transcription service';
        console.error('Deepgram connection failed:', message);
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

    // Angel manual activation — button press triggers immediate whisper from last ~100 words
    socket.on('angel:activate', async () => {
      if (!currentSessionId || !socket.userId || angelProcessing) return;
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
        // Take last ~100 words (roughly last 10-15 transcript lines)
        const recentLines = transcriptBuffer.slice(-15);
        const recentTranscript = recentLines.join('\n');

        await generateAndEmitWhisper(
          socket.userId,
          recentTranscript,
          sessionSkillsCache,
          true // isActivation — always respond even if nothing major
        );
      } catch (err) {
        console.error('[angel:activate] Error:', err);
        socket.emit('whisper', {
          id: uuid(),
          type: 'warning',
          content: 'Something went wrong. Try again in a moment.',
          createdAt: new Date().toISOString(),
        });
      } finally {
        angelProcessing = false;
        socket.emit('angel:thinking', { active: false });
      }
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      // Clean up timers and Deepgram
      clearAllTimers();

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
      recentWhisperContents = [];
      currentSessionId = null;
      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      cleanupSession();
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
