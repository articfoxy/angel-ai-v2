import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { ExtractionService } from './memory/extraction.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

export function setupSocketHandlers(io: Server) {
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

    socket.on('session:start', async ({ sessionId }: { sessionId: string }) => {
      if (!socket.userId) return;

      // Verify session belongs to user
      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      // Initialize Deepgram with diarization
      deepgram = new DeepgramService({
        onTranscript: (data) => {
          socket.emit('transcript', data);
        },
        onSpeakerIdentified: (speakerId, label) => {
          socket.emit('speaker:identified', { speakerId, label });
        },
        sessionId,
        userId: socket.userId,
      });

      await deepgram.connect();
      console.log(`Session started: ${sessionId}`);
    });

    socket.on('audio', (audioData: Buffer) => {
      if (deepgram) {
        deepgram.sendAudio(audioData);
      }
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      if (deepgram) {
        deepgram.close();
        deepgram = null;
      }

      if (socket.userId) {
        // End session
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), status: 'processing' },
        });

        // Trigger post-session extraction
        const extraction = new ExtractionService();
        extraction.processSession(sessionId, socket.userId).then(async (summary) => {
          await prisma.session.update({
            where: { id: sessionId },
            data: { status: 'ended', summary },
          });
          socket.emit('session:debrief', { sessionId, summary });
        }).catch((err) => {
          console.error('Post-session extraction error:', err);
        });
      }

      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', () => {
      if (deepgram) {
        deepgram.close();
        deepgram = null;
      }
      console.log(`Client disconnected: ${socket.userId}`);
    });
  });
}
