import { Router, Response } from 'express';
import { prisma } from '../index';
import { AuthRequest } from '../middleware/auth';

export const sessionsRouter = Router();

// List sessions
sessionsRouter.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const sessions = await prisma.session.findMany({
      where: { userId: req.userId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    const total = await prisma.session.count({ where: { userId: req.userId } });
    res.json({ success: true, data: { sessions, total } });
  } catch {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Get single session
sessionsRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.session.findFirst({
      where: { id: String(req.params.id), userId: String(req.userId) },
      include: { episodes: { orderBy: { startTime: 'asc' } } },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.json({ success: true, data: session });
  } catch {
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// Create session
sessionsRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    // Auto-close stale sessions: any session older than 3 hours with no endedAt
    // is a zombie from a crash/force-quit — mark it ended so it doesn't block new ones.
    await prisma.session.updateMany({
      where: {
        userId: req.userId!,
        endedAt: null,
        status: { notIn: ['ended', 'processing'] },
        startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
      data: { endedAt: new Date(), status: 'ended', summary: 'Session ended (stale cleanup)' },
    });

    // Enforce concurrent session limit — prevent resource abuse
    const activeSessions = await prisma.session.count({
      where: {
        userId: req.userId!,
        endedAt: null,
        status: { notIn: ['ended', 'processing'] },
      },
    });
    if (activeSessions >= 3) {
      res.status(429).json({ error: 'Too many active sessions. Please end an existing session first.' });
      return;
    }

    const session = await prisma.session.create({
      data: {
        userId: req.userId!,
        skills: req.body.skills || [],
      },
    });

    res.json({ success: true, data: session });
  } catch {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Delete session
sessionsRouter.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.session.findFirst({
      where: { id: String(req.params.id), userId: String(req.userId) },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Delete related episodes first, then the session
    await prisma.episode.deleteMany({ where: { sessionId: session.id } });
    await prisma.session.delete({ where: { id: session.id } });

    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Force-close all stale sessions (zombie cleanup)
sessionsRouter.post('/cleanup', async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.session.updateMany({
      where: {
        userId: req.userId!,
        endedAt: null,
        status: { notIn: ['ended', 'processing'] },
      },
      data: { endedAt: new Date(), status: 'ended', summary: 'Session ended (manual cleanup)' },
    });

    res.json({ success: true, cleaned: result.count });
  } catch {
    res.status(500).json({ error: 'Failed to clean up sessions' });
  }
});

// End session
sessionsRouter.patch('/:id/end', async (req: AuthRequest, res: Response) => {
  try {
    // Verify the session belongs to the authenticated user
    const existing = await prisma.session.findFirst({
      where: { id: String(req.params.id), userId: String(req.userId) },
    });
    if (!existing) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const session = await prisma.session.update({
      where: { id: existing.id },
      data: {
        endedAt: new Date(),
        status: 'ended',
        summary: req.body.summary ?? undefined,
        speakers: req.body.speakers ?? undefined,
      },
    });

    res.json({ success: true, data: session });
  } catch {
    res.status(500).json({ error: 'Failed to end session' });
  }
});
