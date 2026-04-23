/**
 * Embedding service — wraps OpenAI's text-embedding-3-small.
 * All memory-layer services call through here so we can swap providers later.
 */
import OpenAI from 'openai';

const MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const DIMENSIONS = 1536;

export class EmbeddingService {
  private client: OpenAI;
  private enabled: boolean;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY || '';
    this.enabled = !!key;
    this.client = new OpenAI({ apiKey: key });
  }

  async embed(text: string, opts?: { userId?: string; operation?: 'retrieval_embed' | 'entity_embed' | 'other' }): Promise<number[] | null> {
    if (!this.enabled || !text.trim()) return null;
    try {
      const res = await this.client.embeddings.create({ model: MODEL, input: text.slice(0, 8000) });
      // Track token usage — embeddings are the highest-volume OpenAI call in
      // the system (entity prefetch, retrieval, fact dedup). Attribution requires
      // the caller to pass userId; no-ops when it's absent.
      if (opts?.userId && res.usage?.total_tokens) {
        try {
          const { usageService } = await import('../usage.service');
          usageService.record({
            userId: opts.userId,
            provider: 'openai',
            model: MODEL,
            operation: opts.operation || 'other',
            inputTokens: res.usage.total_tokens,
            outputTokens: 0,
          });
        } catch {}
      }
      return res.data[0].embedding;
    } catch (err) {
      console.warn('[embed] failed:', (err as any)?.message?.slice(0, 80));
      return null;
    }
  }

  /** Format a vector for pgvector raw SQL. */
  toSqlVector(vec: number[]): string {
    return `[${vec.join(',')}]`;
  }

  get dim(): number { return DIMENSIONS; }
  get isAvailable(): boolean { return this.enabled; }
}
