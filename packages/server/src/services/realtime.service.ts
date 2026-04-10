/**
 * OpenAI Realtime API service for Angel AI.
 *
 * Maintains a persistent WebSocket connection to OpenAI's Realtime API.
 * Receives transcript text, analyzes it based on user instructions,
 * and emits whisper cards when it has something useful to say.
 *
 * Text-only mode — no audio in/out (yet).
 */
import WebSocket from 'ws';

interface RealtimeWhisper {
  type: string;
  content: string;
  detail?: string;
  confidence?: number;
  action?: 'save_memory' | 'web_search';
  actionData?: Record<string, unknown>;
}

interface RealtimeConfig {
  apiKey: string;
  instructions: string;
  ownerLanguage?: string;
  onWhisper: (whisper: RealtimeWhisper) => void;
  onError?: (error: string) => void;
  onStatus?: (status: 'connected' | 'reconnecting' | 'disconnected' | 'error') => void;
}

// Use the full model — mini may not support text-only realtime well
const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
// Trigger a response after this many new transcript lines
const TRANSCRIPT_TRIGGER_THRESHOLD = 3;
// Safety timeout to unstick responseInProgress if response.done never arrives
const RESPONSE_TIMEOUT_MS = 15000;

export class RealtimeService {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private sessionActive = false;
  private reconnecting = false;
  private pendingTranscript: string[] = [];
  private linesSinceLastResponse = 0;
  private responseInProgress = false;
  private currentResponseText = '';
  private responseTimeout: ReturnType<typeof setTimeout> | null = null;
  private sessionConfigured = false;
  private ownerLanguage = 'English';

  constructor(config: RealtimeConfig) {
    this.config = config;
    this.ownerLanguage = config.ownerLanguage || 'English';
  }

  /** Whether the Realtime session is connected and configured */
  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.sessionConfigured;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sessionActive = true;
      this.sessionConfigured = false;

