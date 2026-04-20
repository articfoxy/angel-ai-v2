/**
 * EntityService — resolve people / orgs / places / topics.
 *
 * Phase B substrate for the pre-brief. The Judge emits raw entity mentions
 * ("Sarah", "Acme Corp") — this service upserts them against existing
 * entities with alias matching, maintains the entity graph, and provides
 * entity-scoped memory views (facts by subject, last-interaction, etc).
 */
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import { logMemoryOp } from './audit';

export interface EntityInput {
  userId: string;
  name: string;
  type: 'person' | 'org' | 'place' | 'topic' | 'object' | 'product';
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface EntityRecord {
  id: string;
  entityType: string;
  canonicalName: string;
  aliases: string[];
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
  /** Only populated by findSimilar (pgvector cosine distance, 0 = identical). */
  distance?: number;
}

export class EntityService {
  private embeddings: EmbeddingService;

  constructor(apiKey?: string) {
    this.embeddings = new EmbeddingService(apiKey);
  }

  /**
   * Upsert an entity. Matches by canonicalName OR alias (case-insensitive).
   * If a match is found, merges aliases. Otherwise creates a new row.
   */
  async upsert(input: EntityInput): Promise<string> {
    const trimmed = input.name.trim();
    if (!trimmed) throw new Error('name required');

    // Try match on exact name OR alias (case-insensitive via lowercase normalization)
    const existing = await prisma.entity.findFirst({
      where: {
        userId: input.userId,
        entityType: input.type,
        OR: [
          { canonicalName: { equals: trimmed, mode: 'insensitive' } },
          { aliases: { has: trimmed } },
          { aliases: { has: trimmed.toLowerCase() } },
        ],
      },
    });

    if (existing) {
      const newAliases = mergeAliases(existing.canonicalName, existing.aliases, input.aliases || [], trimmed);
      if (newAliases.length !== existing.aliases.length) {
        await prisma.entity.update({
          where: { id: existing.id },
          data: { aliases: newAliases },
        });
      }
      return existing.id;
    }

    // Embed the name for semantic disambiguation (future: fuzzy match across types)
    const vec = await this.embeddings.embed(trimmed);
    const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;
    const aliases = Array.from(new Set([...(input.aliases || [])])).filter((a) => a !== trimmed);

    if (vectorStr) {
      const { randomUUID } = await import('crypto');
      const id = randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Entity" (id, "userId", "entityType", "canonicalName", aliases, metadata, embedding, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::vector, NOW(), NOW())`,
        id, input.userId, input.type, trimmed, aliases,
        JSON.stringify(input.metadata || {}),
        vectorStr,
      );
      return id;
    }
    const row = await prisma.entity.create({
      data: {
        userId: input.userId,
        entityType: input.type,
        canonicalName: trimmed,
        aliases,
        metadata: input.metadata as any,
      },
    });
    return row.id;
  }

  /** Resolve a name string to an existing entity, or null. */
  async resolveByName(userId: string, name: string): Promise<EntityRecord | null> {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const row = await prisma.entity.findFirst({
      where: {
        userId,
        OR: [
          { canonicalName: { equals: trimmed, mode: 'insensitive' } },
          { aliases: { has: trimmed } },
          { aliases: { has: trimmed.toLowerCase() } },
        ],
      },
    });
    return row ? toRecord(row) : null;
  }

  /** Semantic similarity search — for fuzzy matching across spellings/phrasings.
   *  Returned rows include a numeric `distance` (0 = identical, larger = less
   *  similar). Callers typically filter on distance < 0.3 for "clearly the same". */
  async findSimilar(userId: string, query: string, k = 5): Promise<EntityRecord[]> {
    const vec = await this.embeddings.embed(query);
    if (!vec) {
      const rows = await prisma.entity.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
        take: k,
      });
      // No vector — no real distance signal. Return with distance=1 (never
      // passes tight similarity filters), preserving the contract.
      return rows.map((r) => ({ ...toRecord(r), distance: 1 }));
    }
    const vectorStr = this.embeddings.toSqlVector(vec);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, "entityType", "canonicalName", aliases, metadata, "createdAt", "updatedAt",
              embedding <=> $1::vector AS distance
       FROM "Entity"
       WHERE "userId" = $2 AND embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      vectorStr, userId, k,
    );
    return rows.map((r) => {
      const rec = toRecord(r);
      // distance comes back as number | string depending on pg driver coercion
      const dist = r.distance != null ? Number(r.distance) : undefined;
      rec.distance = Number.isFinite(dist) ? dist : undefined;
      return rec;
    });
  }

  /**
   * Compose an entity-scoped memory view for the BriefComposer.
   * Returns: facts about this entity + recent episodes involving them +
   * open commitments to/from them + last mood signals tied to interactions.
   */
  async entityView(userId: string, entityId: string, opts: { factsLimit?: number; episodesLimit?: number } = {}) {
    const facts = await prisma.fact.findMany({
      where: {
        userId,
        subjectId: entityId,
        status: { in: ['active', 'candidate'] },
        validTo: null,
      },
      orderBy: { freshnessAt: 'desc' },
      take: opts.factsLimit ?? 15,
      select: {
        id: true, content: true, predicate: true, subjectName: true,
        confidence: true, freshnessAt: true, tags: true,
      },
    });

    // Episodes mentioning this entity
    const episodes = await prisma.episode.findMany({
      where: {
        userId,
        status: 'active',
        entityIds: { has: entityId },
      },
      orderBy: { timeEnd: 'desc' },
      take: opts.episodesLimit ?? 5,
      select: {
        id: true, title: true, summary: true, timeEnd: true, importance: true,
      },
    });

    // Open commitments to/from this entity
    const commitments = await prisma.commitment.findMany({
      where: {
        userId,
        status: 'open',
        OR: [{ toEntityId: entityId }, { fromEntityId: entityId }],
      },
      orderBy: { dueDate: 'asc' },
      take: 10,
    });

    return { facts, episodes, commitments };
  }
}

function toRecord(r: any): EntityRecord {
  return {
    id: r.id,
    entityType: r.entityType,
    canonicalName: r.canonicalName,
    aliases: r.aliases ?? [],
    metadata: r.metadata,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function mergeAliases(canonical: string, existing: string[], incoming: string[], mentioned: string): string[] {
  const set = new Set(existing);
  for (const a of incoming) if (a !== canonical) set.add(a);
  if (mentioned !== canonical) set.add(mentioned);
  // Cap at 20 to prevent unbounded growth
  return Array.from(set).slice(0, 20);
}

export const entityService = new EntityService();
