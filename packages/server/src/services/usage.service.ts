/**
 * UsageService — token + cost tracking for every LLM call.
 *
 * Each LLM call site calls `usageService.record(...)` fire-and-forget after
 * receiving the response. We extract `usage` from the SDK response, translate
 * to USD via the pricing table below, and persist a TokenUsage row.
 *
 * Writes are async and unawaited — never block the user-facing path.
 */
import { prisma } from '../index';

export type UsageProvider =
  | 'openai'
  | 'anthropic'
  | 'deepgram'
  | 'cartesia'
  | 'perplexity';

export type UsageOperation =
  | 'judge'
  | 'brief'
  | 'digest_morning'
  | 'digest_evening'
  | 'digest_weekly'
  | 'intent_parse'
  | 'retrieval_embed'
  | 'entity_embed'
  | 'realtime_session'
  | 'claude_brain'
  | 'summarize'
  | 'extract'
  | 'mood_infer'
  | 'pattern_mine'
  | 'search'
  | 'tts'
  | 'stt'
  | 'other';

export interface RecordArgs {
  userId: string;
  provider: UsageProvider;
  model: string;
  operation: UsageOperation;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string | null;
  /** If the caller already knows the USD cost (e.g., duration-billed TTS/STT),
   *  pass it here and we'll use this instead of the pricing table lookup. */
  costUsdOverride?: number;
}

/**
 * Pricing per 1 million tokens (USD). Add models as we use them.
 * Keep conservative / slightly-high — better to over-report than under-report.
 *
 * Sources: public pricing pages as of April 2026. These move occasionally so
 * we freeze per-row USD at write time — historical totals don't change when
 * prices change.
 */
const PRICE_TABLE: Record<string, { input: number; output: number }> = {
  // OpenAI text
  'gpt-4o':                    { input: 2.50,  output: 10.00 },
  'gpt-4o-2024-11-20':         { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':               { input: 0.15,  output: 0.60 },
  'gpt-4o-mini-2024-07-18':    { input: 0.15,  output: 0.60 },
  'gpt-4.1':                   { input: 2.00,  output: 8.00 },
  'gpt-4.1-mini':              { input: 0.40,  output: 1.60 },
  'o1':                        { input: 15.00, output: 60.00 },
  'o1-mini':                   { input: 1.10,  output: 4.40 },

  // OpenAI Realtime (text token prices — audio tokens billed separately)
  'gpt-4o-realtime-preview':   { input: 5.00,  output: 20.00 },
  'gpt-4o-realtime':           { input: 5.00,  output: 20.00 },

  // OpenAI embeddings
  'text-embedding-3-small':    { input: 0.02,  output: 0 },
  'text-embedding-3-large':    { input: 0.13,  output: 0 },

  // Anthropic — April 2026 Claude family
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4':             { input: 15.00, output: 75.00 },
  'claude-sonnet-4':           { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5':         { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':          { input: 0.80,  output: 4.00 },
  'claude-haiku-4':            { input: 0.80,  output: 4.00 },
};

function costFor(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICE_TABLE[model] ?? PRICE_TABLE[model.toLowerCase()];
  if (!p) return 0; // unknown model — still record tokens, just can't price it
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

export class UsageService {
  /** Fire-and-forget recording of a single LLM call. */
  record(args: RecordArgs): void {
    if (!args.userId || (!args.inputTokens && !args.outputTokens && !args.costUsdOverride)) {
      return;
    }
    const cost = args.costUsdOverride ?? costFor(args.model, args.inputTokens, args.outputTokens);

    // Fire-and-forget. Usage tracking must NEVER block the call path.
    prisma.tokenUsage.create({
      data: {
        userId: args.userId,
        provider: args.provider,
        model: args.model,
        operation: args.operation,
        inputTokens: Math.max(0, Math.round(args.inputTokens || 0)),
        outputTokens: Math.max(0, Math.round(args.outputTokens || 0)),
        costUsd: cost,
        sessionId: args.sessionId ?? null,
      },
    }).catch((err) => {
      console.warn('[usage] record failed:', err?.message?.slice(0, 100));
    });
  }

  /** Aggregate stats over a time window. Returns breakdowns by provider
   *  and operation, plus totals. */
  async summarize(userId: string, fromDate: Date, toDate: Date) {
    const rows = await prisma.tokenUsage.findMany({
      where: {
        userId,
        createdAt: { gte: fromDate, lte: toDate },
      },
      select: {
        provider: true,
        model: true,
        operation: true,
        inputTokens: true,
        outputTokens: true,
        costUsd: true,
      },
    });

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    const byProvider: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};
    const byOperation: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};
    const byModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number; calls: number }> = {};

    for (const r of rows) {
      totalInput += r.inputTokens;
      totalOutput += r.outputTokens;
      totalCost += r.costUsd;

      const p = byProvider[r.provider] ?? (byProvider[r.provider] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
      p.inputTokens += r.inputTokens;
      p.outputTokens += r.outputTokens;
      p.costUsd += r.costUsd;
      p.calls += 1;

      const o = byOperation[r.operation] ?? (byOperation[r.operation] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
      o.inputTokens += r.inputTokens;
      o.outputTokens += r.outputTokens;
      o.costUsd += r.costUsd;
      o.calls += 1;

      const m = byModel[r.model] ?? (byModel[r.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
      m.inputTokens += r.inputTokens;
      m.outputTokens += r.outputTokens;
      m.costUsd += r.costUsd;
      m.calls += 1;
    }

    return {
      windowStart: fromDate.toISOString(),
      windowEnd: toDate.toISOString(),
      totalCalls: rows.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalCostUsd: Number(totalCost.toFixed(4)),
      byProvider,
      byOperation,
      byModel,
    };
  }
}

export const usageService = new UsageService();
