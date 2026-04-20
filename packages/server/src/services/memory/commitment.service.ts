/**
 * CommitmentService — promises you made, promises made to you.
 *
 * Extracted by the Judge from transcripts. Phase B surfaces them in briefs,
 * Phase C uses them for contradiction detection, heartbeat fires reminders.
 */
import { prisma } from '../../index';
import { logMemoryOp } from './audit';

export interface CommitmentInput {
  userId: string;
  fromName: string;             // "user" | "Alice"
  fromEntityId?: string | null;
  toName: string;               // "Alice" | "user"
  toEntityId?: string | null;
  description: string;
  dueDate?: Date | null;
  importance?: number;
  confidence?: number;
  sourceEpisodeIds?: string[];
  sourceObservationIds?: string[];
  tags?: string[];
}

export interface CommitmentRecord {
  id: string;
  fromName: string;
  toName: string;
  description: string;
  dueDate: Date | null;
  status: string;
  importance: number;
  confidence: number;
  createdAt: Date;
  completedAt: Date | null;
  contradictsIds: string[];
}

export class CommitmentService {
  async create(input: CommitmentInput): Promise<string | null> {
    try {
      const row = await prisma.commitment.create({
        data: {
          userId: input.userId,
          fromName: input.fromName.slice(0, 200),
          fromEntityId: input.fromEntityId ?? null,
          toName: input.toName.slice(0, 200),
          toEntityId: input.toEntityId ?? null,
          description: input.description.slice(0, 1000),
          dueDate: input.dueDate ?? null,
          importance: Math.max(0, Math.min(10, Math.round(input.importance ?? 5))),
          confidence: Math.max(0, Math.min(1, input.confidence ?? 0.7)),
          sourceEpisodeIds: input.sourceEpisodeIds ?? [],
          sourceObservationIds: input.sourceObservationIds ?? [],
          tags: input.tags ?? [],
        },
      });
      logMemoryOp({
        userId: input.userId,
        actorType: 'llm_judge',
        operation: 'create',
        memoryType: 'fact', // no 'commitment' type yet — reuse fact
        memoryId: row.id,
        after: { fromName: input.fromName, toName: input.toName, description: input.description, dueDate: input.dueDate },
      }).catch(() => {});
      return row.id;
    } catch (err: any) {
      console.warn('[commitment] create failed:', err?.message);
      return null;
    }
  }

  /** Mark a commitment complete. Triggered by user or by judge-detected completion. */
  async complete(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.commitment.findFirst({ where: { id, userId } });
    if (!existing) return false;
    await prisma.commitment.update({
      where: { id },
      data: { status: 'completed', completedAt: new Date() },
    });
    return true;
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    const existing = await prisma.commitment.findFirst({ where: { id, userId } });
    if (!existing) return false;
    await prisma.commitment.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    return true;
  }

  /** Find commitments that might contradict a candidate commitment. */
  async findContradicting(userId: string, candidate: CommitmentInput): Promise<CommitmentRecord[]> {
    // Same from+to pair, overlapping time window, similar description
    const rows = await prisma.commitment.findMany({
      where: {
        userId,
        status: 'open',
        fromName: candidate.fromName,
        toName: candidate.toName,
        // Within ±3 days of the candidate's due date if set
        ...(candidate.dueDate
          ? {
              dueDate: {
                gte: new Date(candidate.dueDate.getTime() - 3 * 24 * 3_600_000),
                lte: new Date(candidate.dueDate.getTime() + 3 * 24 * 3_600_000),
              },
            }
          : {}),
      },
      take: 10,
    });
    return rows.map(toRecord);
  }

  /** Open commitments due in the given window. */
  async dueWithin(userId: string, fromDate: Date, toDate: Date): Promise<CommitmentRecord[]> {
    const rows = await prisma.commitment.findMany({
      where: {
        userId,
        status: 'open',
        dueDate: { gte: fromDate, lte: toDate },
      },
      orderBy: { dueDate: 'asc' },
    });
    return rows.map(toRecord);
  }

  async list(userId: string, opts: { status?: string; limit?: number } = {}): Promise<CommitmentRecord[]> {
    const rows = await prisma.commitment.findMany({
      where: { userId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: opts.limit ?? 50,
    });
    return rows.map(toRecord);
  }

  async markContradiction(id: string, contradictsIds: string[]): Promise<void> {
    await prisma.commitment.update({
      where: { id },
      data: { contradictsIds },
    }).catch(() => {});
  }
}

function toRecord(r: any): CommitmentRecord {
  return {
    id: r.id,
    fromName: r.fromName,
    toName: r.toName,
    description: r.description,
    dueDate: r.dueDate,
    status: r.status,
    importance: r.importance,
    confidence: r.confidence,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    contradictsIds: r.contradictsIds ?? [],
  };
}

export const commitmentService = new CommitmentService();
