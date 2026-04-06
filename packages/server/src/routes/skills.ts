import { Router, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../index';
import { AuthRequest } from '../middleware/auth';

export const skillsRouter = Router();

// My skills
skillsRouter.get('/mine', async (req: AuthRequest, res: Response) => {
  try {
    const skills = await prisma.skill.findMany({
      where: { userId: req.userId as string },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: skills });
  } catch {
    res.status(500).json({ error: 'Failed to fetch skills' });
  }
});

// Public skills (marketplace)
skillsRouter.get('/public', async (_req: AuthRequest, res: Response) => {
  try {
    const skills = await prisma.skill.findMany({
      where: { visibility: 'public' },
      orderBy: { downloads: 'desc' },
      take: 50,
    });
    res.json({ success: true, data: skills });
  } catch {
    res.status(500).json({ error: 'Failed to fetch public skills' });
  }
});

// Get single skill (public access for sharing)
skillsRouter.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const skill = await prisma.skill.findUnique({ where: { id: req.params.id as string } });
    if (!skill) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    if (skill.visibility !== 'public' && skill.userId !== req.userId) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    res.json({ success: true, data: skill });
  } catch {
    res.status(500).json({ error: 'Failed to fetch skill' });
  }
});

// Create skill
skillsRouter.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, trigger, systemPrompt, description, outputSchema, visibility } = req.body;

    if (!name && !description) {
      res.status(400).json({ error: 'Name or description required' });
      return;
    }

    const skill = await prisma.skill.create({
      data: {
        userId: req.userId!,
        name: name || 'Custom Skill',
        trigger: trigger || null,
        systemPrompt: systemPrompt || description || '',
        outputSchema: outputSchema ? (outputSchema as Prisma.InputJsonValue) : Prisma.JsonNull,
        visibility: visibility || 'private',
      },
    });

    res.json({ success: true, data: skill });
  } catch {
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

// Import skill (copy from another user)
skillsRouter.post('/:id/import', async (req: AuthRequest, res: Response) => {
  try {
    const source = await prisma.skill.findUnique({ where: { id: req.params.id as string } });
    if (!source || source.visibility !== 'public') {
      res.status(404).json({ error: 'Skill not found or not public' });
      return;
    }

    const imported = await prisma.skill.create({
      data: {
        userId: req.userId!,
        name: source.name,
        trigger: source.trigger,
        systemPrompt: source.systemPrompt,
        outputSchema: source.outputSchema ? (source.outputSchema as Prisma.InputJsonValue) : Prisma.JsonNull,
        visibility: 'private',
      },
    });

    await prisma.skill.update({
      where: { id: source.id },
      data: { downloads: { increment: 1 } },
    });

    res.json({ success: true, data: imported });
  } catch {
    res.status(500).json({ error: 'Failed to import skill' });
  }
});

// Delete skill
skillsRouter.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.skill.deleteMany({
      where: { id: req.params.id as string, userId: req.userId as string },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});
