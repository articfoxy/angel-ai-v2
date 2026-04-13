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
    // Auto-close ALL stale sessions: active >2hr or processing >30min
    await prisma.session.updateMany({
      where: {
        userId: req.userId!,
        status: 'active',
        startedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      },
      data: { endedAt: new Date(), status: 'ended', summary: { note: 'Stale cleanup' } },
    });
    await prisma.session.updateMany({
      where: {
        userId: req.userId!,
        status: 'processing',
        startedAt: { lt: new Date(Date.now() - 30 * 60 * 1000) },
      },
      data: { endedAt: new Date(), status: 'ended', summary: { note: 'Processing timeout' } },
    });

    // End ALL existing active sessions for this user before creating a new one.
    // Only one session should be active at a time.
    await prisma.session.updateMany({
      where: {
        userId: req.userId!,
        status: { in: ['active'] },
      },
      data: { endedAt: new Date(), status: 'ended' },
    });

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
