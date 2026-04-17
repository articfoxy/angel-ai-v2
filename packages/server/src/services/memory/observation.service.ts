/**
 * ObservationService (Layer C) — append-only raw events.
 *
 * Every incoming input becomes an observation envelope. Immutable. Never
 * mutated after write. Optional async embedding.
 *
 * Batched to avoid N+1 on high-throughput voice sessions (transcript chunks).
 */
import { randomUUID } from 'crypto';
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import {
  classifyContent,
  canPersistObservation,
  type PrivacyMode,
  type PrivacyClass,
} from './policy';

export interface ObservationInput {
  userId: string;
  sessionId?: string | null;
  modality: 'audio_transcript' | 'tool_event' | 'scene' | 'ocr' | 'user_command' | 'system_event';
  source: string;
  content: string;
  speaker?: string | null;
  payload?: any;
  importance?: number;
  entities?: string[];
  locality?: any;
  observedAt?: Date;
  extractorVersions?: Record<string, string>;
  privacyClass?: PrivacyClass;
  contentRef?: string | null;
}

export class ObservationService {
  private embeddings: EmbeddingService;

  constructor(apiKey?: string) {
    this.embeddings = new EmbeddingService(apiKey);
  }

  /** Write a single observation. Returns the id, or null if policy blocks persistence. */
  async write(input: ObservationInput, privacyMode: PrivacyMode = 'standard'): Promise<string | null> {
    const privacyClass = input.privacyClass ?? classifyContent(input.content);
    if (!canPersistObservation(privacyMode, privacyClass)) return null;

    const id = randomUUID();
    const vec = await this.embeddings.embed(input.content);
    const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;

    try {
      if (vectorStr) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Observation"
            (id, "userId", "sessionId", "observedAt", modality, source, speaker, content, payload,
             importance, "privacyClass", "contentRef", "extractorVersions", entities, locality,
             embedding, "schemaVersion", processed, "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14::text[], $15::jsonb,
                   $16::vector, 1, false, NOW())`,
          id,
          input.userId,
          input.sessionId ?? null,
          input.observedAt ?? new Date(),
          input.modality,
          input.source,
          input.speaker ?? null,
          input.content.slice(0, 8000),
          JSON.stringify(input.payload ?? null),
          Math.max(0, Math.min(10, Math.round(input.importance ?? 5))),
          privacyClass,
          input.contentRef ?? null,
          JSON.stringify(input.extractorVersions ?? null),
          input.entities ?? [],
          JSON.stringify(input.locality ?? null),
          vectorStr,
        );
      } else {
        await prisma.observation.create({
          data: {
            id,
            userId: input.userId,
            sessionId: input.sessionId ?? null,
            observedAt: input.observedAt ?? new Date(),
            modality: input.modality,
            source: input.source,
            speaker: input.speaker ?? null,
            content: input.content.slice(0, 8000),
            payload: input.payload ?? undefined,
            importance: Math.max(0, Math.min(10, Math.round(input.importance ?? 5))),
            privacyClass,
            contentRef: input.contentRef ?? null,
            extractorVersions: input.extractorVersions ?? undefined,
            entities: input.entities ?? [],
            locality: input.locality ?? undefined,
            schemaVersion: 1,
            processed: false,
          },
        });
      }
      return id;
    } catch (err) {
      console.error('[observation] write failed:', (err as any)?.message);
      return null;
    }
  }

  /** Write many observations in a batch. More efficient for transcript chunks. */
  async writeBatch(inputs: ObservationInput[], privacyMode: PrivacyMode = 'standard'): Promise<string[]> {
    const ids: string[] = [];
    for (const input of inputs) {
      const id = await this.write(input, privacyMode);
      if (id) ids.push(id);
    }
    return ids;
  }

  /** Get unprocessed observations for the memory judge. */
  async getUnprocessed(userId: string, sessionId?: string, limit = 50) {
    return prisma.observation.findMany({
      where: {
        userId,
        processed: false,
        ...(sessionId ? { sessionId } : {}),
      },
      orderBy: { observedAt: 'asc' },
      take: limit,
    });
  }

  /** Mark observations consumed by the judge. */
  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await prisma.observation.updateMany({
      where: { id: { in: ids } },
      data: { processed: true },
    });
  }
}
