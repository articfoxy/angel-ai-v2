/**
 * RetrievalV2Service — budgeted, typed retrieval across 8 layers.
 *
 * Build order per PRD §13.1:
 *   1. core_blocks (always)
 *   2. working_state (always, current session)
 *   3. active procedures (triggered by keywords)
 *   4. hybrid recall: top-K facts (status in active/candidate)
 *   5. hybrid recall: top-K episodes
 *   6. top-2 reflections
 *
 * Budget per layer (PRD §13.4):
 *   core ~600 tokens · working ~300 · procedures ~300 · facts ~1500 · episodes ~1500 · reflections ~400
 *   total ~4600, cap at maxTokens.
 *
 * Score = 0.5·semantic_similarity + 0.3·recency_decay + 0.15·importance + 0.05·access_reinforcement
 * Reinforcement increments access_count on retrieved items.
 *
 * Every call writes a RetrievalAudit row with used memory ids + reason codes.
 */
import { prisma } from '../../index';
import { EmbeddingService } from './embeddings';
import { CoreBlocksService } from './core-blocks.service';
import { WorkingStateService } from './working-state.service';
import { FactsService } from './facts.service';
import { EpisodeService } from './episode.service';
import { ProcedureService } from './procedure.service';
import { logRetrieval } from './audit';
import { canRecall, type PrivacyMode } from './policy';
import { withSpan } from '../../telemetry';

const WEIGHTS = {
  semantic: 0.5,
  recency:  0.3,
  importance: 0.15,
  access: 0.05,
};

// Half-life ~7 days → λ = ln(2)/168 hours
const RECENCY_LAMBDA_PER_HOUR = Math.log(2) / (7 * 24);

export interface RetrievalOptions {
  maxTokens?: number;
  facts?: number;
  episodes?: number;
  reflections?: number;
  privacyMode?: PrivacyMode;
  responseId?: string | null;
  contextKeywords?: string[];
}

export interface RetrievalResult {
  prompt: string;
  usedIds: {
    facts: string[];
    episodes: string[];
    reflections: string[];
    procedures: string[];
  };
  reasonCodes: string[];
  tokenEstimate: number;
}

export class RetrievalService {
  private embeddings: EmbeddingService;
  private coreBlocks: CoreBlocksService;
  private workingState: WorkingStateService;
  private facts: FactsService;
  private episodes: EpisodeService;
  private procedures: ProcedureService;

  constructor(apiKey?: string) {
    this.embeddings = new EmbeddingService(apiKey);
    this.coreBlocks = new CoreBlocksService();
    this.workingState = new WorkingStateService();
    this.facts = new FactsService(apiKey);
    this.episodes = new EpisodeService(apiKey);
    this.procedures = new ProcedureService();
  }

  async buildContext(
    userId: string,
    query: string,
    sessionId: string | null,
    opts: RetrievalOptions = {},
  ): Promise<RetrievalResult> {
    return withSpan('memory.retrieval.buildContext', async (span) => {
      span?.setAttribute('memory.user_id', userId);
      span?.setAttribute('memory.session_id', sessionId ?? '');
      span?.setAttribute('memory.query_len', query.length);
      const result = await this._buildContext(userId, query, sessionId, opts);
      span?.setAttribute('memory.facts_count', result.usedIds.facts.length);
      span?.setAttribute('memory.episodes_count', result.usedIds.episodes.length);
      span?.setAttribute('memory.reflections_count', result.usedIds.reflections.length);
      span?.setAttribute('memory.token_estimate', result.tokenEstimate);
      return result;
    }, { 'memory.layer': 'retrieval' });
  }

