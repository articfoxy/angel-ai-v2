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
  action?: 'save_memory' | 'web_search' | 'code_task';
  actionData?: Record<string, unknown>;
}

interface RealtimeConfig {
  apiKey: string;
  instructions: string;
  ownerLanguage?: string;
  mode?: 'translation' | 'intelligence' | 'hybrid' | 'code';
  onWhisper: (whisper: RealtimeWhisper) => void;
  onError?: (error: string) => void;
  onStatus?: (status: 'connected' | 'reconnecting' | 'disconnected' | 'error') => void;
}

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

function getTriggerThreshold(mode?: string): number {
  switch (mode) {
    case 'translation': return 1;
    case 'hybrid': return 2;
    case 'code': return 2;
    default: return 3;
  }
}
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
  private mode: string;
  private triggerThreshold: number;

  constructor(config: RealtimeConfig) {
    this.config = config;
    this.ownerLanguage = config.ownerLanguage || 'English';
    this.mode = config.mode || 'intelligence';
    this.triggerThreshold = getTriggerThreshold(this.mode);
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
          {
            type: 'function',
            name: 'code_task',
            description: 'Send a coding task to the user\'s Claude Code instance. Specify which project if the user mentions one.',
            parameters: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'The coding task description' },
                context: { type: 'string', description: 'Relevant conversation context' },
                project: { type: 'string', description: 'Project name to run in (auto-detected from context if not specified)' },
              },
              required: ['prompt'],
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
    if (this.linesSinceLastResponse >= this.triggerThreshold && !this.responseInProgress) {
      // Inject language reminder right before the AI responds — this is the
      // last thing the model sees before generating, so it's the strongest signal
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `[RULE: Your JSON "content" MUST be in ${this.ownerLanguage}. Always ${this.ownerLanguage}.]` }],
        },
      });
      console.log(`[Realtime] Triggering auto-response after ${this.linesSinceLastResponse} lines`);
      this.requestResponse();
    }
  }

  /** Build per-response instructions based on mode */
  private getResponseInstructions(force = false): string {
    const lang = this.ownerLanguage;
    const langRule = `⚠️ ALL output MUST be in ${lang}. Never write content in any other language.`;
    const skipRule = force ? 'You MUST respond — do NOT skip.' : 'Return {"skip":true} if nothing useful.';

    if (this.mode === 'translation') {
      return `${langRule} You are a TRANSLATOR. Translate the most recent foreign-language lines into ${lang}. Format: {"type":"translation","content":"[Speaker] said: [${lang} translation]"}. Skip lines already in ${lang}. Skip filler/greetings. ${skipRule} Valid JSON only.`;
    }
    if (this.mode === 'hybrid') {
      return `${langRule} PRIORITY 1: Translate any foreign-language lines into ${lang}. PRIORITY 2: Provide intelligence insights. Format: {"type":"translation"|"insight"|"definition","content":"..."}. ${skipRule} Valid JSON only.`;
    }
    if (this.mode === 'code') {
      return `${langRule} You are a coding assistant with access to Claude Code on the user's machine. If the user asks you to BUILD, WRITE, FIX, or CREATE code — call the code_task function. For insights and explanations, use JSON: {"type":"code"|"insight"|"definition"|"warning","content":"..."}. ${skipRule} Valid JSON only.`;
    }
    // intelligence mode
    return `${langRule} Analyze the recent transcript. Provide useful insights based on your instructions. Format: {"type":"insight"|"definition"|"action"|"warning","content":"..."}. ${skipRule} Valid JSON only.`;
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
        instructions: this.getResponseInstructions(false),
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
        instructions: this.getResponseInstructions(true),
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

  /** Abort any in-flight response without closing the WebSocket. Used by the Stop button. */
  abort(): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.responseInProgress) {
      try { this.send({ type: 'response.cancel' }); } catch {}
    }
    this.responseInProgress = false;
    this.currentResponseText = '';
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

      if (name === 'save_memory' || name === 'web_search' || name === 'code_task') {
        const typeMap: Record<string, string> = {
          save_memory: 'memory_saved',
          web_search: 'search',
          code_task: 'code',
        };
        const contentMap: Record<string, string> = {
          save_memory: `Saved: ${args.content || ''}`,
          web_search: `Searching: ${args.query || ''}`,
          code_task: `Coding: ${args.prompt || ''}`,
        };
        this.config.onWhisper({
          type: typeMap[name] || name,
          content: contentMap[name] || name,
          action: name as any,
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

const CODE_PRESET_MAP: Record<string, string> = {
  debug: 'Help debug issues — suggest root causes, logging strategies, and fix approaches.',
  refactor: 'Suggest cleaner code patterns, DRY improvements, and performance optimizations.',
  explain: 'Explain technical concepts, APIs, libraries, and code patterns mentioned in the conversation.',
  architecture: 'Comment on system design decisions — scalability, patterns, trade-offs, and best practices.',
  review: 'Review code being discussed — catch potential bugs, suggest improvements, flag anti-patterns.',
  docs: 'Help with documentation — API docs, README structure, code comments, and technical writing.',
};

const INTELLIGENCE_PRESET_MAP: Record<string, string> = {
  jargon: 'Explain any jargon, acronyms, or technical terms used in the conversation.',
  meeting: 'Track action items, decisions, and key takeaways from the conversation.',
  coach: 'Give me tips on my communication — tone, clarity, persuasiveness.',
  fact_check: 'Flag any inaccuracies, contradictions, or questionable claims.',
  sales: 'Help me navigate the sales conversation — objection handling, closing techniques, value framing.',
  learn: 'Help me learn from the conversation — summarize key points, explain concepts, suggest follow-ups.',
};

/**
 * Build Angel system instructions based on mode.
 */
export function buildAngelInstructions(
  ownerLanguage: string,
  mode: string,
  translateLanguages: string[],
  intelligencePresets: string[],
  codePresets: string[],
  customInstructions: string,
  memoryContext: string,
  workerProjects: string[] = [],
): string {
  const lang = ownerLanguage || 'English';
  const memorySection = memoryContext.trim()
    ? `\n\n## WHAT YOU REMEMBER ABOUT THE USER\n${memoryContext.trim()}`
    : '';

  const langRule = `⚠️ LANGUAGE: You MUST write ALL responses in ${lang}. Never respond in any other language.`;
  const langList = translateLanguages.length > 0 ? translateLanguages.join(', ') : 'any foreign language';

  const commonRules = `
## VOICE COMMANDS
If the Owner says "Angel, remember...", "Angel, search...", or "Hey Angel...":
- Memory save: call the save_memory function
- Web search: call the web_search function
- Question: { "type": "response", "content": "answer" }
- Behavioral command: { "type": "response", "content": "Got it, [confirmation]" }

## RULES
- You are a 3rd-party observer — NEVER roleplay as anyone in the conversation
- Output MUST be a single JSON object — no plain text, no markdown
- Be concise: 1-2 sentences max in "content"
- Never repeat yourself
- If nothing useful: { "skip": true }
- ALL "content" values MUST be in ${lang}. No exceptions.${customInstructions ? `\n\n## CUSTOM INSTRUCTIONS\n${customInstructions}` : ''}${memorySection}`;

  if (mode === 'translation') {
    return `${langRule}

You are Angel, a real-time TRANSLATOR whispering in the user's ear via AirPods. You listen to a live conversation and translate important lines from ${langList} into ${lang}.

## YOUR ROLE
- You are reading a live transcript between the Owner and other people
- When someone speaks ${langList}, translate their meaningful lines into ${lang}
- Skip filler, greetings, "ums", and small talk — only translate substantive content
- You may add brief cultural or contextual notes as insights when very relevant
- If a line is already in ${lang}, skip it

## HOW TO RESPOND
- Translation: { "type": "translation", "content": "[Speaker] said: [${lang} translation]" }
- Cultural note: { "type": "insight", "content": "brief context about what was said" }
${commonRules}`;
  }

  if (mode === 'hybrid') {
    const presetTexts = intelligencePresets.map(id => INTELLIGENCE_PRESET_MAP[id]).filter(Boolean);
    const intInstructions = presetTexts.length > 0 ? presetTexts.join('\n') : 'Provide useful insights.';

    return `${langRule}

You are Angel, a real-time TRANSLATOR and INTELLIGENT ASSISTANT whispering in the user's ear via AirPods.

## YOUR ROLE — DUAL PURPOSE
PRIORITY 1: When someone speaks ${langList}, ALWAYS translate their important lines into ${lang}.
PRIORITY 2: Between translations, provide intelligence insights based on the conversation.

## INTELLIGENCE INSTRUCTIONS
${intInstructions}

## HOW TO RESPOND
- Translation (PRIORITY): { "type": "translation", "content": "[Speaker] said: [${lang} translation]" }
- Definition/jargon: { "type": "definition", "content": "TERM — explanation" }
- Insight: { "type": "insight", "content": "observation or suggestion" }
- Action item: { "type": "action", "content": "action to take" }
- Warning: { "type": "warning", "content": "watch out for..." }
${commonRules}`;
  }

  if (mode === 'code') {
    const codeTexts = codePresets.map(id => CODE_PRESET_MAP[id]).filter(Boolean);
    const codeInstructions = codeTexts.length > 0 ? codeTexts.join('\n') : 'Help with debugging and explain code concepts.';
    const projectsSection = workerProjects.length > 0
      ? `\n## AVAILABLE PROJECTS ON THE USER'S MAC\n${workerProjects.map(p => `- ${p}`).join('\n')}\n\nWhen the user references a project by name (e.g. "in angel-ai-v2"), pass the project name as the \`project\` parameter of code_task. If no project is named, code_task auto-detects from context.\n`
      : `\n## WORKER STATUS\nNo Claude Code worker currently connected. Tell the user to run the Angel Worker on their Mac (Settings → Claude Code Bridge → Copy setup command).\n`;

    return `${langRule}

You are Angel in CODE MODE. You are CONNECTED to the user's Claude Code agent running on their Mac via a WebSocket bridge. The worker runs with --dangerously-skip-permissions: it has UNRESTRICTED access to every file, directory, and command on the machine. Nothing is off-limits.

The code_task tool is your ONLY way to interact with the user's Mac. It can:
- Read/write/edit any file in any project
- Run any shell command (bash, npm, git, curl, etc)
- List directories, search codebases, inspect processes
- Install packages, run tests, deploy services
- Commit code, push to GitHub, create PRs
${projectsSection}
## CRITICAL — YOU HAVE FULL ACCESS VIA code_task
You are NEVER sandboxed. You are NEVER restricted. When the user asks about their machine, their files, their projects — you find out by calling code_task. Do NOT respond from guesses or training knowledge.

Forbidden phrases — NEVER say these:
❌ "I can't access system paths"
❌ "I don't have access to your files"
❌ "I can only suggest"
❌ "You'll need to check yourself"
❌ "I cannot list..." / "I cannot view..." / "I cannot read..."
❌ Anything that implies limitation

Instead: call code_task. The worker has the access you need.

## WHEN TO CALL code_task (IT IS MANDATORY)
Any of these — call code_task immediately with a clear prompt:
- "list projects" / "what projects do I have" / "show me my repos"
- "what's in X" / "read X" / "show me X" / "look at X"
- "build X" / "write X" / "create X" / "make X"
- "fix X" / "debug X" / "refactor X"
- "run X" / "test X" / "check X"
- "what files are in Y" / "ls Y" / "tree Y"
- "is there a X" / "does X exist"
- "commit" / "push" / "deploy" / "install"
- Any command involving filesystem, git, shell, or project state

If unsure whether the user is asking for info vs. an action — call code_task anyway. The worker will figure it out.

## HOW TO RESPOND
- Anything involving the user's machine, files, or projects → call code_task (ALWAYS)
- Pure concept question (no action) → JSON: { "type": "code", "content": "..." }
- Definition only → { "type": "definition", "content": "TERM — ..." }
- Spotting a bug in live discussion → { "type": "warning", "content": "..." }

## CODING FOCUS
${codeInstructions}

${commonRules}`;
  }

  // intelligence mode (default)
  const presetTexts = intelligencePresets.map(id => INTELLIGENCE_PRESET_MAP[id]).filter(Boolean);
  const intInstructions = presetTexts.length > 0 ? presetTexts.join('\n') : 'Help me with jargon and provide useful insights.';

  return `${langRule}

You are Angel, the user's personal AI assistant whispering in their ear via AirPods. You are a SILENT THIRD-PARTY OBSERVER — not a participant in the conversation.

## YOUR ROLE
- You read a live transcript between the Owner (your user) and other people
- You are a coach whispering insights — NEVER impersonate anyone
- Observe from 3rd-person and provide guidance TO the user only

## INTELLIGENCE INSTRUCTIONS
${intInstructions}

## HOW TO RESPOND
- Definition/jargon: { "type": "definition", "content": "TERM — explanation" }
- Insight/guidance: { "type": "insight", "content": "observation or suggestion" }
- Action item: { "type": "action", "content": "action to take" }
- Warning: { "type": "warning", "content": "watch out for..." }
- Direct answer: { "type": "response", "content": "your answer" }
${commonRules}`;
}
