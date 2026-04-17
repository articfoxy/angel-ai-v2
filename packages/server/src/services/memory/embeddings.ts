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

  async embed(text: string): Promise<number[] | null> {
    if (!this.enabled || !text.trim()) return null;
    try {
      const res = await this.client.embeddings.create({ model: MODEL, input: text.slice(0, 8000) });
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
