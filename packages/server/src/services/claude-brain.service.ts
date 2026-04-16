/**
 * Claude Code Brain — Anthropic Claude as the AI engine for Code mode.
 *
 * Mirrors the RealtimeService interface but uses Claude Messages API
 * with local conversation history management.
 */

const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-20250514';
const MAX_HISTORY = 50;
const RESPONSE_TIMEOUT_MS = 30000;
const SAFETY_TIMEOUT_MS = 45000; // Fallback unstick if abort doesn't work

interface ClaudeBrainWhisper {
  type: string;
  content: string;
  detail?: string;
  confidence?: number;
  action?: 'save_memory' | 'web_search' | 'code_task';
  actionData?: Record<string, unknown>;
}

interface ClaudeBrainConfig {
  apiKey: string;
  instructions: string;
  ownerLanguage?: string;
  mode?: string;
  onWhisper: (whisper: ClaudeBrainWhisper) => void;
  onError?: (error: string) => void;
  onStatus?: (status: 'connected' | 'reconnecting' | 'disconnected' | 'error') => void;
}

const TOOLS = [
  {
    name: 'save_memory',
    description: 'Save a fact, preference, or piece of information to the user\'s long-term memory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The fact to save' },
        importance: { type: 'number', description: 'Importance 1-10' },
        category: { type: 'string', enum: ['fact', 'preference', 'person', 'event'] },
      },
      required: ['content'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for information the user asked about.',
    input_schema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'code_task',
    description: 'Send a coding task to the user\'s Claude Code instance. Use when the user asks you to write code, build something, fix a bug, or do any coding work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: { type: 'string', description: 'The coding task description' },
        context: { type: 'string', description: 'Relevant conversation context' },
        project: { type: 'string', description: 'Project name to run in (auto-detected if not specified)' },
      },
      required: ['prompt'],
    },
  },
];

type MessageContent = string | Array<{ type: string; [key: string]: unknown }>;
interface AnthropicMessage { role: 'user' | 'assistant'; content: MessageContent; }

export class ClaudeCodeBrain {
  private config: ClaudeBrainConfig;
  private messages: AnthropicMessage[] = [];
  private linesSinceLastResponse = 0;
  private triggerThreshold = 2;
  private responseInProgress = false;
  private requestGeneration = 0; // Tracks which request is active (prevents stale abort resets)
  private ownerLanguage: string;
  private abortController: AbortController | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private _isConnected = false;

  constructor(config: ClaudeBrainConfig) {
    this.config = config;
    this.ownerLanguage = config.ownerLanguage || 'English';
  }

  get isConnected(): boolean { return this._isConnected; }
  get instructions(): string { return this.config.instructions; }

  async connect(): Promise<void> {
    if (!this.config.apiKey) throw new Error('No Anthropic API key provided');
    this._isConnected = true;
    this.config.onStatus?.('connected');
    console.log(`[ClaudeBrain] Ready with model ${CLAUDE_MODEL}`);
  }

  /** Feed a transcript line. Auto-triggers at threshold. */
  feedTranscript(line: string): void {
    if (!this._isConnected) return;

    // Batch consecutive user string messages
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string') {
      last.content += '\n' + line;
    } else {
      this.messages.push({ role: 'user', content: line });
    }
    if (this.messages.length > MAX_HISTORY) this.messages = this.messages.slice(-MAX_HISTORY);

