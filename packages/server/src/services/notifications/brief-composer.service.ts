/**
 * BriefComposer — the wow-moment generator.
 *
 * Takes an entity (usually a person) and produces a 2-3 sentence pre-brief
 * that can be whispered via TTS or sent as push. Drives the "I'm about to
 * hop on with Sarah" moment.
 *
 * Inputs: entity view (facts, episodes, commitments) + optional calendar
 * context (upcoming event details if triggered by T-minus).
 * Model: claude-haiku-4-5 for speed + cost (~150ms, $0.0003/call).
 */
import { EntityService } from '../memory/entity.service';
import { CommitmentService } from '../memory/commitment.service';

const BRIEF_MODEL = process.env.BRIEF_MODEL || 'claude-haiku-4-5';
const BRIEF_TIMEOUT_MS = 5000;

export interface BriefRequest {
  userId: string;
  entityId?: string;
  entityName?: string; // falls back to this if no entityId
  context?: string;    // e.g. "upcoming meeting: Q3 review"
  reasonTrigger?: 'phrase_detected' | 'calendar_tminus' | 'manual_ask';
}

export interface BriefResult {
  summary: string;           // the 2-3 sentence whisper
  citations: string[];       // memory IDs that contributed
  modelLatencyMs: number;
  entityId: string | null;
  entityName: string;
}

export class BriefComposer {
  private entities: EntityService;
  private commitments: CommitmentService;

  constructor(private apiKey: string) {
    this.entities = new EntityService(apiKey);
    this.commitments = new CommitmentService();
  }

  async compose(req: BriefRequest): Promise<BriefResult | null> {
    const t0 = Date.now();

    // Resolve entity if we only have a name
    let entityId = req.entityId ?? null;
    let entityName = req.entityName ?? '';
    if (!entityId && entityName) {
      const resolved = await this.entities.resolveByName(req.userId, entityName);
      if (resolved) {
        entityId = resolved.id;
        entityName = resolved.canonicalName;
      }
    }

    if (!entityId) {
      // Cold start — no memory yet for this entity. Return a stub.
      return {
        summary: entityName
          ? `No memory of ${entityName} yet. First conversation — Angel is listening.`
          : 'No context available yet.',
        citations: [],
        modelLatencyMs: 0,
        entityId: null,
        entityName,
      };
    }

    const view = await this.entities.entityView(req.userId, entityId, { factsLimit: 12, episodesLimit: 4 });

    // Nothing to brief on
    if (view.facts.length + view.episodes.length + view.commitments.length === 0) {
      return {
        summary: `You have ${entityName} in memory but no details yet.`,
        citations: [],
        modelLatencyMs: 0,
        entityId,
        entityName,
      };
    }

    // Call Anthropic (no fallback — calling code handles null)
    if (!this.apiKey) return null;

    const prompt = this.buildPrompt(req, entityName, view);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: BRIEF_MODEL,
          max_tokens: 200,
          temperature: 0.4,
          system: `You are Angel, whispering a pre-brief to the user before they interact with ${entityName}.
Produce 2-3 short sentences (max 50 words) that cover the MOST useful context: the last interaction, open commitments either direction, and one recent fact or emotional note worth remembering. Be specific (names, dates, topics). No filler. No generic advice. No greetings. Plain text only.`,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        console.error(`[brief-composer] API ${res.status}: ${errBody.slice(0, 200)}`);
        return null;
      }
      const data = (await res.json()) as any;
      const text = data?.content?.find((b: any) => b.type === 'text')?.text?.trim() || '';
      if (!text) return null;

      // Track token usage — Anthropic reports input/output separately
      try {
        const { usageService } = await import('../usage.service');
        usageService.record({
          userId: req.userId,
          provider: 'anthropic',
          model: BRIEF_MODEL,
          operation: 'brief',
          inputTokens: data?.usage?.input_tokens ?? 0,
          outputTokens: data?.usage?.output_tokens ?? 0,
        });
      } catch {}

      const citations = [
        ...view.facts.map((f: any) => f.id),
        ...view.episodes.map((e: any) => e.id),
        ...view.commitments.map((c: any) => c.id),
      ];
      return {
        summary: text.slice(0, 400),
        citations,
        modelLatencyMs: Date.now() - t0,
        entityId,
        entityName,
      };
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === 'AbortError') console.warn('[brief-composer] timeout');
      else console.error('[brief-composer] failed:', err?.message);
      return null;
    }
  }

  private buildPrompt(req: BriefRequest, entityName: string, view: any): string {
    const parts: string[] = [];
    parts.push(`## Entity: ${entityName}`);
    if (req.context) parts.push(`## Context: ${req.context}`);
    if (req.reasonTrigger) parts.push(`## Trigger: ${req.reasonTrigger}`);

    if (view.facts.length > 0) {
      parts.push('## Known facts (newest first)');
      for (const f of view.facts) {
        const age = daysAgo(f.freshnessAt);
        parts.push(`- ${f.content} [${age}]`);
      }
    }

    if (view.episodes.length > 0) {
      parts.push('## Recent episodes');
      for (const e of view.episodes) {
        const age = daysAgo(e.timeEnd);
        parts.push(`- ${e.title} (${age}): ${String(e.summary).slice(0, 200)}`);
      }
    }

    if (view.commitments.length > 0) {
      parts.push('## Open commitments');
      for (const c of view.commitments) {
        const due = c.dueDate ? `due ${daysAgo(c.dueDate, true)}` : 'no due date';
        parts.push(`- ${c.fromName} → ${c.toName}: ${c.description} (${due})`);
      }
    }

    parts.push('');
    parts.push('Now produce the pre-brief (2-3 sentences, 50 words max).');
    return parts.join('\n');
  }
}

function daysAgo(date: Date, future = false): string {
  const ms = Date.now() - new Date(date).getTime();
  const days = Math.round(ms / (24 * 3_600_000));
  if (future) {
    if (days < 0) return `in ${Math.abs(days)}d`;
    if (days === 0) return 'today';
    return `${days}d ago (overdue)`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.round(days / 7)}w ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}
