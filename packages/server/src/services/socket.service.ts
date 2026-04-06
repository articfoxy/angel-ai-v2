import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { InferenceService } from './inference.service';
import { ExtractionService } from './memory/extraction.service';
import { runPostSessionReflection } from './memory/reflection.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const WHISPER_INTERVAL_MS = 15000; // Generate whisper every 15s
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

    function startWhisperTimer(userId: string, sessionSkills: string[]) {
      if (whisperTimer) return; // Already running
      whisperTimer = setInterval(async () => {
        if (transcriptBuffer.length < 3) return; // Need some transcript first

        const recentTranscript = transcriptBuffer.slice(-20).join('\n');
        try {
          const whisper = await inference.generateWhisper(
            userId,
            recentTranscript,
            byokConfig, // Use BYOK keys if provided, else server defaults
            sessionSkills
          );

          if (whisper) {
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
        } catch (err) {
          console.error('Whisper generation error:', err);
        }
      }, WHISPER_INTERVAL_MS);
    }

    function cleanupSession() {
      clearAllTimers();
      if (deepgram) {
        deepgram.close();
        deepgram = null;
      }
      transcriptBuffer = [];
      currentSessionId = null;
    }

    socket.on('session:start', async (payload: {
      sessionId: string;
      byok?: { provider: string; apiKey: string; model?: string };
    }) => {
      const { sessionId } = payload;
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

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
          }
        },
        onSpeakerIdentified: (speakerId, label) => {
          socket.emit('speaker:identified', { speakerId, label });
        },
        onError: (errorMsg) => {
          socket.emit('session:error', { sessionId, message: errorMsg });
        },
        sessionId,
        userId,
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

    socket.on('audio', (audioData: string | Buffer) => {
      if (deepgram) {
        // Mobile sends base64-encoded raw PCM; decode to Buffer for Deepgram
        const buffer = typeof audioData === 'string'
          ? Buffer.from(audioData, 'base64')
          : audioData;
        deepgram.sendAudio(buffer);
      }
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      // Clean up timers and Deepgram
      clearAllTimers();

      // Grab speakers before closing Deepgram
      const speakers = deepgram ? deepgram.getSpeakers() : {};

      if (deepgram) {
        deepgram.close();
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
      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      cleanupSession();
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
