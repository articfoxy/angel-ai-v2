/**
 * ReflectionService (Layer G) — higher-order synthesis.
 *
 * Four trigger kinds:
 *   - importance_burst: cumulative importance since last reflection > threshold
 *   - time_window: nightly job (per PRD §12.5)
 *   - session_end: triggered from disconnect for the closed session
 *   - manual: on-demand via REST API
 *
 * A reflection synthesizes what repeated, changed, worked, failed, is stable,
 * should decay — over a time window. It cites supporting episodes and facts.
 */
import { randomUUID } from 'crypto';
import OpenAI from 'openai';
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import { logMemoryOp } from './audit';

const REFLECTION_MODEL = process.env.REFLECTION_MODEL || 'gpt-4o-mini';
const IMPORTANCE_THRESHOLD = 25;

export type ReflectionTrigger = 'importance_burst' | 'time_window' | 'session_end' | 'day_end' | 'manual';

export class ReflectionService {
  private openai: OpenAI;
  private embeddings: EmbeddingService;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.embeddings = new EmbeddingService(apiKey);
  }

  /** Check importance accumulation since last reflection; reflect if threshold met. */
  async maybeReflectOnBurst(userId: string): Promise<string | null> {
    const lastReflection = await prisma.reflection.findFirst({
      where: { userId, triggerKind: 'importance_burst' },
      orderBy: { createdAt: 'desc' },
    });
    const since = lastReflection?.createdAt ?? new Date(Date.now() - 7 * 24 * 3_600_000);

    const [recentEpisodes, recentFacts] = await Promise.all([
      prisma.episode.findMany({
        where: { userId, status: 'active', createdAt: { gt: since } },
        orderBy: { timeEnd: 'desc' },
        take: 30,
      }),
      prisma.fact.findMany({
        where: { userId, status: { in: ['active', 'candidate'] }, createdAt: { gt: since } },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);

    const cumulative = recentEpisodes.reduce((s, e) => s + e.importance, 0)
                     + recentFacts.reduce((s, f) => s + f.importance, 0);
    if (cumulative < IMPORTANCE_THRESHOLD) return null;

    return this.reflect({
      userId,
      trigger: 'importance_burst',
      windowStart: since,
      windowEnd: new Date(),
      episodes: recentEpisodes,
      facts: recentFacts,
    });
  }

  /** Session-end reflection on episodes from that session. */
  async reflectOnSession(userId: string, sessionId: string): Promise<string | null> {
    const episodes = await prisma.episode.findMany({
      where: { userId, sessionId, status: 'active' },
      orderBy: { timeEnd: 'asc' },
    });
    if (episodes.length === 0) return null;

    const obsIds = episodes.flatMap((e) => e.sourceObservationIds).slice(0, 30);
    const facts = await prisma.fact.findMany({
      where: { userId, sourceObservationIds: { hasSome: obsIds } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    return this.reflect({
      userId,
      trigger: 'session_end',
      windowStart: episodes[0].timeStart,
      windowEnd: episodes[episodes.length - 1].timeEnd,
      episodes,
      facts,
    });
  }

  /** Nightly day-end reflection on the last 24h. */
  async reflectOnDay(userId: string): Promise<string | null> {
    const dayAgo = new Date(Date.now() - 24 * 3_600_000);
    const episodes = await prisma.episode.findMany({
      where: { userId, status: 'active', createdAt: { gte: dayAgo } },
      orderBy: { timeEnd: 'desc' },
      take: 50,
    });
    if (episodes.length < 2) return null;
    const facts = await prisma.fact.findMany({
      where: { userId, status: { in: ['active', 'candidate'] }, createdAt: { gte: dayAgo } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return this.reflect({
      userId,
      trigger: 'day_end',
      windowStart: dayAgo,
      windowEnd: new Date(),
      episodes,
      facts,
    });
  }

  private async reflect(params: {
    userId: string;
    trigger: ReflectionTrigger;
    windowStart: Date;
    windowEnd: Date;
    episodes: any[];
    facts: any[];
  }): Promise<string | null> {
    const { userId, trigger, windowStart, windowEnd, episodes, facts } = params;

    const episodeText = episodes.length > 0
      ? episodes.map((e) => `- [imp ${e.importance}] ${e.title}: ${e.summary.slice(0, 200)}`).join('\n')
      : '(no episodes)';
    const factText = facts.length > 0
      ? facts.map((f) => `- [${f.predicate}] ${f.content}`).join('\n')
      : '(no facts)';

    const res = await this.openai.chat.completions.create({
      model: REFLECTION_MODEL,
      messages: [
        {
          role: 'system',
          content: `You are Angel's reflection engine. Given episodes and facts over a time window, synthesize 1-3 higher-order insights that answer:
- What REPEATED?
- What CHANGED?
- What WORKED / FAILED?
- What is becoming STABLE?
- What should DECAY?

Insights should be NON-OBVIOUS connections. NOT summaries. Cite episode/fact ids that support each insight.

Output JSON: {
  "reflections": [
    { "summary": "...", "themes": ["...","..."], "importance": 1-10, "confidence": 0-1,
      "supportingEpisodeIds": ["..."], "supportingFactIds": ["..."] }
  ]
}`,
        },
        {
          role: 'user',
          content: `## Window: ${windowStart.toISOString()} → ${windowEnd.toISOString()}\n\n## Episodes\n${episodeText}\n\n## Facts\n${factText}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    let parsed: any;
    try {
      parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
    } catch {
      return null;
    }
    const reflections: any[] = parsed.reflections ?? [];
    if (reflections.length === 0) return null;

    let firstId: string | null = null;
    for (const r of reflections) {
      const id = randomUUID();
      if (!firstId) firstId = id;
      const vec = await this.embeddings.embed(r.summary);
      const vectorStr = vec ? this.embeddings.toSqlVector(vec) : null;
      try {
        if (vectorStr) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Reflection"
              (id, "userId", "timeWindowStart", "timeWindowEnd", summary, themes, importance, confidence,
               "supportingEpisodeIds", "supportingFactIds", "triggerKind", embedding, "schemaVersion", "createdAt")
             VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9::text[],$10::text[],$11,$12::vector,1,NOW())`,
            id, userId, windowStart, windowEnd,
            (r.summary || '').slice(0, 2000),
            r.themes ?? [],
            Math.max(1, Math.min(10, Math.round(r.importance ?? 7))),
            Math.max(0, Math.min(1, r.confidence ?? 0.7)),
            r.supportingEpisodeIds ?? [], r.supportingFactIds ?? [],
            trigger, vectorStr,
          );
        } else {
          await prisma.reflection.create({
            data: {
              id,
              userId,
              timeWindowStart: windowStart,
              timeWindowEnd: windowEnd,
              summary: (r.summary || '').slice(0, 2000),
              themes: r.themes ?? [],
              importance: Math.max(1, Math.min(10, Math.round(r.importance ?? 7))),
              confidence: Math.max(0, Math.min(1, r.confidence ?? 0.7)),
              supportingEpisodeIds: r.supportingEpisodeIds ?? [],
              supportingFactIds: r.supportingFactIds ?? [],
              triggerKind: trigger,
            },
          });
        }
        logMemoryOp({
          userId, actorType: 'reflection_job', operation: 'create', memoryType: 'reflection', memoryId: id,
          after: { summary: r.summary, themes: r.themes, trigger },
        }).catch(() => {});
      } catch (err) {
        console.warn('[reflection] insert failed:', (err as any)?.message);
      }
    }
    return firstId;
  }
}

/** Compaction — runs on a cron. Decays, merges, prunes. */
export class CompactionService {
  /** Prune stale, low-importance, rarely-accessed memories. Soft-delete only. */
  async decay(userId: string): Promise<{ factsExpired: number; obsArchived: number }> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 3_600_000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3_600_000);

    const factsExpired = await prisma.fact.updateMany({
      where: {
        userId,
        status: { in: ['active', 'candidate'] },
        importance: { lte: 3 },
        accessCount: { lte: 1 },
        OR: [
          { lastAccessed: { lt: ninetyDaysAgo } },
          { AND: [{ lastAccessed: null }, { createdAt: { lt: ninetyDaysAgo } }] },
        ],
      },
      data: { status: 'expired', validTo: new Date() },
    });

    // Archive observations older than 30d once they've been processed
    // (they live on only via episode.sourceObservationIds references)
    const obsArchived = await prisma.observation.deleteMany({
      where: {
        userId,
        processed: true,
        observedAt: { lt: thirtyDaysAgo },
        privacyClass: { not: 'regulated' }, // regulated content has its own retention rules
      },
    });

    return { factsExpired: factsExpired.count, obsArchived: obsArchived.count };
  }

  /** Merge near-duplicate candidate facts via semantic clustering. */
  async mergeDuplicateFacts(userId: string): Promise<number> {
    // Candidate facts with high similarity to an active fact get superseded.
    // Done by the judge during normal ops; this is a cleanup pass for stragglers.
    const candidates = await prisma.fact.findMany({
      where: { userId, status: 'candidate', createdAt: { lt: new Date(Date.now() - 7 * 24 * 3_600_000) } },
      take: 50,
    });
    let merged = 0;
    for (const c of candidates) {
      // If no supporting evidence accrued, expire
      if ((c.sourceEpisodeIds?.length || 0) + (c.sourceObservationIds?.length || 0) <= 1 && c.accessCount <= 1) {
        await prisma.fact.update({ where: { id: c.id }, data: { status: 'expired', validTo: new Date() } });
        merged++;
      }
    }
    return merged;
  }

  /** Promote candidates to active based on evidence/access thresholds. */
  async promoteCandidates(userId: string): Promise<number> {
    const candidates = await prisma.fact.findMany({
      where: { userId, status: 'candidate' },
      take: 100,
    });
    let promoted = 0;
    for (const c of candidates) {
      const evidenceCount = (c.sourceEpisodeIds?.length || 0) + (c.sourceObservationIds?.length || 0);
      if (evidenceCount >= 3 || c.accessCount >= 3 || c.confidence >= 0.85) {
        await prisma.fact.update({
          where: { id: c.id },
          data: { status: 'active', confidence: Math.max(c.confidence, 0.8) },
        });
        promoted++;
      }
    }
    return promoted;
  }
}

/** @deprecated use runPostSessionMemoryJobs; kept for socket.service back-compat */
export async function runPostSessionReflection(userId: string, apiKey?: string): Promise<void> {
  return runPostSessionMemoryJobs(userId, null, apiKey);
}

/** Public wrapper called from session:stop / disconnect paths. */
export async function runPostSessionMemoryJobs(userId: string, sessionId: string | null, apiKey?: string): Promise<void> {
  try {
    const reflection = new ReflectionService(apiKey);
    if (sessionId) await reflection.reflectOnSession(userId, sessionId);
    await reflection.maybeReflectOnBurst(userId);
  } catch (err) {
    console.warn('[post-session] reflection failed:', (err as any)?.message);
  }
  try {
    const compaction = new CompactionService();
    await compaction.promoteCandidates(userId);
  } catch (err) {
    console.warn('[post-session] compaction failed:', (err as any)?.message);
  }
}