    this.linesSinceLastResponse++;
    if (this.linesSinceLastResponse >= this.triggerThreshold && !this.responseInProgress) {
      this.triggerResponse();
    }
  }

  /** Force an immediate response (text message, angel:activate). */
  forceRespond(): void {
    if (!this._isConnected) return;
    // Abort any in-flight request
    this.abortCurrentRequest();
    this.triggerResponse();
  }

  /** Synchronously lock + trigger async response. */
  private triggerResponse(): void {
    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;
    this.requestGeneration++;
    const gen = this.requestGeneration;
    this.startSafetyTimeout();
    this.requestResponse(gen);
  }

  /** Abort the current in-flight request cleanly. */
  private abortCurrentRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // Don't reset responseInProgress here — triggerResponse will set it
  }

  updateInstructions(instructions: string): void { this.config.instructions = instructions; }

  async close(): Promise<void> {
    this.abortCurrentRequest();
    this.clearSafetyTimeout();
    this._isConnected = false;
    this.messages = [];
    this.linesSinceLastResponse = 0;
    this.responseInProgress = false;
    this.config.onStatus?.('disconnected');
    console.log('[ClaudeBrain] Closed');
  }

  /** Safety timeout — unstick responseInProgress if everything else fails. */
  private startSafetyTimeout(): void {
    this.clearSafetyTimeout();
    this.safetyTimer = setTimeout(() => {
      if (this.responseInProgress) {
        console.warn('[ClaudeBrain] Safety timeout — releasing responseInProgress after 45s');
        this.responseInProgress = false;
      }
    }, SAFETY_TIMEOUT_MS);
  }

  private clearSafetyTimeout(): void {
    if (this.safetyTimer) { clearTimeout(this.safetyTimer); this.safetyTimer = null; }
  }

  /** Main response flow. Generation counter prevents stale resets. */
  private async requestResponse(gen: number): Promise<void> {
    if (this.messages.length === 0) { this.responseInProgress = false; this.clearSafetyTimeout(); return; }

    // Embed language reminder in the last user message (not a separate message)
    const langRule = `[RULE: Write all "content" in ${this.ownerLanguage} ONLY. Respond with JSON whisper or {"skip":true}. For coding, call code_task.]`;
    const lastUserIdx = this.messages.length - 1;
    const lastMsg = this.messages[lastUserIdx];
    let messagesForAPI: AnthropicMessage[];

    if (lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
      // Append reminder to existing last user message (no phantom message)
      messagesForAPI = [...this.messages];
      messagesForAPI[lastUserIdx] = { role: 'user', content: lastMsg.content + '\n' + langRule };
    } else {
      messagesForAPI = [...this.messages, { role: 'user', content: langRule }];
    }

    // Create abort controller for this request chain
    this.abortController = new AbortController();

    try {
      const data = await this.callAPI(messagesForAPI);
      if (!data || gen !== this.requestGeneration) { this.finishRequest(gen); return; }

      // Separate text blocks and tool_use blocks
      const contentBlocks = data.content || [];
      const toolUses = contentBlocks.filter((b: any) => b.type === 'tool_use');
      const hasToolUse = toolUses.length > 0;

      // Push the full assistant response (text + tool_use as one message)
      this.messages.push({ role: 'assistant', content: contentBlocks });

      // Emit text whispers
      for (const block of contentBlocks) {
        if (block.type === 'text' && block.text) {
          this.parseAndEmitWhisper(block.text);
        }
      }

      // Handle tool use — send tool_result and get follow-up
      if (hasToolUse) {
        for (const tu of toolUses) {
          this.emitToolWhisper(tu.name, tu.input);
        }

        // Build tool_result response (user message with content blocks)
        const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = toolUses.map((tu: any) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: 'Tool executed successfully.',
        }));
        this.messages.push({ role: 'user', content: toolResults });

        // Follow-up call — create new abort controller
        this.abortController = new AbortController();
        const followUp = await this.callAPI(this.messages);
        if (followUp && gen === this.requestGeneration) {
          const followUpBlocks = followUp.content || [];
          // Only push if there's actual content to avoid empty assistant messages
          if (followUpBlocks.length > 0) {
            this.messages.push({ role: 'assistant', content: followUpBlocks });
            for (const block of followUpBlocks) {
              if (block.type === 'text' && block.text) {
                this.parseAndEmitWhisper(block.text);
              }
            }
          }
        }
      }

      this.finishRequest(gen);
    } catch (err: any) {
      if (gen !== this.requestGeneration) return; // Stale request — ignore
      this.finishRequest(gen);
      if (err?.name !== 'AbortError') {
        console.error('[ClaudeBrain] Request failed:', err?.message);
        this.config.onError?.(err?.message || 'Claude API request failed');
      }
    }
  }

  /** Release responseInProgress only if this is still the active generation. */
  private finishRequest(gen: number): void {
    if (gen === this.requestGeneration) {
      this.responseInProgress = false;
      this.clearSafetyTimeout();
    }
  }

  /** Call Anthropic Messages API. */
  private async callAPI(messages: AnthropicMessage[]): Promise<any> {
    if (!this.abortController) this.abortController = new AbortController();
    const timeoutId = setTimeout(() => this.abortController?.abort(), RESPONSE_TIMEOUT_MS);

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          temperature: 0.6,
          system: this.config.instructions,
          tools: TOOLS,
          messages,
        }),
        signal: this.abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeBrain] API ${response.status}: ${errBody.slice(0, 200)}`);
        this.config.onError?.(`Claude API ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private parseAndEmitWhisper(text: string): void {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.skip) return;
      if (parsed.type && parsed.content) {
        this.config.onWhisper({ type: parsed.type, content: parsed.content, detail: parsed.detail, confidence: parsed.confidence });
      }
    } catch {
      if (text.trim() && !text.includes('"skip"')) {
        this.config.onWhisper({ type: 'response', content: text.trim().slice(0, 200) });
      }
    }
  }

  private emitToolWhisper(name: string, input: any): void {
    const typeMap: Record<string, string> = { save_memory: 'memory_saved', web_search: 'search', code_task: 'code' };
    const contentMap: Record<string, string> = {
      save_memory: `Saved: ${input?.content || ''}`,
      web_search: `Searching: ${input?.query || ''}`,
      code_task: `Coding: ${input?.prompt || ''}`,
    };
    this.config.onWhisper({ type: typeMap[name] || name, content: contentMap[name] || name, action: name as any, actionData: input });
  }
}