      // Close any existing WebSocket to prevent orphaning on reconnect (Finding 3)
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
        this.ws = null;
      }

      console.log('[Realtime] Connecting to:', REALTIME_URL);
      console.log('[Realtime] API key present:', this.config.apiKey ? `${this.config.apiKey.substring(0, 5)}...` : 'MISSING');

      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          console.error('[Realtime] Connection timeout after 10s');
          this.ws?.close();
          reject(new Error('Realtime connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[Realtime] WebSocket OPEN — configuring session...');
        this.configureSession();
        this.config.onStatus?.('connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString());
          this.handleEvent(event);
        } catch (err) {
          console.warn('[Realtime] Failed to parse event:', err);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[Realtime] WebSocket error:', err.message);
        this.config.onError?.(err.message);
        this.config.onStatus?.('error');
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[Realtime] Connection closed: ${code} ${reason}`);
        this.sessionConfigured = false;
        if (this.sessionActive && !this.reconnecting) {
          this.config.onStatus?.('reconnecting');
          this.attemptReconnect();
        }
      });
    });
  }

  /**
   * Configure the Realtime session with user instructions and tools.
   */
  private configureSession(): void {
    console.log('[Realtime] Sending session.update with instructions length:', this.config.instructions.length);
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: this.config.instructions,
        temperature: 0.6,
        max_response_output_tokens: 300,
        tools: [
          {
            type: 'function',
            name: 'save_memory',
            description: 'Save a fact, preference, or piece of information to the user\'s long-term memory.',
            parameters: {
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
            type: 'function',
            name: 'web_search',
            description: 'Search the web for information the user asked about.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
              },
              required: ['query'],
            },
          },
        ],
        tool_choice: 'auto',
        turn_detection: null, // We control when to trigger responses
      },
    });
  }

  /**
   * Feed a new transcript line into the conversation.
   * Automatically triggers a response after enough new lines.
   */
  feedTranscript(line: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingTranscript.push(line);
      // Cap buffer to prevent unbounded growth during prolonged disconnection
      if (this.pendingTranscript.length > 100) {
        this.pendingTranscript = this.pendingTranscript.slice(-60);
      }
      return;
    }

    // Add transcript as a user message
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: line }],
      },
    });

    this.linesSinceLastResponse++;

    // Auto-trigger response after threshold
    if (this.linesSinceLastResponse >= TRANSCRIPT_TRIGGER_THRESHOLD && !this.responseInProgress) {
      console.log(`[Realtime] Triggering auto-response after ${this.linesSinceLastResponse} lines`);
      this.requestResponse();
    }
  }

  /**
   * Request the model to analyze recent conversation and respond.
   */
  requestResponse(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.responseInProgress || !this.sessionConfigured) return;

    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;
    this.currentResponseText = '';
    this.startResponseTimeout();

    this.send({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: `CRITICAL: Your JSON "content" field MUST be written in ${this.ownerLanguage}. No exceptions — even if the conversation is in another language. Analyze the recent transcript. Respond with a JSON whisper if you have something useful. Return {"skip":true} if nothing to add. ALWAYS respond with valid JSON only.`,
      },
    });
  }

  /**
   * Force an immediate response (angel:activate).
   */
  forceRespond(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionConfigured) {
      console.warn('[Realtime] forceRespond called but WS not ready (open:', this.ws?.readyState === WebSocket.OPEN, 'configured:', this.sessionConfigured, ')');
      return;
    }

    // Cancel any in-progress response and bump generation so stale
    // response.done from the cancelled response is ignored.
    if (this.responseInProgress) {
      this.send({ type: 'response.cancel' });
      this.responseInProgress = false;
      this.clearResponseTimeout();
    }

    this.currentResponseText = '';
    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;
    this.startResponseTimeout();

    this.send({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: `CRITICAL: Your JSON "content" field MUST be written in ${this.ownerLanguage}. No exceptions — even if the conversation is in another language. The user just activated you. Analyze ALL recent transcript and provide a helpful response. You MUST respond with something useful — do NOT skip. Return valid JSON only.`,
      },
    });
  }

  /** Get the current system instructions. */
  get instructions(): string {
    return this.config.instructions;
  }

  /**
   * Update the session instructions (e.g., user changed their Angel Instructions).
   */
  updateInstructions(instructions: string): void {
    this.config.instructions = instructions;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({
        type: 'session.update',
        session: { instructions },
      });
    }
  }

  /**
   * Safety timeout: if response.done never arrives, unstick responseInProgress.
   */
  private startResponseTimeout(): void {
    this.clearResponseTimeout();
    this.responseTimeout = setTimeout(() => {
      if (this.responseInProgress) {
        console.warn('[Realtime] Response timeout — unsticking responseInProgress');
        this.responseInProgress = false;
        this.currentResponseText = '';
      }
    }, RESPONSE_TIMEOUT_MS);
  }

  private clearResponseTimeout(): void {
    if (this.responseTimeout) {
      clearTimeout(this.responseTimeout);
      this.responseTimeout = null;
    }
  }

  /**
   * Handle incoming events from the Realtime API.
   */
  private handleEvent(event: any): void {
    switch (event.type) {
      case 'session.created':
        console.log('[Realtime] Session created:', event.session?.id);
        break;

      case 'session.updated':
        console.log('[Realtime] Session configured successfully');
        this.sessionConfigured = true;
        // Flush pending transcript now that session is fully configured with instructions
        if (this.pendingTranscript.length > 0) {
          const pending = this.pendingTranscript;
          this.pendingTranscript = [];
          for (const line of pending) {
            this.feedTranscript(line);
          }
        }
        break;

      case 'response.created':
        console.log('[Realtime] Response started');
        break;

      case 'response.text.delta':
        this.currentResponseText += event.delta || '';
        break;

      case 'response.text.done':
        console.log('[Realtime] Response text complete, length:', (event.text || this.currentResponseText).length);
        this.currentResponseText = event.text || this.currentResponseText;
        break;

      case 'response.function_call_arguments.done':
        // Function call completed — handle it
        console.log('[Realtime] Function call:', event.name, 'call_id:', event.call_id);
        this.handleFunctionCall(event.name, event.arguments, event.call_id);
        break;

      case 'response.done': {
        // If this response was cancelled (status=cancelled), ignore it entirely
        // to prevent stale data from a cancelled response stomping a new one.
        if (event.response?.status === 'cancelled') {
          console.log('[Realtime] Ignoring cancelled response.done');
          break;
        }
        this.clearResponseTimeout();
        this.responseInProgress = false;
        console.log('[Realtime] Response done. Text length:', this.currentResponseText.length,
          'Status:', event.response?.status, 'Output items:', event.response?.output?.length || 0);
        if (this.currentResponseText) {
          this.parseAndEmitWhisper(this.currentResponseText);
          this.currentResponseText = '';
        }
        break;
      }

      case 'error':
        console.error('[Realtime] API error:', JSON.stringify(event.error));
        this.clearResponseTimeout();
        this.responseInProgress = false;
        this.config.onError?.(event.error?.message || 'Realtime API error');
        break;

      case 'rate_limits.updated':
        // Informational, ignore
        break;

      default:
        // Log ALL events for debugging until we're stable
        console.log(`[Realtime] Event: ${event.type}`);
    }
  }

  /**
   * Handle a function call from the model.
   */
  private handleFunctionCall(name: string, argsJson: string, callId: string): void {
    try {
      const args = JSON.parse(argsJson);

      if (name === 'save_memory' || name === 'web_search') {
        this.config.onWhisper({
          type: name === 'save_memory' ? 'memory_saved' : 'search',
          content: name === 'save_memory'
            ? `Saved: ${args.content}`
            : `Searching: ${args.query}`,
          action: name,
          actionData: args,
        });
      }

      // Send function output back to the model using the actual call_id
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ success: true }),
        },
      });
    } catch (err) {
      console.error('[Realtime] Failed to parse function call:', err);
    }
  }

  /**
   * Parse model text output as a whisper JSON and emit it.
   */
  private parseAndEmitWhisper(text: string): void {
    console.log('[Realtime] Parsing whisper from:', text.substring(0, 100));
    try {
      // Extract JSON from potential markdown code blocks.
      // Use greedy match so nested braces (e.g. {"content":"Consider {value}"})
      // are captured in full rather than truncated at the first closing brace.
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.skip) {
          console.log('[Realtime] Model returned skip');
          return;
        }

        console.log('[Realtime] Emitting whisper:', parsed.type, parsed.content?.substring(0, 50));
        this.config.onWhisper({
          type: parsed.type || 'insight',
          content: parsed.content || '',
          detail: parsed.detail,
          confidence: parsed.confidence,
          action: parsed.action,
          actionData: parsed.actionData,
        });
        return;
      }

      // No JSON found — emit as plain text whisper
      this.emitPlainTextWhisper(text);
    } catch {
      // JSON.parse failed — emit as plain text
      this.emitPlainTextWhisper(text);
    }
  }

  private emitPlainTextWhisper(text: string): void {
    const trimmed = text.trim();
    if (trimmed && !trimmed.includes('"skip"')) {
      console.log('[Realtime] Emitting plain text whisper, length:', trimmed.length);
      this.config.onWhisper({
        type: 'insight',
        content: trimmed.slice(0, 500),
      });
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    } else {
      console.warn('[Realtime] Tried to send but WS not open:', event.type);
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || !this.sessionActive) return;
    this.reconnecting = true;

    // Close existing WebSocket to prevent orphaning
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
      this.ws = null;
    }

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      if (!this.sessionActive) break;
      const delay = RECONNECT_DELAY_MS * Math.pow(2, i);
      console.log(`[Realtime] Reconnect attempt ${i + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));

      if (!this.sessionActive) break;
      try {
        await this.connect();
        this.reconnecting = false;
        return;
      } catch (err) {
        console.error(`[Realtime] Reconnect attempt ${i + 1} failed:`, err);
      }
    }

    this.reconnecting = false;
    this.config.onStatus?.('disconnected');
    console.error('[Realtime] All reconnect attempts failed');
  }

  async close(): Promise<void> {
    this.sessionActive = false;
    this.sessionConfigured = false;
    this.pendingTranscript = [];
    this.linesSinceLastResponse = 0;
    this.responseInProgress = false;
    this.clearResponseTimeout();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Build the Angel system instructions from user presets + custom text.
 */
export function buildAngelInstructions(userInstructions: string, ownerLanguage = 'English', memoryContext = ''): string {
  const memorySection = memoryContext.trim()
    ? `\n\n## WHAT YOU REMEMBER ABOUT THE USER\n${memoryContext.trim()}`
    : '';

  return `⚠️ LANGUAGE: You MUST write ALL responses in ${ownerLanguage}. Never respond in any other language.

You are Angel, the user's personal AI assistant. You are a SILENT THIRD-PARTY OBSERVER — you are NOT a participant in the conversation. You listen to a live conversation through the user's AirPods and provide helpful guidance privately to the user only.

## YOUR ROLE
- You are reading a live transcript of a conversation between the Owner (your user) and other people
- You are like a coach whispering in the user's ear — you NEVER roleplay as, impersonate, or speak on behalf of anyone in the conversation
- You observe from a 3rd-person perspective and provide insights, translations, and guidance TO the user
- You are NOT part of the conversation — never say "I agree" or respond as if someone is talking to you (unless the Owner says "Angel,...")
- The Owner's language is ${ownerLanguage} — ALL your "content" values MUST be in ${ownerLanguage}, no matter what language is spoken

## USER'S INSTRUCTIONS
${userInstructions}

## HOW TO RESPOND
You receive transcript lines labeled [Owner] (the user) and [Person A], [Person B], etc. (others).

When you detect something useful based on the user's instructions, respond with a JSON object:
- Translation: { "type": "translation", "content": "[Speaker] said: [${ownerLanguage} translation]" }
- Definition/jargon: { "type": "definition", "content": "TERM — explanation" }
- Insight/guidance: { "type": "insight", "content": "observation or suggestion for the Owner" }
- Action item: { "type": "action", "content": "action to take" }
- Warning: { "type": "warning", "content": "watch out for..." }
- Direct answer: { "type": "response", "content": "your answer" }

If the Owner speaks directly to you ("Angel, remember...", "Angel, search...", "Hey Angel..."), ALWAYS respond:
- Memory save: call the save_memory function
- Web search: call the web_search function
- Question: { "type": "response", "content": "answer" }
- Behavioral command (e.g. "Angel, be more concise", "Angel, translate everything", "Angel, explain jargons"): acknowledge with { "type": "response", "content": "Got it, [brief confirmation]" } and adjust your behavior for all subsequent responses

If nothing useful to say, respond: { "skip": true }

## CRITICAL: LANGUAGE RULE
Your "content" field MUST ALWAYS be written in ${ownerLanguage}. Even if the conversation is in Chinese, Spanish, or any other language, your JSON "content" value must be in ${ownerLanguage}. No exceptions.

## OTHER RULES
- You are a 3rd-party observer — NEVER roleplay as or impersonate anyone in the conversation
- Your output MUST be a single JSON object — no plain text, no markdown, no explanation
- Be concise: 1-2 sentences max in the "content" field
- Never repeat yourself
- Prioritize the user's instructions above all else
- Only respond when you have genuinely useful information${memorySection}`;
}
