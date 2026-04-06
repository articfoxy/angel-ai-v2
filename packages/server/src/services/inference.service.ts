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
}

const GENERALIST_SYSTEM_PROMPT = `You are Angel, a personal AI companion listening to a live conversation through the user's AirPods. You provide real-time insights, suggestions, and coaching.

You are a generalist — you adapt to whatever the conversation needs:
- In meetings: note key decisions, flag action items, surface relevant context
- In sales calls: identify objections, suggest responses, track commitments
- In learning sessions: clarify concepts, connect to prior knowledge, suggest follow-ups
- In brainstorming: challenge assumptions, suggest alternatives, capture ideas
- In coaching: provide encouragement, track progress, suggest improvements

You never need to be told what "mode" to use — you observe and respond appropriately.

Your responses should be:
- Concise (1-2 sentences max for real-time whispers)
- Actionable (tell the user something they can use RIGHT NOW)
- Contextual (use their memory and history to personalize)
- Non-intrusive (don't state the obvious)

Only generate a whisper when you have something genuinely useful to say. It's better to stay silent than to state the obvious.`;

export class InferenceService {
  private retrieval: RetrievalService;

  constructor() {
    this.retrieval = new RetrievalService();
  }

  async generateWhisper(
    userId: string,
    recentTranscript: string,
    config?: InferenceConfig,
    activeSkills?: string[]
  ): Promise<WhisperResult | null> {
    const provider = config?.provider || 'openai';
    const apiKey = config?.apiKey || process.env.OPENAI_API_KEY || '';

    // Early API key validation
    if (!apiKey) {
      console.warn(`[InferenceService] No API key available for provider "${provider}", skipping whisper generation`);
      return null;
    }

    // Build context from memory system
    const memoryContext = await this.retrieval.buildContext(userId, recentTranscript);

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
    const userContent = `${memoryContext}${skillsContext}\n## Recent Transcript\n${recentTranscript}\n\nBased on this conversation, generate a whisper insight if appropriate. Return JSON: { "type": "insight|action|warning|memory", "content": "...", "detail": "optional detail", "confidence": 0.0-1.0 } or { "skip": true } if nothing useful to say.`;

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
          temperature: 0.5,
          max_tokens: 300,
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
            max_tokens: 300,
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
              generationConfig: { maxOutputTokens: 300 },
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
      return {
        type: parsed.type || 'insight',
        content: parsed.content || '',
        detail: parsed.detail,
        confidence: parsed.confidence,
      };
    } catch {
      return null;
    }
  }
}
