/**
 * Claude Code Brain — Anthropic Claude as the AI engine for Code mode.
 *
 * Mirrors the RealtimeService interface but uses Claude Messages API
 * with local conversation history management (stateless HTTP vs
 * OpenAI Realtime's stateful WebSocket).
 */

const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-20250514';
const MAX_HISTORY = 50;
const RESPONSE_TIMEOUT_MS = 30000;

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

// Anthropic tool definitions
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
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
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
      },
      required: ['prompt'],
    },
  },
];

// Message type that supports both plain text and content blocks (Anthropic format)
type MessageContent = string | Array<{ type: string;[key: string]: unknown }>;
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: MessageContent;
}

export class ClaudeCodeBrain {
  private config: ClaudeBrainConfig;
  private messages: AnthropicMessage[] = [];
  private linesSinceLastResponse = 0;
  private triggerThreshold = 2;
  private responseInProgress = false;
  private ownerLanguage: string;
  private abortController: AbortController | null = null;
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

  /** Feed a transcript line. Auto-triggers response on threshold. */
  feedTranscript(line: string): void {
    if (!this._isConnected) return;

    // Batch consecutive user messages
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user' && typeof last.content === 'string') {
      last.content += '\n' + line;
    } else {
      this.messages.push({ role: 'user', content: line });
    }

    if (this.messages.length > MAX_HISTORY) {
      this.messages = this.messages.slice(-MAX_HISTORY);
    }

    this.linesSinceLastResponse++;

    // Gate synchronously BEFORE async call to prevent race condition
    if (this.linesSinceLastResponse >= this.triggerThreshold && !this.responseInProgress) {
      this.responseInProgress = true; // Set SYNCHRONOUSLY — prevents double-trigger
      this.linesSinceLastResponse = 0;
      console.log(`[ClaudeBrain] Auto-response triggered`);
      this.requestResponse();
    }
  }

  /** Force an immediate response. */
  forceRespond(): void {
    if (!this._isConnected) return;
    if (this.responseInProgress) {
      this.abortController?.abort();
    }
    this.responseInProgress = true; // Set SYNCHRONOUSLY
    this.linesSinceLastResponse = 0;
    this.requestResponse();
  }

  updateInstructions(instructions: string): void {
    this.config.instructions = instructions;
  }

  async close(): Promise<void> {
    this.abortController?.abort();
    this._isConnected = false;
    this.messages = [];
    this.linesSinceLastResponse = 0;
    this.responseInProgress = false;
    this.config.onStatus?.('disconnected');
    console.log('[ClaudeBrain] Closed');
  }

  /** Call Claude Messages API. Handles tool use with proper tool_result flow. */
  private async requestResponse(): Promise<void> {
    if (this.messages.length === 0) { this.responseInProgress = false; return; }

    const langRule = `CRITICAL: Write all "content" values in ${this.ownerLanguage} ONLY.`;

    // Build messages with a language reminder appended
    const apiMessages: AnthropicMessage[] = [
      ...this.messages,
      {
        role: 'user',
        content: `[SYSTEM: ${langRule} Respond with a JSON whisper if useful, or {"skip":true}. For coding tasks, call code_task. Valid JSON only.]`,
      },
    ];

    this.abortController = new AbortController();
    const timeout = setTimeout(() => this.abortController?.abort(), RESPONSE_TIMEOUT_MS);

    try {
      const data = await this.callAPI(apiMessages, timeout);
      if (!data) { this.responseInProgress = false; return; }

      // Process content blocks
      let hasText = false;
      const toolUses: Array<{ id: string; name: string; input: any }> = [];

      for (const block of data.content || []) {
        if (block.type === 'text' && block.text) {
          hasText = true;
          this.messages.push({ role: 'assistant', content: block.text });
          this.parseAndEmitWhisper(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      }

      // Handle tool use — send tool_result back and get Claude's follow-up
      if (toolUses.length > 0) {
        // Store assistant's response with tool_use blocks (proper Anthropic format)
        this.messages.push({
          role: 'assistant',
          content: data.content, // Keep the raw content blocks including tool_use
        });

        // Emit whispers for each tool use
        for (const tu of toolUses) {
          this.emitToolWhisper(tu.name, tu.input);
        }

        // Build tool_result response
        const toolResults = toolUses.map((tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: 'Tool executed successfully. Continue with your response.',
        }));

        // Send tool_result back to Claude for follow-up text
        this.messages.push({ role: 'user', content: toolResults as any });

        // Make follow-up call so Claude can respond with text after tool use
        const followUp = await this.callAPI(this.messages, null);
        if (followUp) {
          for (const block of followUp.content || []) {
            if (block.type === 'text' && block.text) {
              this.messages.push({ role: 'assistant', content: block.text });
              this.parseAndEmitWhisper(block.text);
            }
          }
        }
      }

      this.responseInProgress = false;
    } catch (err: any) {
      clearTimeout(timeout);
      this.responseInProgress = false;
      if (err?.name === 'AbortError') {
        console.log('[ClaudeBrain] Request aborted');
      } else {
        console.error('[ClaudeBrain] Request failed:', err?.message);
        this.config.onError?.(err?.message || 'Claude API request failed');
      }
    }
  }

  /** Low-level API call to Anthropic. Returns parsed JSON or null. */
  private async callAPI(messages: AnthropicMessage[], timeoutHandle: ReturnType<typeof setTimeout> | null): Promise<any> {
    const controller = timeoutHandle ? this.abortController! : new AbortController();
    const localTimeout = timeoutHandle ? null : setTimeout(() => controller.abort(), RESPONSE_TIMEOUT_MS);

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
          max_tokens: 500,
          temperature: 0.6,
          system: this.config.instructions,
          tools: TOOLS,
          messages,
        }),
        signal: controller.signal,
      });

      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (localTimeout) clearTimeout(localTimeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeBrain] API error ${response.status}: ${errBody.slice(0, 200)}`);
        this.config.onError?.(`Claude API ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (err: any) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (localTimeout) clearTimeout(localTimeout);
      throw err; // Re-throw for caller to handle
    }
  }

  /** Parse JSON whisper from Claude's text response. */
  private parseAndEmitWhisper(text: string): void {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.skip) return;
      if (parsed.type && parsed.content) {
        this.config.onWhisper({
          type: parsed.type,
          content: parsed.content,
          detail: parsed.detail,
          confidence: parsed.confidence,
        });
      }
    } catch {
      if (text.trim() && !text.includes('"skip"')) {
        this.config.onWhisper({ type: 'response', content: text.trim().slice(0, 200) });
      }
    }
  }

  /** Emit a whisper for a tool use action. */
  private emitToolWhisper(name: string, input: any): void {
    const typeMap: Record<string, string> = { save_memory: 'memory_saved', web_search: 'search', code_task: 'code' };
    const contentMap: Record<string, string> = {
      save_memory: `Saved: ${input?.content || ''}`,
      web_search: `Searching: ${input?.query || ''}`,
      code_task: `Coding: ${input?.prompt || ''}`,
    };
    this.config.onWhisper({
      type: typeMap[name] || name,
      content: contentMap[name] || name,
      action: name as any,
      actionData: input,
    });
  }
}
