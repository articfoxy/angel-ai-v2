import { Router, Response } from 'express';
import { prisma } from '../index';
import { AuthRequest } from '../middleware/auth';

export const memoryRouter = Router();

// Get core memory
memoryRouter.get('/core', async (req: AuthRequest, res: Response) => {
  try {
    let core = await prisma.coreMemory.findUnique({ where: { userId: req.userId } });
    if (!core) {
      core = await prisma.coreMemory.create({ data: { userId: req.userId! } });
    }
    res.json({ success: true, data: core });
  } catch {
    res.status(500).json({ error: 'Failed to fetch core memory' });
  }
});

// Update core memory
memoryRouter.patch('/core', async (req: AuthRequest, res: Response) => {
  try {
    const { userProfile, preferences, keyPeople, activeGoals } = req.body;
    const data: Record<string, string> = {};
    if (userProfile !== undefined) data.userProfile = userProfile;
    if (preferences !== undefined) data.preferences = preferences;
    if (keyPeople !== undefined) data.keyPeople = keyPeople;
    if (activeGoals !== undefined) data.activeGoals = activeGoals;

    const core = await prisma.coreMemory.upsert({
      where: { userId: req.userId! },
      update: data,
      create: { userId: req.userId!, ...data },
    });

    res.json({ success: true, data: core });
  } catch {
    res.status(500).json({ error: 'Failed to update core memory' });
  }
});

// List entities
memoryRouter.get('/entities', async (req: AuthRequest, res: Response) => {
  try {
    const type = req.query.type as string | undefined;
    const entities = await prisma.entity.findMany({
      where: { userId: req.userId, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: entities });
  } catch {
    res.status(500).json({ error: 'Failed to fetch entities' });
  }
});

// List memories (extracted facts)
memoryRouter.get('/memories', async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const memories = await prisma.memory.findMany({
      where: { userId: req.userId, validTo: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ success: true, data: memories });
  } catch {
    res.status(500).json({ error: 'Failed to fetch memories' });
  }
});

// Delete a memory (soft-delete by setting validTo)
memoryRouter.delete('/memories/:id', async (req: AuthRequest, res: Response) => {
  try {
    const memId = req.params.id as string;
    const mem = await prisma.memory.findFirst({
      where: { id: memId, userId: req.userId },
    });
    if (!mem) return res.status(404).json({ error: 'Memory not found' });

    await prisma.memory.update({
      where: { id: memId },
      data: { validTo: new Date() },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete memory' });
  }
});

// List reflections
memoryRouter.get('/reflections', async (req: AuthRequest, res: Response) => {
  try {
    const reflections = await prisma.reflection.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({ success: true, data: reflections });
  } catch {
    res.status(500).json({ error: 'Failed to fetch reflections' });
  }
});
