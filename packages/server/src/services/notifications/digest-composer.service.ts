/**
 * DigestComposer — the "weekly reveal" wow moment engine.
 *
 * Morning brief: today's events + overdue commitments + mood trend
 * Evening debrief: what happened today + unresolved loops
 * Weekly reveal: patterns mined across the week (tired N days, skipped gym, promises overdue)
 *
 * Outputs are Digest rows in DB + pushed/whispered via ResponseOrchestrator.
 */
import OpenAI from 'openai';
import { prisma } from '../../index';
import { responseOrchestrator } from './orchestrator.service';

const DIGEST_MODEL = process.env.DIGEST_MODEL || 'gpt-4o-mini';

export type DigestKind = 'morning' | 'evening' | 'weekly';

export class DigestComposer {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
  }

  async composeAndDeliver(userId: string, kind: DigestKind): Promise<string | null> {
    const { start, end } = this.windowFor(kind);
    const data = await this.gatherData(userId, start, end, kind);

    // If there's nothing to report, skip
    if (data.episodeCount === 0 && data.commitments.length === 0 && data.moodSignals.length === 0) {
      return null;
    }

    const prompt = this.buildPrompt(kind, data);
    let summary = '';
    let sections: Array<{ label: string; bullets: string[] }> = [];

    try {
      const res = await this.openai.chat.completions.create({
        model: DIGEST_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPTS[kind] },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.5,
      });
      const body = JSON.parse(res.choices[0]?.message?.content || '{}');
      summary = String(body.summary || '').slice(0, 500);
      sections = Array.isArray(body.sections) ? body.sections.slice(0, 6) : [];
    } catch (err: any) {
      console.warn(`[digest-${kind}] LLM failed:`, err?.message);
      return null;
    }

    if (!summary) return null;

    // Persist the digest
    const digest = await prisma.digest.create({
      data: {
        userId,
        kind,
        windowStart: start,
        windowEnd: end,
        summary,
        sections: sections as any,
        importance: kind === 'weekly' ? 8 : 6,
        deliveredVia: [],
      },
    });

    // Deliver via orchestrator — picks push if session backgrounded, whisper if live
    const delivery = await responseOrchestrator.propose({
      userId,
      kind: 'digest',
      importance: kind === 'weekly' ? 8 : 6,
      content: summary,
      detail: sections.map((s) => `${s.label}:\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n'),
      data: { digestId: digest.id, digestKind: kind },
      dedupKey: `digest-${kind}-${userId}-${start.toISOString().slice(0, 10)}`,
    });

    // Mark delivered
    await prisma.digest.update({
      where: { id: digest.id },
      data: {
        deliveredVia: delivery.delivered,
        deliveredAt: new Date(),
      },
    });

    return digest.id;
  }

  private windowFor(kind: DigestKind): { start: Date; end: Date } {
    const now = new Date();
    if (kind === 'morning') {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    if (kind === 'evening') {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      return { start, end: now };
    }
    // weekly — last 7 days
    const start = new Date(now.getTime() - 7 * 24 * 3_600_000);
    return { start, end: now };
  }

  private async gatherData(userId: string, start: Date, end: Date, kind: DigestKind) {
    const [episodes, commitments, moodSignals, upcomingEvents, overdue, goals] = await Promise.all([
      prisma.episode.findMany({
        where: { userId, status: 'active', timeEnd: { gte: start, lte: end } },
        orderBy: { timeEnd: 'desc' },
        take: 30,
      }),
      prisma.commitment.findMany({
        where: { userId, createdAt: { gte: start, lte: end } },
        take: 30,
      }),
      prisma.moodSignal.findMany({
        where: { userId, observedAt: { gte: start, lte: end } },
        orderBy: { observedAt: 'desc' },
        take: 50,
      }),
      // Morning brief: upcoming calendar events for today
      kind === 'morning'
        ? prisma.calendarEvent.findMany({
            where: {
              userId, status: 'active',
              startAt: { gte: new Date(), lte: new Date(Date.now() + 24 * 3_600_000) },
            },
            orderBy: { startAt: 'asc' },
            take: 10,
          })
        : Promise.resolve([]),
      // Always include overdue commitments
      prisma.commitment.findMany({
        where: { userId, status: 'open', dueDate: { lt: new Date() } },
        take: 10,
      }),
      // Weekly includes goal progress
      kind === 'weekly'
        ? prisma.goal.findMany({
            where: { userId, status: 'active' },
            take: 10,
          })
        : Promise.resolve([]),
    ]);

    return {
      episodeCount: episodes.length,
      episodes,
      commitments,
      moodSignals,
      upcomingEvents,
      overdue,
      goals,
    };
  }

  private buildPrompt(kind: DigestKind, data: any): string {
    const parts: string[] = [];

    if (data.episodes.length > 0) {
      parts.push('## Episodes');
      for (const e of data.episodes.slice(0, 10)) {
        parts.push(`- [imp ${e.importance}] ${e.title}: ${String(e.summary).slice(0, 200)}`);
      }
    }

    if (data.upcomingEvents?.length > 0) {
      parts.push('## Today (upcoming)');
      for (const ev of data.upcomingEvents) {
        parts.push(`- ${ev.startAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} ${ev.title}`);
      }
    }

    if (data.commitments.length > 0) {
      parts.push('## Commitments this window');
      for (const c of data.commitments) {
        const due = c.dueDate ? ` (due ${c.dueDate.toLocaleDateString()})` : '';
        parts.push(`- [${c.status}] ${c.fromName}→${c.toName}: ${c.description}${due}`);
      }
    }

    if (data.overdue.length > 0) {
      parts.push('## Overdue');
      for (const c of data.overdue) {
        const days = Math.round((Date.now() - (c.dueDate?.getTime() || Date.now())) / (24 * 3_600_000));
        parts.push(`- ${c.description} (${days}d overdue, to ${c.toName})`);
      }
    }

    if (data.moodSignals.length > 0) {
      const counts: Record<string, number> = {};
      for (const m of data.moodSignals) counts[m.primary] = (counts[m.primary] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4);
      parts.push('## Mood signals (count)');
      for (const [mood, count] of top) parts.push(`- ${mood}: ${count}`);
    }

    if (data.goals?.length > 0) {
      parts.push('## Active goals');
      for (const g of data.goals) {
        parts.push(`- ${g.title}: ${(g.progress * 100).toFixed(0)}% · mentioned ${g.mentionCount}×`);
      }
    }

    return parts.join('\n');
  }
}

const SYSTEM_PROMPTS: Record<DigestKind, string> = {
  morning: `You are Angel, writing the user's morning brief. Keep it short — 2 sentences for the summary + 2-3 section bullets max.
Focus: today's upcoming meetings/events + any overdue commitments. Lead with the most time-sensitive thing.
Output JSON: { "summary": "...", "sections": [{"label":"Today","bullets":["..."]}, {"label":"Loose ends","bullets":["..."]}] }`,
  evening: `You are Angel, writing the user's evening debrief. Tone: reflective, compact.
Focus: what happened today, any commitments closed or slipping, mood trend. Surface loops not yet resolved.
Output JSON: { "summary": "2-sentence debrief", "sections": [{"label":"Today","bullets":[...]}, {"label":"Still open","bullets":[...]}] }`,
  weekly: `You are Angel, writing the user's weekly reveal. This is the highest-stakes digest — it's the reflection the user couldn't do themselves.
Focus: patterns across the week (mood streaks, goal drift, social debts piling up), non-obvious connections. Be specific, cite numbers. No filler.
Output JSON: { "summary": "2-3 sentence reveal naming a pattern", "sections": [{"label":"What repeated","bullets":[...]}, {"label":"What drifted","bullets":[...]}, {"label":"Try this","bullets":["optional single suggestion"]}] }`,
};

export const digestComposer = new DigestComposer();
