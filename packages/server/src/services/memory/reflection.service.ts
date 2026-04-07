import OpenAI from 'openai';
import { prisma } from '../../index';
import { RetrievalService } from './retrieval.service';

const REFLECTION_IMPORTANCE_THRESHOLD = 15; // cumulative importance before triggering reflection

export class ReflectionService {
  private openai: OpenAI;
  private retrieval: RetrievalService;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
    this.retrieval = new RetrievalService(apiKey);
  }

  /**
   * Stanford Generative Agents-style reflection:
   * Triggered when cumulative importance of recent memories exceeds threshold.
   * Generates higher-order insights stored as first-class memories.
   */
  async maybeReflect(userId: string): Promise<void> {
    // Get recent memories since last reflection
    const lastReflection = await prisma.reflection.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    const since = lastReflection?.createdAt || new Date(0);

    const recentMemories = await prisma.memory.findMany({
      where: {
        userId,
        validTo: null,
        createdAt: { gt: since },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Check if cumulative importance exceeds threshold
    const cumulativeImportance = recentMemories.reduce((sum, m) => sum + m.importance, 0);
    if (cumulativeImportance < REFLECTION_IMPORTANCE_THRESHOLD) return;

    // Generate reflections
    const memoryTexts = recentMemories.map((m) => `- [${m.category || 'fact'}] ${m.content}`).join('\n');

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a reflection engine for a personal AI assistant. Given recent memories/facts about a user, generate 2-3 higher-level insights or patterns.

These should be non-obvious observations that connect multiple memories, identify behavioral patterns, or surface implicit preferences/goals.

Examples:
- "User tends to get defensive when pricing is challenged — prefers value-based framing over cost justification"
- "User is building a startup while maintaining a day job — time management and energy allocation are key concerns"
- "User's relationship with Sarah appears to be both professional and personally supportive"

Return JSON: { "reflections": [{ "content": "...", "importance": 7, "sourceMemoryIds": ["id1", "id2"] }] }`,
        },
        {
          role: 'user',
          content: `Recent memories:\n${memoryTexts}`,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.5,
    });

    try {
      const result = JSON.parse(response.choices[0].message.content || '{}');
      const reflections = result.reflections || [];

      for (const reflection of reflections) {
        // Generate embedding for the reflection
        let embeddingStr: string | null = null;
        try {
          const embedding = await this.retrieval.getEmbedding(reflection.content);
          embeddingStr = `[${embedding.join(',')}]`;
        } catch {
          // Skip embedding if it fails
        }

        if (embeddingStr) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "Reflection" (id, "userId", content, embedding, importance, "sourceMemories", "createdAt")
             VALUES ($1, $2, $3, $4::vector, $5, $6, NOW())`,
            crypto.randomUUID(),
            userId,
            reflection.content,
            embeddingStr,
            reflection.importance || 7,
            reflection.sourceMemoryIds || []
          );
        } else {
          await prisma.reflection.create({
            data: {
              userId,
              content: reflection.content,
              importance: reflection.importance || 7,
              sourceMemories: reflection.sourceMemoryIds || [],
            },
          });
        }
      }

      console.log(`Generated ${reflections.length} reflections for user ${userId}`);
    } catch (err) {
      console.error('Reflection generation error:', err);
    }
  }

  /**
   * Cognee-style maintenance: strengthen frequently accessed, prune stale.
   */
  async maintain(userId: string): Promise<void> {
    // Soft-delete memories not accessed in 90 days with low importance
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await prisma.memory.updateMany({
      where: {
        userId,
        validTo: null,
        importance: { lte: 3 },
        lastAccessed: { lt: cutoff },
        accessCount: { lte: 1 },
      },
      data: { validTo: new Date() },
    });

    // Invalidate contradicted relationships
    await prisma.relationship.updateMany({
      where: {
        validTo: null,
        weight: { lt: 0.1 },
      },
      data: { validTo: new Date() },
    });
  }
}

/**
 * Convenience function to run reflection + maintenance at session end.
 * Call this from the session end handler after extraction completes.
 */
export async function runPostSessionReflection(userId: string): Promise<void> {
  try {
    const service = new ReflectionService();
    await service.maybeReflect(userId);
    await service.maintain(userId);
  } catch (err) {
    // Non-fatal — reflection tables may not exist yet
    console.warn('[reflection] Post-session reflection failed:', (err as any).code || err);
  }
}
