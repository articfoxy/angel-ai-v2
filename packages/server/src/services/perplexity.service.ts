/**
 * Perplexity AI search service.
 * Uses Perplexity's Sonar model for real-time web search with citations.
 */

interface PerplexityResult {
  answer: string;
  citations: string[];
}

export class PerplexityService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.PERPLEXITY_API_KEY || '';
  }

  get isAvailable(): boolean {
    return !!this.apiKey;
  }

  /**
   * Search using Perplexity's Sonar model.
   * Returns a grounded answer with citation URLs.
   */
  async search(query: string): Promise<PerplexityResult> {
    if (!this.apiKey) {
      throw new Error('PERPLEXITY_API_KEY not set');
    }

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'Be precise and concise. Provide factual information with sources.',
          },
          {
            role: 'user',
            content: query,
          },
        ],
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Perplexity API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as any;
    const answer = data.choices?.[0]?.message?.content || 'No answer available.';
    const citations: string[] = data.citations || [];

    return { answer, citations };
  }
}
