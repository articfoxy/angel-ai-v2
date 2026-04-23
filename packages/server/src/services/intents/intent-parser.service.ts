/**
 * IntentParser — turns natural-language directives into structured Intents.
 *
 * Example:
 *   "in the next 30 min I'm entering a meeting with Chinese investors,
 *    help me translate" →
 *   [
 *     { kind: "translate", langs: ["Chinese"], expiresIn: "30min", reason: "investor meeting" },
 *     { kind: "meeting_prep", who: "investors", domain: "fundraising" }
 *   ]
 *
 * Gated by a cheap regex first — ~90% of Owner transcripts are content
 * (not directives), so we only pay for the LLM call when there's a strong
 * signal we should parse.
 */
import OpenAI from 'openai';

const PARSER_MODEL = process.env.INTENT_MODEL || 'gpt-4o-mini';
const PARSE_TIMEOUT_MS = 4000;

// Cheap gate — only parse if text looks like a directive
const DIRECTIVE_HINT = /\b(for|in|next|translate|help|watch|prep|focus|handle|switch|coming up|about to|i need|for this|during|until|for the next|entering|meeting with|call with)\b/i;

export type IntentKind =
  | 'translate'
  | 'jargon_explain'
  | 'meeting_mode'
  | 'deep_work'
  | 'code_focus'
  | 'fact_check'
  | 'coaching'
  | 'quiet'          // "don't interrupt me"
  | 'verbose'        // "explain more"
  | 'meeting_prep';

export interface Intent {
  id?: string;
  kind: IntentKind;
  reason: string;           // what the user said that triggered this
  langs?: string[];         // for translate
  expiresInMinutes?: number;
  expiresOn?: 'meeting_ends' | 'user_says_stop' | 'next_30min' | 'next_60min' | 'today';
  participantContext?: string;
  priority?: number;        // 1-10, explicit commands default 8, passive-inferred default 4
  source: 'user_command' | 'auto_inferred' | 'calendar' | 'planner';
  startedAt: string;        // ISO
}

export class IntentParserService {
  private openai: OpenAI;
  private enabled: boolean;

  constructor(apiKey?: string) {
    const key = apiKey || process.env.OPENAI_API_KEY || '';
    this.enabled = !!key;
    this.openai = new OpenAI({ apiKey: key });
  }

  /** Check if a text is worth parsing. Cheap. */
  isDirectiveLikely(text: string): boolean {
    const lower = text.toLowerCase().trim();
    if (lower.length < 12 || lower.length > 500) return false;
    return DIRECTIVE_HINT.test(lower);
  }

  /** Extract structured intents from a user utterance.
   *  @param opts.userId optional — pass for token-usage attribution. */
  async parse(text: string, opts?: { userId?: string; sessionId?: string | null }): Promise<Intent[] | null> {
    if (!this.enabled) return null;
    if (!this.isDirectiveLikely(text)) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PARSE_TIMEOUT_MS);

    try {
      const res = await this.openai.chat.completions.create({
        model: PARSER_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }, { signal: controller.signal });

      clearTimeout(timeout);
      // Track token usage
      if (opts?.userId) {
        try {
          const { usageService } = await import('../usage.service');
          usageService.record({
            userId: opts.userId,
            provider: 'openai',
            model: PARSER_MODEL,
            operation: 'intent_parse',
            inputTokens: res.usage?.prompt_tokens ?? 0,
            outputTokens: res.usage?.completion_tokens ?? 0,
            sessionId: opts.sessionId ?? null,
          });
        } catch {}
      }
      const body = res.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(body);
      const intents: Intent[] = Array.isArray(parsed.intents) ? parsed.intents : [];

      // Validate + normalize
      return intents
        .filter((i) => i && typeof i.kind === 'string')
        .map((i) => ({
          kind: i.kind as IntentKind,
          reason: String(i.reason || text.slice(0, 120)),
          langs: i.langs?.map((l: any) => String(l)),
          expiresInMinutes: typeof i.expiresInMinutes === 'number' ? i.expiresInMinutes : undefined,
          expiresOn: i.expiresOn,
          participantContext: i.participantContext ? String(i.participantContext).slice(0, 200) : undefined,
          priority: typeof i.priority === 'number' ? i.priority : 8, // explicit = high
          source: 'user_command' as const,
          startedAt: new Date().toISOString(),
        }));
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name !== 'AbortError') console.warn('[intent-parser] failed:', err?.message?.slice(0, 100));
      return null;
    }
  }
}

const SYSTEM_PROMPT = `You are Angel's Intent Parser. Take the user's utterance and decide if it's configuring Angel's behavior for the next while, or just normal content/conversation.

Return JSON: { "intents": [...] }

Intent fields:
- kind: one of "translate" | "jargon_explain" | "meeting_mode" | "deep_work" | "code_focus" | "fact_check" | "coaching" | "quiet" | "verbose" | "meeting_prep"
- reason: short quote of what the user said
- langs: for translate only, array of language names e.g. ["Chinese", "English"]
- expiresInMinutes: absolute time bound if user said one (e.g. "next 30 min" → 30)
- expiresOn: semantic bound: "meeting_ends" | "user_says_stop" | "next_30min" | "next_60min" | "today"
- participantContext: who / what the context is about (e.g. "investors", "co-founder")
- priority: 1-10; explicit user commands = 8

Rules:
- Return empty intents array if the message is content, not a directive.
- "help me translate Chinese for 30 min" → kind=translate, langs=["Chinese","English"], expiresInMinutes=30
- "handle jargon in this meeting" → kind=jargon_explain, expiresOn="meeting_ends"
- "I'm about to call my mom" → kind=meeting_prep, participantContext="mom" (no translate/jargon unless requested)
- "don't interrupt me" → kind=quiet, expiresOn="user_says_stop"
- "focus on code" → kind=code_focus, expiresOn="user_says_stop"
- Ambiguous / pure content ("what did we talk about yesterday?") → empty intents

Output: valid JSON only, no markdown.`;

export const intentParser = new IntentParserService();
