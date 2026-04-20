/**
 * GoalService — user-declared aims. Progress is *observed*, not enforced.
 *
 * The PatternMiner touches these weekly to update progress + mentionCount.
 * The DigestComposer reads them for the weekly reveal.
 */
import { prisma } from '../../index';

export interface GoalInput {
  userId: string;
  title: string;
  description?: string;
  targetDate?: Date;
  importance?: number;
  keyMetrics?: Record<string, unknown>;
  sourceEpisodeIds?: string[];
}

export class GoalService {
  async create(input: GoalInput): Promise<string> {
    const row = await prisma.goal.create({
      data: {
        userId: input.userId,
        title: input.title.slice(0, 300),
        description: input.description?.slice(0, 1000),
        targetDate: input.targetDate,
        importance: Math.max(0, Math.min(10, Math.round(input.importance ?? 6))),
        keyMetrics: input.keyMetrics as any,
        sourceEpisodeIds: input.sourceEpisodeIds ?? [],
      },
    });
    return row.id;
  }

  async list(userId: string, status?: string) {
    return prisma.goal.findMany({
      where: { userId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'asc' }, { lastMentionedAt: 'desc' }],
    });
  }

  async setStatus(userId: string, id: string, status: 'active' | 'achieved' | 'dormant' | 'abandoned'): Promise<boolean> {
    const existing = await prisma.goal.findFirst({ where: { id, userId } });
    if (!existing) return false;
    await prisma.goal.update({ where: { id }, data: { status } });
    return true;
  }

  /** Called by the PatternMiner — touches when an episode mentions the goal. */
  async recordMention(userId: string, goalId: string, episodeId: string): Promise<void> {
    const existing = await prisma.goal.findFirst({ where: { id: goalId, userId } });
    if (!existing) return;
    const episodeIds = existing.sourceEpisodeIds.includes(episodeId)
      ? existing.sourceEpisodeIds
      : [...existing.sourceEpisodeIds, episodeId].slice(-50);
    await prisma.goal.update({
      where: { id: goalId },
      data: {
        mentionCount: { increment: 1 },
        lastMentionedAt: new Date(),
        sourceEpisodeIds: episodeIds,
      },
    });
  }

  /** Update progress (0-1) — PatternMiner derives this weekly. */
  async updateProgress(userId: string, goalId: string, progress: number): Promise<void> {
    await prisma.goal.update({
      where: { id: goalId },
      data: { progress: Math.max(0, Math.min(1, progress)) },
    }).catch(() => {});
  }
}

export const goalService = new GoalService();
