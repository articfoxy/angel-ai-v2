/**
 * Memory audit logger (PRD §19.5 — explainability mandatory).
 * Writes every create/update/supersede/delete/access to MemoryAuditLog
 * and retrieval events to RetrievalAudit. Fire-and-forget — never block
 * a user-visible operation to write audit.
 */
import { prisma } from '../../index';

type ActorType = 'user' | 'system' | 'llm_judge' | 'reflection_job' | 'retention_job';
type MemoryType = 'fact' | 'episode' | 'reflection' | 'procedure' | 'core_block' | 'observation';
type Operation = 'create' | 'update' | 'supersede' | 'delete' | 'access' | 'forget';

export async function logMemoryOp(params: {
  userId: string;
  actorType: ActorType;
  actorId?: string | null;
  operation: Operation;
  memoryType: MemoryType;
  memoryId: string;
  before?: any;
  after?: any;
  reason?: string;
}): Promise<void> {
  try {
    await prisma.memoryAuditLog.create({
      data: {
        userId: params.userId,
        actorType: params.actorType,
        actorId: params.actorId ?? null,
        operation: params.operation,
        memoryType: params.memoryType,
        memoryId: params.memoryId,
        before: params.before ?? undefined,
        after: params.after ?? undefined,
        reason: params.reason ?? null,
      },
    });
  } catch (err) {
    console.warn('[audit] memory op log failed:', (err as any)?.message);
  }
}

export async function logRetrieval(params: {
  userId: string;
  responseId?: string | null;
  queryText: string;
  usedMemoryIds: {
    facts?: string[];
    episodes?: string[];
    reflections?: string[];
    procedures?: string[];
  };
  reasonCodes: string[];
  latencyMs: number;
}): Promise<void> {
  try {
    await prisma.retrievalAudit.create({
      data: {
        userId: params.userId,
        responseId: params.responseId ?? null,
        queryText: params.queryText.slice(0, 1000),
        usedMemoryIds: params.usedMemoryIds,
        reasonCodes: params.reasonCodes,
        latencyMs: params.latencyMs,
      },
    });
  } catch (err) {
    console.warn('[audit] retrieval log failed:', (err as any)?.message);
  }
}
