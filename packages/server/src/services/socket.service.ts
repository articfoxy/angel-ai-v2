import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { InferenceService } from './inference.service';
import { ExtractionService } from './memory/extraction.service';
import { ReflectionService } from './memory/reflection.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const WHISPER_INTERVAL_MS = 15000; // Generate whisper every 15s

interface AuthenticatedSocket extends Socket {
  userId?: string;
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

    socket.on('session:start', async ({ sessionId }: { sessionId: string }) => {
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      transcriptBuffer = [];

      // Initialize Deepgram with diarization
      deepgram = new DeepgramService({
        onTranscript: (data) => {
          socket.emit('transcript', data);
          // Buffer transcript for whisper generation
          if (data.isFinal && data.text.trim()) {
            const label = data.speakerLabel || data.speaker || 'Unknown';
            transcriptBuffer.push(`[${label}]: ${data.text}`);
            // Keep rolling 3-min window (~180s of speech)
            if (transcriptBuffer.length > 60) {
              transcriptBuffer = transcriptBuffer.slice(-40);
            }
          }
        },
        onSpeakerIdentified: (speakerId, label) => {
          socket.emit('speaker:identified', { speakerId, label });
        },
        sessionId,
        userId: socket.userId,
      });

      await deepgram.connect();

      // Start whisper generation timer
      const userId = socket.userId;
      whisperTimer = setInterval(async () => {
        if (transcriptBuffer.length < 3) return; // Need some transcript first

        const recentTranscript = transcriptBuffer.slice(-20).join('\n');
        try {
          const whisper = await inference.generateWhisper(
            userId,
            recentTranscript,
            undefined, // Use server default keys
            session.skills
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

      console.log(`Session started: ${sessionId}`);
    });

    socket.on('audio', (audioData: Buffer) => {
      if (deepgram) {
        deepgram.sendAudio(audioData);
      }
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      // Clean up
      if (whisperTimer) {
        clearInterval(whisperTimer);
        whisperTimer = null;
      }
      if (deepgram) {
        deepgram.close();
        deepgram = null;
      }

      if (socket.userId) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), status: 'processing' },
        });

        // Post-session: extract memories, entities, reflections
        const userId = socket.userId;
        const extraction = new ExtractionService();
        extraction.processSession(sessionId, userId).then(async (summary) => {
          await prisma.session.update({
            where: { id: sessionId },
            data: { status: 'ended', summary },
          });
          socket.emit('session:debrief', { sessionId, summary });

          // Check if reflection is needed
          const reflection = new ReflectionService();
          reflection.maybeReflect(userId).catch((err) => {
            console.error('Reflection error:', err);
          });
        }).catch((err) => {
          console.error('Post-session extraction error:', err);
        });
      }

      transcriptBuffer = [];
      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      if (whisperTimer) {
        clearInterval(whisperTimer);
        whisperTimer = null;
      }
      if (deepgram) {
        deepgram.close();
        deepgram = null;
      }
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
