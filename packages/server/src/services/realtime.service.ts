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
  onWhisper: (whisper: RealtimeWhisper) => void;
  onError?: (error: string) => void;
  onStatus?: (status: 'connected' | 'reconnecting' | 'disconnected') => void;
}

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
// Trigger a response after this many new transcript lines
const TRANSCRIPT_TRIGGER_THRESHOLD = 3;

export class RealtimeService {
  private ws: WebSocket | null = null;
  private config: RealtimeConfig;
  private sessionActive = false;
  private reconnectAttempts = 0;
  private reconnecting = false;
  private pendingTranscript: string[] = [];
  private linesSinceLastResponse = 0;
  private responseInProgress = false;
  private currentResponseText = '';

  constructor(config: RealtimeConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sessionActive = true;

      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      });

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          reject(new Error('Realtime connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        console.log('[Realtime] Connected to OpenAI Realtime API');
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
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[Realtime] Connection closed: ${code} ${reason}`);
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
    this.send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: this.config.instructions,
        temperature: 0.3,
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
      this.requestResponse();
    }
  }

  /**
   * Request the model to analyze recent conversation and respond.
   */
  requestResponse(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.responseInProgress) return;

    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;
    this.currentResponseText = '';

    this.send({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: 'Analyze the recent transcript. Respond with a JSON whisper if you have something useful. Return {"skip":true} if nothing to add. ALWAYS respond with valid JSON only.',
      },
    });
  }

  /**
   * Force an immediate response (angel:activate).
   */
  forceRespond(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Cancel any in-progress response
    if (this.responseInProgress) {
      this.send({ type: 'response.cancel' });
      this.responseInProgress = false;
    }

    this.currentResponseText = '';
    this.responseInProgress = true;
    this.linesSinceLastResponse = 0;

    this.send({
      type: 'response.create',
      response: {
        modalities: ['text'],
        instructions: 'The user just activated you. Analyze ALL recent transcript and provide a helpful response. You MUST respond with something useful — do NOT skip. Return valid JSON only.',
      },
    });
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
   * Handle incoming events from the Realtime API.
   */
  private handleEvent(event: any): void {
    switch (event.type) {
      case 'session.created':
        console.log('[Realtime] Session created:', event.session?.id);
        // Flush any pending transcript
        for (const line of this.pendingTranscript) {
          this.feedTranscript(line);
        }
        this.pendingTranscript = [];
        break;

      case 'session.updated':
        console.log('[Realtime] Session updated');
        break;

      case 'response.text.delta':
        this.currentResponseText += event.delta || '';
        break;

      case 'response.text.done':
        this.currentResponseText = event.text || this.currentResponseText;
        break;

      case 'response.function_call_arguments.done':
        // Function call completed — handle it
        this.handleFunctionCall(event.name, event.arguments);
        break;

      case 'response.done':
        this.responseInProgress = false;
        if (this.currentResponseText) {
          this.parseAndEmitWhisper(this.currentResponseText);
          this.currentResponseText = '';
        }
        break;

      case 'error':
        console.error('[Realtime] API error:', event.error);
        this.responseInProgress = false;
        this.config.onError?.(event.error?.message || 'Realtime API error');
        break;

      case 'rate_limits.updated':
        // Informational, ignore
        break;

      default:
        // Log unexpected events for debugging
        if (!event.type?.startsWith('response.') && !event.type?.startsWith('conversation.')) {
          console.log(`[Realtime] Unhandled event: ${event.type}`);
        }
    }
  }

  /**
   * Handle a function call from the model.
   */
  private handleFunctionCall(name: string, argsJson: string): void {
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

      // Send function output back to the model
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: name, // Simplified — in production, track actual call_id
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
    try {
      // Extract JSON from potential markdown code blocks
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.skip) return;

      this.config.onWhisper({
        type: parsed.type || 'insight',
        content: parsed.content || '',
        detail: parsed.detail,
        confidence: parsed.confidence,
        action: parsed.action,
        actionData: parsed.actionData,
      });
    } catch {
      // Not valid JSON — might be a plain text response
      if (text.trim() && !text.includes('"skip"')) {
        this.config.onWhisper({
          type: 'response',
          content: text.trim().slice(0, 200),
        });
      }
    }
  }

  private send(event: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting || !this.sessionActive) return;
    this.reconnecting = true;

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      if (!this.sessionActive) break;
      const delay = RECONNECT_DELAY_MS * Math.pow(2, i);
      console.log(`[Realtime] Reconnect attempt ${i + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));

      if (!this.sessionActive) break;
      try {
        await this.connect();
        this.reconnecting = false;
        this.reconnectAttempts = 0;
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
    this.pendingTranscript = [];
    this.linesSinceLastResponse = 0;
    this.responseInProgress = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Build the Angel system instructions from user presets + custom text.
 */
export function buildAngelInstructions(userInstructions: string): string {
  return `You are Angel, a personal AI companion listening to a live conversation through the user's AirPods. You provide real-time, proactive help.

## USER'S INSTRUCTIONS
${userInstructions}

## HOW TO RESPOND
You receive transcript lines labeled [Owner] (the user) and [Person A], [Person B], etc. (others).

When you detect something matching the user's instructions above, respond with a JSON object:
- Definition/jargon: { "type": "definition", "content": "TERM — explanation" }
- Direct response: { "type": "response", "content": "your answer" }
- Insight: { "type": "insight", "content": "observation" }
- Action item: { "type": "action", "content": "action to take" }
- Warning: { "type": "warning", "content": "watch out for..." }

If the owner speaks directly to you ("Angel, remember...", "Angel, search...", "Hey Angel..."), ALWAYS respond:
- Memory save: call the save_memory function
- Web search: call the web_search function
- Question: { "type": "response", "content": "answer" }

If nothing useful to say, respond: { "skip": true }

## RULES
- ALWAYS return valid JSON only — no markdown, no explanation, just the JSON object
- Be concise: 1-2 sentences max
- Never repeat yourself
- Prioritize the user's instructions above`;
}
