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

// ~34-hour half-life: more aggressive decay so stale memories rank lower
const DECAY_LAMBDA = 0.98;

interface ScoredMemory {
  id: string;
  content: string;
  score: number;
  category?: string | null;
}

interface VectorSearchResult {
  id: string;
  content: string;
  importance: number;
  accessCount: number;
  createdAt: Date;
  category: string | null;
  distance: number;
}

export class RetrievalService {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error('OpenAI API key is required — set OPENAI_API_KEY or pass apiKey to constructor');
    }
    this.openai = new OpenAI({ apiKey: key });
  }

  async getEmbedding(text: string): Promise<number[]> {
    const response = await this.openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text,
    });
    return response.data[0].embedding;
  }

  async buildContext(userId: string, currentTranscript: string, maxTokens = 4500): Promise<string> {
    // Simple token budget enforcement: ~1 token per 4 characters
    const maxChars = maxTokens * 4;

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

    // 2. Retrieve relevant memories via vector search
    try {
      const embedding = await this.getEmbedding(currentTranscript);
      const relevantMemories = await this.vectorSearch(userId, embedding, 15);

      // Score and rank
      const scored = await this.scoreMemories(userId, relevantMemories, embedding);
      const topMemories = scored.slice(0, 10);

      if (topMemories.length > 0) {
        context += '## Relevant Memories\n';
        const includedIds: string[] = [];
        for (const mem of topMemories) {
          const line = `- ${mem.content}\n`;
          if (context.length + line.length > maxChars) break;
          context += line;
          includedIds.push(mem.id);
        }
        context += '\n';

        // Update access counts for included memories only
        if (includedIds.length > 0) {
          await prisma.memory.updateMany({
            where: { id: { in: includedIds } },
            data: { accessCount: { increment: 1 }, lastAccessed: new Date() },
          });
        }
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
          const line = `- ${mem.content}\n`;
          if (context.length + line.length > maxChars) break;
          context += line;
        }
        context += '\n';
      }
    }

    // 3. Include relevant reflections (only if budget remains)
    if (context.length < maxChars) {
      const reflections = await prisma.reflection.findMany({
        where: { userId },
        orderBy: { importance: 'desc' },
        take: 5,
      });
      if (reflections.length > 0) {
        context += '## Insights\n';
        for (const ref of reflections) {
          const line = `- ${ref.content}\n`;
          if (context.length + line.length > maxChars) break;
          context += line;
        }
        context += '\n';
      }
    }

    return context;
  }

  private async vectorSearch(
    userId: string,
    embedding: number[],
    limit: number
  ): Promise<VectorSearchResult[]> {
    const vectorStr = `[${embedding.join(',')}]`;
    const results = await prisma.$queryRawUnsafe<VectorSearchResult[]>(
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

  /**
   * Count relationships for entities mentioned in a memory's content.
   * Returns a 0-1 score: 0 = no connections, 1 = highly connected (10+ relationships).
   */
  private async getConnectivityScore(userId: string, content: string): Promise<number> {
    try {
      // Find entities whose name appears in the memory content
      const entities = await prisma.entity.findMany({
        where: { userId },
        select: { id: true, name: true },
      });

      const mentionedIds = entities
        .filter((e) => content.toLowerCase().includes(e.name.toLowerCase()))
        .map((e) => e.id);

      if (mentionedIds.length === 0) return 0;

      const relCount = await prisma.relationship.count({
        where: {
          validTo: null,
          OR: [
            { fromId: { in: mentionedIds } },
            { toId: { in: mentionedIds } },
          ],
        },
      });

      // Normalize: 10+ relationships => 1.0
      return Math.min(1, relCount / 10);
    } catch {
      return 0;
    }
  }

  private async scoreMemories(
    userId: string,
    memories: VectorSearchResult[],
    _embedding: number[]
  ): Promise<ScoredMemory[]> {
    const now = Date.now();

    const scored: ScoredMemory[] = [];

    for (const mem of memories) {
      // Relevance (from cosine distance, convert to similarity)
      const relevance = mem.distance !== undefined ? Math.max(0, 1 - mem.distance) : 0.5;

      // Recency (exponential decay)
      const ageHours = (now - new Date(mem.createdAt).getTime()) / (1000 * 60 * 60);
      const recency = Math.pow(DECAY_LAMBDA, ageHours);

      // Importance (normalized to 0-1)
      const importance = mem.importance / 10;

      // Access frequency (log scale, normalized)
      const accessFreq = Math.min(1, Math.log(1 + mem.accessCount) / 5);

      // Connectivity: real relationship count for mentioned entities
      const connectivity = await this.getConnectivityScore(userId, mem.content);

      const score =
        WEIGHTS.relevance * relevance +
        WEIGHTS.recency * recency +
        WEIGHTS.importance * importance +
        WEIGHTS.connectivity * connectivity +
        WEIGHTS.accessFrequency * accessFreq;

      scored.push({ id: mem.id, content: mem.content, score, category: mem.category });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }
}
