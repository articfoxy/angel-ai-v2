import { prisma } from '../../index';
import OpenAI from 'openai';

// Five-factor retrieval scoring
const WEIGHTS = {
  relevance: 0.35,
  recency: 0.25,
  importance: 0.20,
  connectivity: 0.10,
  accessFrequency: 0.10,
};

const DECAY_LAMBDA = 0.995;

interface ScoredMemory {
  id: string;
  content: string;
  score: number;
  category?: string | null;
}

export class RetrievalService {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  async getEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  }

  async buildContext(userId: string, currentTranscript: string, maxTokens = 4500): Promise<string> {
    // 1. Always include core memory (~500 tokens)
    const core = await prisma.coreMemory.findUnique({ where: { userId } });
    let context = '## Core Memory\n';
    if (core) {
      if (core.userProfile) context += `**User Profile:** ${core.userProfile}\n`;
      if (core.preferences) context += `**Preferences:** ${core.preferences}\n`;
      if (core.keyPeople) context += `**Key People:** ${core.keyPeople}\n`;
      if (core.activeGoals) context += `**Active Goals:** ${core.activeGoals}\n`;
    }
    context += '\n';

    // 2. Retrieve relevant memories via vector search (~2000 tokens)
    try {
      const embedding = await this.getEmbedding(currentTranscript);
      const relevantMemories = await this.vectorSearch(userId, embedding, 15);

      // Score and rank
      const scored = await this.scoreMemories(relevantMemories, embedding);
      const topMemories = scored.slice(0, 10);

      if (topMemories.length > 0) {
        context += '## Relevant Memories\n';
        for (const mem of topMemories) {
          context += `- ${mem.content}\n`;
        }
        context += '\n';

        // Update access counts
        const memoryIds = topMemories.map((m) => m.id);
        await prisma.memory.updateMany({
          where: { id: { in: memoryIds } },
          data: { accessCount: { increment: 1 }, lastAccessed: new Date() },
        });
      }
    } catch (err) {
      console.error('Vector search error, falling back to text:', err);
      // Fallback to text search
      const memories = await prisma.memory.findMany({
        where: { userId, validTo: null },
        orderBy: { importance: 'desc' },
        take: 10,
      });
      if (memories.length > 0) {
        context += '## Recent Memories\n';
        for (const mem of memories) {
          context += `- ${mem.content}\n`;
        }
        context += '\n';
      }
    }

    // 3. Include relevant reflections
    const reflections = await prisma.reflection.findMany({
      where: { userId },
      orderBy: { importance: 'desc' },
      take: 5,
    });
    if (reflections.length > 0) {
      context += '## Insights\n';
      for (const ref of reflections) {
        context += `- ${ref.content}\n`;
      }
      context += '\n';
    }

    return context;
  }

  private async vectorSearch(
    userId: string,
    embedding: number[],
    limit: number
  ): Promise<Array<{ id: string; content: string; importance: number; accessCount: number; createdAt: Date; category: string | null }>> {
    const vectorStr = `[${embedding.join(',')}]`;
    const results = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, content, importance, "accessCount", "createdAt", category,
              embedding <=> $1::vector AS distance
       FROM "Memory"
       WHERE "userId" = $2 AND "validTo" IS NULL AND embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      vectorStr,
      userId,
      limit
    );
    return results;
  }

  private async scoreMemories(
    memories: Array<{ id: string; content: string; importance: number; accessCount: number; createdAt: Date; category: string | null; distance?: number }>,
    _embedding: number[]
  ): Promise<ScoredMemory[]> {
    const now = Date.now();

    const scored = memories.map((mem) => {
      // Relevance (from cosine distance, convert to similarity)
      const relevance = mem.distance !== undefined ? Math.max(0, 1 - mem.distance) : 0.5;

      // Recency (exponential decay)
      const ageHours = (now - new Date(mem.createdAt).getTime()) / (1000 * 60 * 60);
      const recency = Math.pow(DECAY_LAMBDA, ageHours);

      // Importance (normalized to 0-1)
      const importance = mem.importance / 10;

      // Access frequency (log scale, normalized)
      const accessFreq = Math.min(1, Math.log(1 + mem.accessCount) / 5);

      // Connectivity placeholder (would need graph lookup)
      const connectivity = 0.5;

      const score =
        WEIGHTS.relevance * relevance +
        WEIGHTS.recency * recency +
        WEIGHTS.importance * importance +
        WEIGHTS.connectivity * connectivity +
        WEIGHTS.accessFrequency * accessFreq;

      return { id: mem.id, content: mem.content, score, category: mem.category };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
