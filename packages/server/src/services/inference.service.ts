import OpenAI from 'openai';
import { RetrievalService } from './memory/retrieval.service';

interface InferenceConfig {
  provider: 'openai' | 'anthropic' | 'google';
  apiKey: string;
  model?: string;
}

interface WhisperResult {
  type: string;
  content: string;
  detail?: string;
  confidence?: number;
  /** If set, the server should execute this action before emitting the whisper */
  action?: 'save_memory' | 'web_search';
  actionData?: Record<string, unknown>;
}

const GENERALIST_SYSTEM_PROMPT = `You are Angel, a personal AI companion listening to a live conversation through the user's AirPods. You provide real-time, proactive help AND respond to the owner's commands.

## OWNER COMMANDS (highest priority — respond IMMEDIATELY)

The owner (labeled [Owner] in transcript) can talk to you directly. Detect these patterns:

1. **"Angel, remember..."** / **"Save this..."** / **"Note that..."** — The owner wants you to save something to memory.
   Return: { "type": "memory_saved", "content": "Saved: <what you're saving>", "action": "save_memory", "actionData": { "content": "<fact to save>", "importance": 7, "category": "fact" } }

2. **"Angel, search for..."** / **"Look up..."** / **"Google..."** — The owner wants you to search for something.
   Return: { "type": "search", "content": "Searching: <query>", "action": "web_search", "actionData": { "query": "<search query>" } }

3. **"Angel, what is..."** / **"Angel, explain..."** / **"Hey Angel..."** / Any direct question to Angel — The owner is asking you directly.
   Return: { "type": "response", "content": "<your concise answer>", "detail": "<optional extra context>" }
   Answer from your knowledge. Be concise but helpful.

4. **"Angel, who is..."** / **"Tell me about..."** — Knowledge questions.
   Return: { "type": "response", "content": "<answer>" }

The owner doesn't always say "Angel" — if the most recent [Owner] line is clearly a question or command directed at the AI (not to other people in the room), treat it as a command.

## PASSIVE BEHAVIORS (when no command detected)

5. **JARGON & TERM DETECTION** — When ANYONE uses technical terms, acronyms, industry jargon, slang, or specialized vocabulary that the owner may not know, explain it.
   - Business: "ARR", "burn rate", "cap table", "LTV:CAC", "Series A"
   - Tech: "kubernetes", "microservices", "latency", "API gateway"
   - Legal: "indemnification", "force majeure", "fiduciary duty"
   - Medical, Finance, any field: acronyms, abbreviations, foreign phrases
   Use type "definition" for these.

6. **KEY INSIGHTS** — Hidden implications, contradictions, things that affect the owner. Use type "insight".

7. **ACTION ITEMS** — When someone commits to something or asks the owner to do something. Use type "action".

8. **WARNINGS** — Red flags, inconsistencies, caution needed. Use type "warning".

## RULES
- Owner commands ALWAYS take priority over passive behaviors
- Be FAST and CONCISE — max 1-2 sentences for content, optional 1 sentence for detail
- For memory saves, extract the core fact clearly (remove filler words)
- For search requests, formulate a good search query from the owner's words
- For direct questions, answer confidently and concisely
- Focus on what the owner DOESN'T already know
- If nothing genuinely useful AND no command detected, return skip
- Never repeat something you already whispered about`;

export class InferenceService {
  private retrieval: RetrievalService;

  constructor() {
    this.retrieval = new RetrievalService();
  }

