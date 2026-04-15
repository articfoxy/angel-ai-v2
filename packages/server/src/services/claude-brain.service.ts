/**
 * Claude Code Brain — Anthropic Claude as the AI engine for Code mode.
 *
 * Mirrors the RealtimeService interface but uses Claude Messages API
 * with local conversation history management (stateless HTTP vs
 * OpenAI Realtime's stateful WebSocket).
 *
 * Used for Code mode. Falls back to RealtimeService if no Anthropic key.
 */

const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-20250514';
const MAX_HISTORY = 50; // Cap conversation messages to manage context
const RESPONSE_TIMEOUT_MS = 30000; // 30s timeout for Claude API calls

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

// Anthropic tool format
const TOOLS = [
  {
    name: 'save_memory',
    description: 'Save a fact, preference, or piece of information to the user\'s long-term memory.',
    input_schema: {
      type: 'object',
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
      type: 'object',
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
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The coding task description' },
        context: { type: 'string', description: 'Relevant conversation context' },
      },
      required: ['prompt'],
    },
  },
];

export class ClaudeCodeBrain {
  private config: ClaudeBrainConfig;
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
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

  get isConnected(): boolean {
    return this._isConnected;
  }

  /** Get current instructions (for prompt rebuild compatibility). */
  get instructions(): string {
    return this.config.instructions;
  }

  /** "Connect" — for Claude API this just validates the key and marks ready. */
  async connect(): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error('No Anthropic API key provided');
    }
    this._isConnected = true;
    this.config.onStatus?.('connected');
    console.log(`[ClaudeBrain] Ready with model ${CLAUDE_MODEL}`);
  }

  /** Feed a transcript line. Auto-triggers response on threshold. */
  feedTranscript(line: string): void {
    if (!this._isConnected) return;

    // Accumulate transcript as user messages
    // Batch consecutive user messages into one to keep history clean
    const last = this.messages[this.messages.length - 1];
    if (last?.role === 'user') {
      last.content += '\n' + line;
    } else {
      this.messages.push({ role: 'user', content: line });
    }

    // Cap history
    if (this.messages.length > MAX_HISTORY) {
      this.messages = this.messages.slice(-MAX_HISTORY);
    }

    this.linesSinceLastResponse++;

    if (this.linesSinceLastResponse >= this.triggerThreshold && !this.responseInProgress) {
      console.log(`[ClaudeBrain] Auto-response after ${this.linesSinceLastResponse} lines`);
      this.requestResponse();
    }
  }

  /** Force an immediate response (angel:activate or text message). */
  forceRespond(): void {
    if (!this._isConnected) return;
    if (this.responseInProgress) {
      // Cancel in-flight request
      this.abortController?.abort();
      this.responseInProgress = false;
    }
    this.requestResponse();
  }

  /** Update the system instructions mid-session. */
  updateInstructions(instructions: string): void {
    this.config.instructions = instructions;
  }

  /** Close and clean up. */
  async close(): Promise<void> {
    this.abortController?.abort();
    this._isConnected = false;
    this.messages = [];
    this.linesSinceLastResponse = 0;
    this.responseInProgress = false;
    this.config.onStatus?.('disconnected');
    console.log('[ClaudeBrain] Closed');
  }

  /** Send a request to Claude Messages API. */
  private async requestResponse(): Promise<void> {
    if (this.responseInProgress || this.messages.length === 0) return;
    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;

    const langRule = `CRITICAL: Write all "content" values in ${this.ownerLanguage} ONLY.`;

    // Add a language + response format reminder as the last user message
    const messagesWithReminder = [
      ...this.messages,
      {
        role: 'user' as const,
        content: `[SYSTEM: ${langRule} Respond with a JSON whisper if you have something useful, or {"skip":true}. For coding tasks, call the code_task tool. Valid JSON only.]`,
      },
    ];

    this.abortController = new AbortController();
    const timeout = setTimeout(() => this.abortController?.abort(), RESPONSE_TIMEOUT_MS);

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
          messages: messagesWithReminder,
        }),
        signal: this.abortController.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[ClaudeBrain] API error ${response.status}: ${errBody.slice(0, 200)}`);
        this.config.onError?.(`Claude API ${response.status}`);
        this.responseInProgress = false;
        return;
      }

      const data = (await response.json()) as any;
      this.responseInProgress = false;

      // Process response content blocks
      for (const block of data.content || []) {
        if (block.type === 'text') {
          // Add assistant response to history
          this.messages.push({ role: 'assistant', content: block.text });
          this.parseAndEmitWhisper(block.text);
        } else if (block.type === 'tool_use') {
          this.handleToolUse(block.name, block.input, block.id);
        }
      }
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

  /** Parse JSON whisper from Claude's text response. */
  private parseAndEmitWhisper(text: string): void {
    try {
      // Extract JSON from response (may have markdown wrapping)
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
      // Not valid JSON — Claude might have responded in plain text
      // Emit as a response whisper if it has content
      if (text.trim() && !text.includes('"skip"')) {
        this.config.onWhisper({
          type: 'response',
          content: text.trim().slice(0, 200),
        });
      }
    }
  }

  /** Handle tool use from Claude. */
  private handleToolUse(name: string, input: any, toolUseId: string): void {
    const typeMap: Record<string, string> = {
      save_memory: 'memory_saved',
      web_search: 'search',
      code_task: 'code',
    };
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

    // Add tool use + result to history so Claude has context
    this.messages.push({
      role: 'assistant',
      content: `[Used tool: ${name}(${JSON.stringify(input)})]`,
    });
  }
}
