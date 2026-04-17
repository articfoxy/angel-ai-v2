/**
 * ProcedureService (Layer F) — learned operating rules.
 *
 * Procedures are "from now on..." style behavior policies that fire when their
 * trigger matches the current context. Unlike facts (about the world),
 * procedures are about how Angel should ACT.
 *
 * Examples:
 *   trigger_signature: "meeting ends"
 *   policy_text: "Summarize in max 3 bullets, lead with decisions, no filler."
 *
 *   trigger_signature: "user asks to build X"
 *   policy_text: "Confirm project + stack before dispatching to Claude Code."
 *
 * Candidates are proposed by the judge. Promotion to `active` happens after
 * repeated success or explicit user approval.
 */
import { prisma } from '../../index';
import { logMemoryOp } from './audit';

export interface ProcedureRecord {
  id: string;
  triggerSignature: string;
  policyText: string;
  category: string;
  examples: any;
  confidence: number;
  status: string;
  successCount: number;
  failureCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export class ProcedureService {
  /** Active procedures whose triggers match the given context keywords. */
  async matchActive(userId: string, contextKeywords: string[]): Promise<ProcedureRecord[]> {
    if (contextKeywords.length === 0) return [];
    const lowered = contextKeywords.map((k) => k.toLowerCase());
    const rows = await prisma.procedure.findMany({
      where: { userId, status: 'active' },
      orderBy: { confidence: 'desc' },
      take: 20,
    });
    // Simple keyword-overlap match. LLM evaluates in judge/retrieval paths.
    return rows.filter((r) => {
      const sig = r.triggerSignature.toLowerCase();
      return lowered.some((k) => sig.includes(k));
    }).map(rowToRecord);
  }

  async list(userId: string, statusFilter?: string): Promise<ProcedureRecord[]> {
    const rows = await prisma.procedure.findMany({
      where: { userId, ...(statusFilter ? { status: statusFilter } : {}) },
      orderBy: [{ status: 'asc' }, { confidence: 'desc' }],
    });
    return rows.map(rowToRecord);
  }

  async approve(userId: string, procedureId: string): Promise<boolean> {
    const existing = await prisma.procedure.findFirst({ where: { id: procedureId, userId } });
    if (!existing) return false;
    await prisma.procedure.update({
      where: { id: procedureId },
      data: { status: 'active', confidence: Math.max(existing.confidence, 0.8) },
    });
    logMemoryOp({
      userId, actorType: 'user', operation: 'update', memoryType: 'procedure', memoryId: procedureId,
      before: { status: existing.status }, after: { status: 'active' },
      reason: 'user approved',
    }).catch(() => {});
    return true;
  }

  async deprecate(userId: string, procedureId: string): Promise<boolean> {
    const existing = await prisma.procedure.findFirst({ where: { id: procedureId, userId } });
    if (!existing) return false;
    await prisma.procedure.update({
      where: { id: procedureId },
      data: { status: 'deprecated' },
    });
    logMemoryOp({
      userId, actorType: 'user', operation: 'delete', memoryType: 'procedure', memoryId: procedureId,
      before: { status: existing.status }, after: { status: 'deprecated' },
    }).catch(() => {});
    return true;
  }

  /** Bump success counter and confidence. Called after a procedure fires correctly. */
  async recordSuccess(procedureId: string): Promise<void> {
    await prisma.procedure.update({
      where: { id: procedureId },
      data: {
        successCount: { increment: 1 },
        lastUsedAt: new Date(),
        confidence: { increment: 0.02 },
      },
    }).catch(() => {});
  }

  async recordFailure(procedureId: string): Promise<void> {
    await prisma.procedure.update({
      where: { id: procedureId },
      data: {
        failureCount: { increment: 1 },
        confidence: { decrement: 0.05 },
      },
    }).catch(() => {});
  }

  /** Render active procedures for system-prompt injection. */
  async renderForPrompt(userId: string, contextKeywords: string[] = []): Promise<string> {
    const matches = contextKeywords.length > 0
      ? await this.matchActive(userId, contextKeywords)
      : (await prisma.procedure.findMany({
          where: { userId, status: 'active' },
          orderBy: { confidence: 'desc' },
          take: 5,
        })).map(rowToRecord);
    if (matches.length === 0) return '';
    const lines = matches.slice(0, 5).map((p) => `- [${p.triggerSignature}] ${p.policyText}`);
    return `<procedures>\n${lines.join('\n')}\n</procedures>`;
  }
}

function rowToRecord(r: any): ProcedureRecord {
  return {
    id: r.id,
    triggerSignature: r.triggerSignature,
    policyText: r.policyText,
    category: r.category,
    examples: r.examples,
    confidence: r.confidence,
    status: r.status,
    successCount: r.successCount,
    failureCount: r.failureCount,
    lastUsedAt: r.lastUsedAt,
    createdAt: r.createdAt,
  };
}
