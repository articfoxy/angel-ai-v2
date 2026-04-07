/**
 * Lightweight web search service.
 * Uses DuckDuckGo instant answer API (free, no key needed) as primary,
 * with a fallback to Brave Search API if BRAVE_SEARCH_KEY is set.
 */

interface SearchResult {
  title: string;
  snippet: string;
  url?: string;
}

export class SearchService {
  /**
   * Perform a web search and return top results.
   * Tries multiple sources in order of preference.
   */
  async search(query: string, maxResults = 3): Promise<SearchResult[]> {
    // Try Brave Search first if API key is available
    const braveKey = process.env.BRAVE_SEARCH_KEY;
    if (braveKey) {
      try {
        return await this.braveSearch(query, braveKey, maxResults);
      } catch (err) {
        console.warn('[SearchService] Brave search failed, falling back to DuckDuckGo:', err);
      }
    }

    // Fallback: DuckDuckGo instant answers (no key needed, limited results)
    try {
      return await this.duckDuckGoSearch(query);
    } catch (err) {
      console.warn('[SearchService] DuckDuckGo search failed:', err);
    }

    return [{ title: 'Search unavailable', snippet: `Could not search for "${query}". Try again later.` }];
  }

  private async braveSearch(query: string, apiKey: string, maxResults: number): Promise<SearchResult[]> {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`;
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`Brave API ${response.status}: ${await response.text()}`);
    }

    const data = (await response.json()) as any;
    const results: SearchResult[] = (data.web?.results || []).slice(0, maxResults).map((r: any) => ({
      title: r.title || '',
      snippet: r.description || '',
      url: r.url,
    }));

    return results.length > 0 ? results : [{ title: 'No results', snippet: `No results found for "${query}".` }];
  }

  private async duckDuckGoSearch(query: string): Promise<SearchResult[]> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`DuckDuckGo API ${response.status}`);
    }

    const data = (await response.json()) as any;
    const results: SearchResult[] = [];

    // Abstract (instant answer)
    if (data.Abstract) {
      results.push({
        title: data.Heading || query,
        snippet: data.Abstract,
        url: data.AbstractURL,
      });
    }

    // Related topics
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 3)) {
        if (topic.Text) {
          results.push({
            title: topic.FirstURL?.split('/').pop()?.replace(/_/g, ' ') || '',
            snippet: topic.Text,
            url: topic.FirstURL,
          });
        }
      }
    }

    // Answer (computational)
    if (data.Answer) {
      results.push({
        title: 'Answer',
        snippet: data.Answer,
      });
    }

    return results.length > 0
      ? results.slice(0, 3)
      : [{ title: 'Limited results', snippet: `DuckDuckGo instant answers didn't have results for "${query}". The AI will answer from its knowledge instead.` }];
  }
}
