/**
 * FactsService (Layer E) — bi-temporal semantic facts.
 *
 * Ops (Mem0 pattern + Zep bi-temporal):
 *   ADD       — insert new fact with status='candidate'
 *   UPDATE    — refresh value/confidence on existing (same fact_id)
 *   SUPERSEDE — close old (set valid_to + status='superseded' + superseded_by)
 *                then insert new with reference back
 *   NOOP      — LLM judged duplicate / not worth storing
 *
 * Promotion (PRD §12.5):
 *   - explicit_remember OR ≥2 independent observations → candidate → active
 *   - single weak signal → stays 'candidate'
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import { logMemoryOp } from './audit';
import { canPromoteFact, type PrivacyMode, type PrivacyClass, classifyContent } from './policy';

export type FactOp = 'ADD' | 'UPDATE' | 'SUPERSEDE' | 'NOOP';

export interface FactInput {
  userId: string;
  namespace?: string;
  subjectType: 'user' | 'person' | 'org' | 'topic' | 'system';
  subjectId?: string | null;
  subjectName: string;
  predicate: string;
  objectType: 'string' | 'number' | 'boolean' | 'date' | 'entity' | 'json';
  objectValue: any;
  content: string; // natural-language rendering
  confidence?: number;
  importance?: number;
  sourceEpisodeIds?: string[];
  sourceObservationIds?: string[];
  expiresAt?: Date | null;
  privacyClass?: PrivacyClass;
  tags?: string[];
}

export interface FactRecord {
  id: string;
  content: string;
  predicate: string;
  subjectName: string;
  objectValue: any;
  confidence: number;
  importance: number;
  status: string;
  validFrom: Date;
  validTo: Date | null;
  freshnessAt: Date;
  supersededBy: string | null;
  sourceEpisodeIds: string[];
  sourceObservationIds: string[];
  tags: string[];
  distance?: number;
}

export class FactsService {
  private embeddings: EmbeddingService;

  constructor(apiKey?: string) {
    this.embeddings = new EmbeddingService(apiKey);
  }

  /**
   * Find top-K semantically-similar active facts (for judge context).
   * Only returns facts with `valid_to IS NULL` and status in (active, candidate).
   */
  async findSimilar(userId: string, query: string, k = 5): Promise<FactRecord[]> {
    const vec = await this.embeddings.embed(query);
    if (!vec) {
      // Fallback: recent facts
      const rows = await prisma.fact.findMany({
        where: { userId, validTo: null, status: { in: ['active', 'candidate'] } },
        orderBy: { freshnessAt: 'desc' },
        take: k,
      });
      return rows.map(rowToRecord);
    }
    const vectorStr = this.embeddings.toSqlVector(vec);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, content, predicate, "subjectName", "objectValue", confidence, importance, status,
              "validFrom", "validTo", "freshnessAt", "supersededBy",
              "sourceEpisodeIds", "sourceObservationIds", tags,
              embedding <=> $1::vector AS distance
       FROM "Fact"
       WHERE "userId" = $2 AND "validTo" IS NULL AND status IN ('active','candidate') AND embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      vectorStr, userId, k,
    );
    return rows.map(rowToRecord);
  }

  /** ADD a new fact. Returns fact id, or null if blocked by policy. */
  async add(input: FactInput, privacyMode: PrivacyMode = 'standard', actor: 'llm_judge' | 'user' = 'llm_judge'): Promise<string | null> {
    const privacyClass = input.privacyClass ?? classifyContent(input.content);
    if (!canPromoteFact(privacyMode, privacyClass)) return null;

    const id = randomUUID();
    const vec = await this.embeddings.embed(input.content);
    const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;

    const confidence = clamp01(input.confidence ?? 0.6);
    const importance = Math.max(0, Math.min(10, Math.round(input.importance ?? 5)));
    const status = actor === 'user' ? 'active' : 'candidate'; // user-entered = trusted

    try {
      if (vectorStr) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Fact"
            (id, "userId", namespace, "subjectType", "subjectId", "subjectName", predicate,
             "objectType", "objectValue", content, confidence, importance, status,
             "validFrom", "validTo", "freshnessAt", "expiresAt", "supersededBy",
             "sourceEpisodeIds", "sourceObservationIds", "accessCount",
             "privacyClass", embedding, tags, "linkedFactIds",
             "extractorVersion", "schemaVersion", "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,NOW(),NULL,NOW(),$14,NULL,
                   $15::text[],$16::text[],0,$17,$18::vector,$19::text[],$20::text[],
                   'judge-v1',1,NOW(),NOW())`,
          id, input.userId, input.namespace ?? 'general',
          input.subjectType, input.subjectId ?? null, input.subjectName, input.predicate,
          input.objectType, JSON.stringify(input.objectValue), input.content.slice(0, 2000),
          confidence, importance, status,
          input.expiresAt ?? null,
          input.sourceEpisodeIds ?? [], input.sourceObservationIds ?? [],
          privacyClass, vectorStr, input.tags ?? [], [],
        );
      } else {
        await prisma.fact.create({
          data: {
            id,
            userId: input.userId,
            namespace: input.namespace ?? 'general',
            subjectType: input.subjectType,
            subjectId: input.subjectId ?? null,
            subjectName: input.subjectName,
            predicate: input.predicate,
            objectType: input.objectType,
            objectValue: input.objectValue,
            content: input.content.slice(0, 2000),
            confidence,
            importance,
            status,
            expiresAt: input.expiresAt ?? null,
            sourceEpisodeIds: input.sourceEpisodeIds ?? [],
            sourceObservationIds: input.sourceObservationIds ?? [],
            privacyClass,
            tags: input.tags ?? [],
          },
        });
      }
      logMemoryOp({
        userId: input.userId,
        actorType: actor,
        operation: 'create',
        memoryType: 'fact',
        memoryId: id,
        after: { content: input.content, predicate: input.predicate, status },
        reason: `ADD by ${actor}`,
      }).catch(() => {});
      return id;
    } catch (err) {
      console.error('[facts] add failed:', (err as any)?.message);
      return null;
    }
  }

  /** UPDATE an existing fact. Refreshes embedding, bumps freshnessAt. */
  async update(
    userId: string,
    factId: string,
    patch: Partial<Pick<FactInput, 'content' | 'objectValue' | 'confidence' | 'importance' | 'tags' | 'sourceEpisodeIds' | 'sourceObservationIds'>>,
    actor: 'llm_judge' | 'user' = 'llm_judge',
  ): Promise<boolean> {
    const existing = await prisma.fact.findFirst({ where: { id: factId, userId } });
    if (!existing) return false;

    const content = patch.content ?? existing.content;
    const vec = patch.content ? await this.embeddings.embed(content) : null;
    const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;

    const newConfidence = patch.confidence != null ? clamp01(patch.confidence) : Math.min(0.99, existing.confidence + 0.1);
    const newImportance = patch.importance != null ? patch.importance : existing.importance;
    const newStatus = existing.status === 'candidate' && newConfidence >= 0.75 ? 'active' : existing.status;

    const newEpisodeIds = mergeUnique(existing.sourceEpisodeIds, patch.sourceEpisodeIds ?? []);
    const newObsIds = mergeUnique(existing.sourceObservationIds, patch.sourceObservationIds ?? []);
    const newTags = mergeUnique(existing.tags, patch.tags ?? []);

    try {
      if (vectorStr) {
        await prisma.$executeRawUnsafe(
          `UPDATE "Fact" SET
             content = $1, "objectValue" = $2::jsonb,
             confidence = $3, importance = $4, status = $5,
             "sourceEpisodeIds" = $6::text[], "sourceObservationIds" = $7::text[], tags = $8::text[],
             embedding = $9::vector, "freshnessAt" = NOW(), "updatedAt" = NOW()
           WHERE id = $10`,
          content.slice(0, 2000),
          JSON.stringify(patch.objectValue ?? existing.objectValue),
          newConfidence, newImportance, newStatus,
          newEpisodeIds, newObsIds, newTags, vectorStr, factId,
        );
      } else {
        await prisma.fact.update({
          where: { id: factId },
          data: {
            content: content.slice(0, 2000),
            objectValue: patch.objectValue ?? existing.objectValue as any,
            confidence: newConfidence,
            importance: newImportance,
            status: newStatus,
            sourceEpisodeIds: newEpisodeIds,
            sourceObservationIds: newObsIds,
            tags: newTags,
            freshnessAt: new Date(),
          },
        });
      }
      logMemoryOp({
        userId, actorType: actor, operation: 'update', memoryType: 'fact', memoryId: factId,
        before: { content: existing.content, confidence: existing.confidence, status: existing.status },
        after: { content, confidence: newConfidence, status: newStatus },
      }).catch(() => {});
      return true;
    } catch (err) {
      console.error('[facts] update failed:', (err as any)?.message);
      return false;
    }
  }

  /**
   * SUPERSEDE an old fact with a new one. Closes the old fact's validity
   * interval, marks status='superseded', links superseded_by → new_id.
   * Adds the new fact with the reference back.
   */
  async supersede(
    userId: string,
    oldFactId: string,
    newFactInput: FactInput,
    privacyMode: PrivacyMode = 'standard',
    actor: 'llm_judge' | 'user' = 'llm_judge',
  ): Promise<string | null> {
    const oldFact = await prisma.fact.findFirst({ where: { id: oldFactId, userId } });
    if (!oldFact) return null;

    // Insert the new fact (needs embedding → separate raw SQL; Prisma interactive
    // transactions don't play well with $executeRawUnsafe on pgvector columns).
    const newId = await this.add(
      {
        ...newFactInput,
        sourceEpisodeIds: mergeUnique(oldFact.sourceEpisodeIds, newFactInput.sourceEpisodeIds ?? []),
        sourceObservationIds: mergeUnique(oldFact.sourceObservationIds, newFactInput.sourceObservationIds ?? []),
      },
      privacyMode,
      actor,
    );
    if (!newId) return null;

    // Close the old fact. If this fails, roll back the new fact so both don't
    // end up active (which would poison retrieval with contradictory facts).
    try {
      await prisma.fact.update({
        where: { id: oldFactId },
        data: {
          status: 'superseded',
          validTo: new Date(),
          supersededBy: newId,
        },
      });
    } catch (err: any) {
      console.error('[facts] supersede close-old failed, rolling back new fact:', err?.message);
      try {
        await prisma.fact.delete({ where: { id: newId } });
      } catch (rollbackErr: any) {
        console.error('[facts] rollback also failed — both facts now exist. Manual cleanup required.', rollbackErr?.message);
      }
      return null;
    }

    logMemoryOp({
      userId, actorType: actor, operation: 'supersede', memoryType: 'fact', memoryId: oldFactId,
      before: { content: oldFact.content, status: oldFact.status },
      after: { supersededBy: newId, status: 'superseded' },
    }).catch(() => {});

    return newId;
  }

  /** Promote a candidate to active (e.g. after evidence threshold met). */
  async promote(userId: string, factId: string): Promise<boolean> {
    const existing = await prisma.fact.findFirst({ where: { id: factId, userId, status: 'candidate' } });
    if (!existing) return false;
    await prisma.fact.update({
      where: { id: factId },
      data: { status: 'active', confidence: Math.max(existing.confidence, 0.75) },
    });
    logMemoryOp({
      userId, actorType: 'system', operation: 'update', memoryType: 'fact', memoryId: factId,
      before: { status: 'candidate' }, after: { status: 'active' },
      reason: 'promotion threshold reached',
    }).catch(() => {});
    return true;
  }

  /** Soft-delete (status='deleted'). Preserves audit trail. */
  async forget(userId: string, factId: string, actor: 'user' | 'system' = 'user', reason?: string): Promise<boolean> {
    const existing = await prisma.fact.findFirst({ where: { id: factId, userId } });
    if (!existing) return false;
    await prisma.fact.update({
      where: { id: factId },
      data: { status: 'deleted', validTo: new Date() },
    });
    logMemoryOp({
      userId, actorType: actor, operation: 'delete', memoryType: 'fact', memoryId: factId,
      before: { status: existing.status }, after: { status: 'deleted' },
      reason: reason ?? 'user requested forget',
    }).catch(() => {});
    return true;
  }

  /** Forget all active facts matching a subject (by id or name). */
  async forgetBySubject(userId: string, subjectIdOrName: string): Promise<number> {
    const res = await prisma.fact.updateMany({
      where: {
        userId,
        status: { in: ['active', 'candidate'] },
        OR: [{ subjectId: subjectIdOrName }, { subjectName: subjectIdOrName }],
      },
      data: { status: 'deleted', validTo: new Date() },
    });
    return res.count;
  }

  async forgetByDateRange(userId: string, from: Date, to: Date): Promise<number> {
    const res = await prisma.fact.updateMany({
      where: {
        userId,
        status: { in: ['active', 'candidate'] },
        validFrom: { gte: from, lte: to },
      },
      data: { status: 'deleted', validTo: new Date() },
    });
    return res.count;
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function mergeUnique<T>(a: T[], b: T[]): T[] {
  return Array.from(new Set([...(a || []), ...(b || [])]));
}

function rowToRecord(r: any): FactRecord {
  return {
    id: r.id,
    content: r.content,
    predicate: r.predicate,
    subjectName: r.subjectName,
    objectValue: r.objectValue,
    confidence: r.confidence,
    importance: r.importance,
    status: r.status,
    validFrom: r.validFrom,
    validTo: r.validTo,
    freshnessAt: r.freshnessAt,
    supersededBy: r.supersededBy,
    sourceEpisodeIds: r.sourceEpisodeIds ?? [],
    sourceObservationIds: r.sourceObservationIds ?? [],
    tags: r.tags ?? [],
    distance: r.distance,
  };
}