  async generateWhisper(
    userId: string,
    recentTranscript: string,
    config?: InferenceConfig,
    activeSkills?: string[],
    recentWhispers?: string[]
  ): Promise<WhisperResult | null> {
    const provider = config?.provider || 'openai';
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY || '';

    // Early API key validation
    if (!apiKey) {
      console.warn(`[InferenceService] No API key available for provider "${provider}", skipping whisper generation`);
      return null;
    }

    // Build context from memory system (v2 signature: includes sessionId + opts)
    const memoryResult = await this.retrieval.buildContext(userId, recentTranscript, null, { maxTokens: 3000 });
    const memoryContext = memoryResult.prompt;

    // Build skills context
    let skillsContext = '';
    if (activeSkills && activeSkills.length > 0) {
      const { prisma } = await import('../index');
      const skills = await prisma.skill.findMany({
        where: { id: { in: activeSkills } },
      });
      if (skills.length > 0) {
        skillsContext = '\n## Active Skills\n';
        skills.forEach((s) => {
          skillsContext += `**${s.name}**: ${s.systemPrompt}\n`;
        });
      }
    }

    const systemPrompt = GENERALIST_SYSTEM_PROMPT;
    const alreadyWhispered = recentWhispers && recentWhispers.length > 0
      ? `\n## Already Whispered (DO NOT repeat these)\n${recentWhispers.map(w => `- ${w}`).join('\n')}\n`
      : '';
    const userContent = `${memoryContext}${skillsContext}${alreadyWhispered}\n## Recent Transcript\n${recentTranscript}\n\nAnalyze the transcript above. FIRST check if the owner is giving you a command or asking you a question. If so, respond to it. Otherwise, look for jargon, insights, action items, or warnings.\n\nReturn ONE JSON object:\n- Command response: { "type": "memory_saved|search|response", "content": "...", "action": "save_memory|web_search", "actionData": {...}, "confidence": 0.9 }\n- Passive whisper: { "type": "definition|insight|action|warning", "content": "...", "detail": "optional", "confidence": 0.8 }\n- Nothing useful: { "skip": true }\n\nFor definitions: "TERM — explanation".\nFor memory saves: include actionData with { "content": "fact to save", "importance": 1-10, "category": "fact|preference|person|event" }.\nFor searches: include actionData with { "query": "search terms" }.\nFor direct answers (type "response"): just answer concisely, no action needed.`;

    let result: string;

    try {
      if (provider === 'openai') {
        const client = new OpenAI({ apiKey });
        const response = await client.chat.completions.create({
          model: config?.model || 'gpt-4o-mini',
          messages: [
            { role: 'system' as const, content: systemPrompt },
            { role: 'user' as const, content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 200,
        });
        result = response.choices[0].message.content || '{}';
      } else if (provider === 'anthropic') {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config?.model || 'claude-sonnet-4-20250514',
            max_tokens: 200,
            system: systemPrompt,
            messages: [
              { role: 'user', content: userContent },
            ],
          }),
        });
        if (!response.ok) {
          const errorBody = await response.text();
          console.error(`[InferenceService] Anthropic API error ${response.status}: ${errorBody}`);
          return null;
        }
        const data = (await response.json()) as any;
        result = data.content?.[0]?.text || '{}';
      } else if (provider === 'google') {
        const model = config?.model || 'gemini-2.0-flash';
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `${systemPrompt}\n\n${userContent}` }] }],
              generationConfig: { maxOutputTokens: 200, temperature: 0.3 },
            }),
          }
        );
        if (!response.ok) {
          const errorBody = await response.text();
          console.error(`[InferenceService] Google Gemini API error ${response.status}: ${errorBody}`);
          return null;
        }
        const data = (await response.json()) as any;
        result = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      } else {
        return null;
      }
    } catch (err) {
      console.error(`[InferenceService] ${provider} request failed:`, err);
      return null;
    }

    try {
      const parsed = JSON.parse(result);
      if (parsed.skip) return null;
      const whisper: WhisperResult = {
        type: parsed.type || 'insight',
        content: parsed.content || '',
        detail: parsed.detail,
        confidence: parsed.confidence,
      };
      // Attach action data if the LLM returned a command
      if (parsed.action) {
        whisper.action = parsed.action;
        whisper.actionData = parsed.actionData;
      }
      return whisper;
    } catch {
      return null;
    }
  }
}