  private async _buildContext(
    userId: string,
    query: string,
    sessionId: string | null,
    opts: RetrievalOptions = {},
  ): Promise<RetrievalResult> {
    const t0 = Date.now();
    const maxTokens = opts.maxTokens ?? 4000;
    const maxFacts = opts.facts ?? 5;
    const maxEpisodes = opts.episodes ?? 6;
    const maxReflections = opts.reflections ?? 2;
    const privacyMode = opts.privacyMode ?? 'standard';
    const reasons: string[] = [];

    // 1. Core blocks (deterministic)
    const coreText = await this.coreBlocks.renderForPrompt(userId);
    reasons.push('core:injected');

    // 2. Working state (deterministic for this session)
    const workingText = await this.workingState.renderForPrompt(userId, sessionId);
    if (workingText) reasons.push('working:injected');

    // 3. Active procedures
    const procText = await this.procedures.renderForPrompt(userId, opts.contextKeywords ?? []);
    const procMatches = opts.contextKeywords && opts.contextKeywords.length > 0
      ? await this.procedures.matchActive(userId, opts.contextKeywords)
      : [];
    if (procText) reasons.push(`procedures:${procMatches.length}`);

    // 4-6. Hybrid recall (facts + episodes + reflections)
    const [factCandidates, episodeCandidates, reflectionCandidates] = await Promise.all([
      this.facts.findSimilar(userId, query, maxFacts * 2),
      this.episodes.findSimilar(userId, query, maxEpisodes * 2),
      this.fetchReflections(userId, query, maxReflections * 2),
    ]);

    // Score + filter by privacy — per-fact privacyClass from the DB row
    const now = Date.now();
    const scoredFacts = factCandidates
      .filter((f) => canRecall(privacyMode, f.privacyClass || 'public'))
      .map((f) => ({ item: f, score: scoreItem(f.distance ?? 1, f.freshnessAt, f.importance, 0, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFacts);

    const scoredEpisodes = episodeCandidates
      .map((e) => ({ item: e, score: scoreItem(e.distance ?? 1, e.timeEnd, e.importance, 0, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxEpisodes);

    const scoredReflections = reflectionCandidates
      .map((r) => ({ item: r, score: scoreItem(r.distance ?? 1, r.createdAt, r.importance, 0, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxReflections);

    if (scoredFacts.length) reasons.push(`facts:${scoredFacts.length}`);
    if (scoredEpisodes.length) reasons.push(`episodes:${scoredEpisodes.length}`);
    if (scoredReflections.length) reasons.push(`reflections:${scoredReflections.length}`);

    // Build the prompt block
    const parts: string[] = [];
    let tokenEstimate = 0;

    if (coreText) { parts.push(coreText); tokenEstimate += estimateTokens(coreText); }
    if (workingText) { parts.push(workingText); tokenEstimate += estimateTokens(workingText); }
    if (procText) { parts.push(procText); tokenEstimate += estimateTokens(procText); }

    if (scoredFacts.length) {
      const lines = scoredFacts.map((s) => `- ${s.item.content} [conf ${(s.item.confidence).toFixed(2)}]`);
      const section = `<recalled_facts>\n${lines.join('\n')}\n</recalled_facts>`;
      if (tokenEstimate + estimateTokens(section) <= maxTokens) {
        parts.push(section); tokenEstimate += estimateTokens(section);
      }
    }
    if (scoredEpisodes.length) {
      const lines = scoredEpisodes.map((s) => `- [${new Date(s.item.timeEnd).toISOString().slice(0, 10)}] ${s.item.title}: ${s.item.summary.slice(0, 300)}`);
      const section = `<recalled_episodes>\n${lines.join('\n')}\n</recalled_episodes>`;
      if (tokenEstimate + estimateTokens(section) <= maxTokens) {
        parts.push(section); tokenEstimate += estimateTokens(section);
      }
    }
    if (scoredReflections.length) {
      const lines = scoredReflections.map((s) => `- ${s.item.summary}`);
      const section = `<reflections>\n${lines.join('\n')}\n</reflections>`;
      if (tokenEstimate + estimateTokens(section) <= maxTokens) {
        parts.push(section); tokenEstimate += estimateTokens(section);
      }
    }

    const prompt = parts.length ? `<memory>\n${parts.join('\n\n')}\n</memory>` : '';
    const usedIds = {
      facts: scoredFacts.map((s) => s.item.id),
      episodes: scoredEpisodes.map((s) => s.item.id),
      reflections: scoredReflections.map((s) => s.item.id),
      procedures: procMatches.map((p) => p.id),
    };

    // Reinforce access on recalled items
    if (usedIds.facts.length > 0) {
      prisma.fact.updateMany({
        where: { id: { in: usedIds.facts } },
        data: { accessCount: { increment: 1 }, lastAccessed: new Date() },
      }).catch(() => {});
    }

    // Audit (fire-and-forget)
    logRetrieval({
      userId,
      responseId: opts.responseId ?? null,
      queryText: query,
      usedMemoryIds: usedIds,
      reasonCodes: reasons,
      latencyMs: Date.now() - t0,
    }).catch(() => {});

    return { prompt, usedIds, reasonCodes: reasons, tokenEstimate };
  }

  private async fetchReflections(userId: string, query: string, k: number): Promise<any[]> {
    const vec = await this.embeddings.embed(query);
    if (!vec) {
      const rows = await prisma.reflection.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: k,
      });
      return rows.map((r) => ({ ...r, distance: 0.5 }));
    }
    const vectorStr = this.embeddings.toSqlVector(vec);
    return prisma.$queryRawUnsafe<any[]>(
      `SELECT id, summary, importance, "createdAt", embedding <=> $1::vector AS distance
       FROM "Reflection"
       WHERE "userId" = $2 AND embedding IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      vectorStr, userId, k,
    );
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    return this.embeddings.embed(text);
  }
}

function scoreItem(distance: number, freshness: Date, importance: number, accessCount: number, nowMs: number): number {
  const similarity = Math.max(0, 1 - distance);
  const ageHours = (nowMs - new Date(freshness).getTime()) / 3_600_000;
  const recency = Math.exp(-RECENCY_LAMBDA_PER_HOUR * Math.max(0, ageHours));
  const importanceNorm = importance / 10;
  const accessNorm = Math.min(1, Math.log(1 + accessCount) / 5);
  return (
    WEIGHTS.semantic * similarity +
    WEIGHTS.recency * recency +
    WEIGHTS.importance * importanceNorm +
    WEIGHTS.access * accessNorm
  );
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
