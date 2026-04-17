/**
 * EpisodeService (Layer D) — bounded meaningful interactions.
 *
 * Episodes are NOT transcript segments (that was v1's misuse). Episodes are
 * LLM-synthesized summaries of a coherent chunk of interaction, produced by
 * the memory judge with evidence refs back to source observations.
 *
 * Triggers for episode creation:
 *   - session boundary (session:stop / disconnect)
 *   - mode switch
 *   - meeting close detected (long silence)
 *   - explicit topic change
 *   - notable user exchange (high importance burst)
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import { logMemoryOp } from './audit';

export interface EpisodeInput {
  userId: string;
  sessionId?: string | null;
  timeStart: Date;
  timeEnd: Date;
  title: string;
  summary: string;
  importance?: number;
  confidence?: number;
  sourceObservationIds: string[];
  entityIds?: string[];
  actors?: string[];
  salience?: any;
}

export interface EpisodeRecord {
  id: string;
  title: string;
  summary: string;
  timeStart: Date;
  timeEnd: Date;
  importance: number;
  confidence: number;
  status: string;
  sourceObservationIds: string[];
  entityIds: string[];
  actors: string[];
  salience: any;
  createdAt: Date;
  distance?: number;
}

export class EpisodeService {
  private embeddings: EmbeddingService;

  constructor(apiKey?: string) {
    this.embeddings = new EmbeddingService(apiKey);
  }

  async create(input: EpisodeInput): Promise<string | null> {
    const id = randomUUID();
    const embedText = `${input.title}\n\n${input.summary}`;
    const vec = await this.embeddings.embed(embedText);
    const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;
    const importance = Math.max(0, Math.min(10, Math.round(input.importance ?? 5)));
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.7));

    try {
      if (vectorStr) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Episode"
            (id, "userId", "sessionId", "timeStart", "timeEnd", title, summary,
             importance, confidence, status, "sourceObservationIds", "entityIds", actors,
             salience, embedding, "schemaVersion", "createdAt", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10::text[],$11::text[],$12::text[],
                   $13::jsonb,$14::vector,1,NOW(),NOW())`,
          id, input.userId, input.sessionId ?? null,
          input.timeStart, input.timeEnd,
          input.title.slice(0, 500), input.summary.slice(0, 4000),
          importance, confidence,
          input.sourceObservationIds, input.entityIds ?? [], input.actors ?? [],
          JSON.stringify(input.salience ?? null), vectorStr,
        );
      } else {
        await prisma.episode.create({
          data: {
            id,
            userId: input.userId,
            sessionId: input.sessionId ?? null,
            timeStart: input.timeStart,
            timeEnd: input.timeEnd,
            title: input.title.slice(0, 500),
            summary: input.summary.slice(0, 4000),
            importance,
            confidence,
            status: 'active',
            sourceObservationIds: input.sourceObservationIds,
            entityIds: input.entityIds ?? [],
            actors: input.actors ?? [],
            salience: input.salience ?? undefined,
          },
        });
      }
      logMemoryOp({
        userId: input.userId, actorType: 'llm_judge', operation: 'create', memoryType: 'episode', memoryId: id,
        after: { title: input.title, importance, confidence },
      }).catch(() => {});
      return id;
    } catch (err) {
      console.error('[episode] create failed:', (err as any)?.message);
      return null;
    }
  }

  /** Top-K similar episodes for retrieval. */
  async findSimilar(userId: string, query: string, k = 6): Promise<EpisodeRecord[]> {
    const vec = await this.embeddings.embed(query);
    if (!vec) {
      const rows = await prisma.episode.findMany({
        where: { userId, status: 'active' },
        orderBy: { timeEnd: 'desc' },
        take: k,
      });
      return rows.map(rowToRecord);
    }
    const vectorStr = this.embeddings.toSqlVector(vec);
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, summary, "timeStart", "timeEnd", importance, confidence, status,
              "sourceObservationIds", "entityIds", actors, salience, "createdAt",
              embedding <=> $1::vector AS distance
       FROM "Episode"
       WHERE "userId" = $2 AND status = 'active' AND embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      vectorStr, userId, k,
    );
    return rows.map(rowToRecord);
  }

  async list(userId: string, opts: { limit?: number; offset?: number } = {}): Promise<EpisodeRecord[]> {
    const rows = await prisma.episode.findMany({
      where: { userId, status: 'active' },
      orderBy: { timeEnd: 'desc' },
      take: opts.limit ?? 50,
      skip: opts.offset ?? 0,
    });
    return rows.map(rowToRecord);
  }

  async forget(userId: string, episodeId: string): Promise<boolean> {
    const existing = await prisma.episode.findFirst({ where: { id: episodeId, userId } });
    if (!existing) return false;
    await prisma.episode.update({
      where: { id: episodeId },
      data: { status: 'archived' },
    });
    logMemoryOp({
      userId, actorType: 'user', operation: 'delete', memoryType: 'episode', memoryId: episodeId,
      before: { status: existing.status }, after: { status: 'archived' },
    }).catch(() => {});
    return true;
  }

  async forgetByDateRange(userId: string, from: Date, to: Date): Promise<number> {
    const res = await prisma.episode.updateMany({
      where: { userId, status: 'active', timeStart: { gte: from, lte: to } },
      data: { status: 'archived' },
    });
    return res.count;
  }
}

function rowToRecord(r: any): EpisodeRecord {
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    timeStart: r.timeStart,
    timeEnd: r.timeEnd,
    importance: r.importance,
    confidence: r.confidence,
    status: r.status,
    sourceObservationIds: r.sourceObservationIds ?? [],
    entityIds: r.entityIds ?? [],
    actors: r.actors ?? [],
    salience: r.salience,
    createdAt: r.createdAt,
    distance: r.distance,
  };
}
