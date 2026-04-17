import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';
import { DeepgramService } from './deepgram.service';
import { SearchService } from './search.service';
import { RealtimeService, buildAngelInstructions } from './realtime.service';
import { ExtractionService } from './memory/extraction.service';
import { runPostSessionReflection } from './memory/reflection.service';
import { RetrievalService } from './memory/retrieval.service';
import { PerplexityService } from './perplexity.service';
import { ClaudeCodeBrain } from './claude-brain.service';
import { codeWorkerHub } from './codeworker.service';
import { synthesizeCodeSummary } from './summarizer.service';
import { CartesiaTTSService } from './tts.service';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const MAX_SESSION_DURATION_MS = 7_200_000; // 2 hours
const IDLE_TIMEOUT_MS = 1_800_000; // 30 minutes — user may pause mic for extended periods in continuous-session UX
const ALLOWED_OWNER_LANGUAGES = ['English', 'Chinese', 'Malay', 'Spanish', 'French', 'Japanese', 'Korean', 'Hindi'];
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY || '';
const DEFAULT_VOICE_ID = process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

export function setupSocketHandlers(io: Server) {
  const search = new SearchService();

  // Auth middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string };
      if ((payload as any).type === 'refresh') {
        return next(new Error('Access token required'));
      }
      socket.userId = payload.userId;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    console.log(`Client connected: ${socket.userId}`);
    let deepgram: DeepgramService | null = null;
    let realtime: RealtimeService | ClaudeCodeBrain | null = null;
    let transcriptBuffer: string[] = [];
    let sessionTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let currentSessionId: string | null = null;
    let tts: CartesiaTTSService | null = null;
    let ttsPlaying = false; // Echo gate: true while TTS audio plays on client
    let ttsEchoTimer: ReturnType<typeof setTimeout> | null = null; // Safety timeout for echo gate
    let testTimer: ReturnType<typeof setTimeout> | null = null;
    let liveDirectives: string[] = [];
    let sessionOpenaiKey = '';
    let sessionAnthropicKey = '';
    let sessionOwnerLanguage = 'English';
    // Session config captured at start — needed to rebuild brain on mode switch
    let sessionMode: 'translation' | 'intelligence' | 'hybrid' | 'code' = 'intelligence';
    let sessionTranslateLanguages: string[] = [];
    let sessionIntPresets: string[] = [];
    let sessionCdPresets: string[] = [];
    let sessionCustomInstr = '';
    let sessionMemoryContext = '';
    let lastMemoryContext = ''; // Cached for atomic prompt rebuilds
    let transcriptsSinceMemoryRefresh = 0;
    const MEMORY_REFRESH_INTERVAL = 10;

    /** Atomically rebuild the Realtime AI prompt from base + memory + directives.
     *  If rebuildBase=true (e.g. worker projects changed), regenerates the base
     *  from scratch with the latest worker project list. */
    function rebuildInstructions(newMemoryContext?: string, rebuildBase = false) {
      if (!realtime) return;
      if (newMemoryContext !== undefined) lastMemoryContext = newMemoryContext;
      let base: string;
      if (rebuildBase && socket.userId) {
        const workerProjects = sessionMode === 'code' ? codeWorkerHub.getProjects(socket.userId) : [];
        base = buildAngelInstructions(
          sessionOwnerLanguage,
          sessionMode,
          sessionTranslateLanguages,
          sessionIntPresets,
          sessionCdPresets,
          sessionCustomInstr,
          '', // memory appended separately below
          workerProjects,
        );
      } else {
        // Get base instructions (everything before dynamic sections)
        base = realtime.instructions
          .split('\n\n## WHAT YOU REMEMBER')[0]
          .split('\n\n## LIVE DIRECTIVES')[0];
      }
      const mem = lastMemoryContext.trim()
        ? `\n\n## WHAT YOU REMEMBER ABOUT THE USER\n${lastMemoryContext.trim()}`
        : '';
      const dir = liveDirectives.length > 0
        ? '\n\n## LIVE DIRECTIVES (from the user during this session)\n' +
          liveDirectives.map((d, i) => `${i + 1}. ${d}`).join('\n')
        : '';
      realtime.updateInstructions(base + mem + dir);
    }

    // Subscribe to worker project-list changes — refresh brain's prompt when
    // a worker connects mid-session or updates its project list
    const unsubscribeProjects = codeWorkerHub.onProjectsChanged((uid) => {
      if (uid === socket.userId && sessionMode === 'code' && realtime) {
        console.log('[session] Worker projects changed — refreshing code-mode prompt');
        rebuildInstructions(undefined, true);
      }
    });

    /**
     * Switch Angel's mode mid-session while preserving short-term memory.
     * - Closes the old brain cleanly
     * - Creates a new brain of the correct type for the new mode
     * - Replays recent transcript into the new brain so it has context
     * - Notifies the client so UI updates
     */
    async function switchMode(newMode: 'translation' | 'intelligence' | 'hybrid' | 'code'): Promise<boolean> {
      if (newMode === sessionMode) return false; // No-op
      if (!socket.userId) return false;
      const oldMode = sessionMode;
      console.log(`[mode-switch] ${oldMode} → ${newMode}`);

      const openaiKey = sessionOpenaiKey;
      if (!openaiKey) { console.warn('[mode-switch] No OpenAI key'); return false; }

      // Tear down the current brain
      if (realtime) {
        try { await realtime.close(); } catch {}
        realtime = null;
      }

      sessionMode = newMode;
      const whisperHandler = (whisper: any) => { handleRealtimeWhisper(socket.userId!, whisper).catch((e) => console.error('[Brain] whisper err:', e)); };
      const errorHandler = (error: string) => console.error('[Brain] Error:', error);
      const statusHandler = (status: string) => { console.log(`[Brain] Status: ${status}`); socket.emit('realtime:status', { status }); };

      // Rebuild instructions for the new mode
      const workerProjects = newMode === 'code' ? codeWorkerHub.getProjects(socket.userId) : [];
      const newInstructions = buildAngelInstructions(
        sessionOwnerLanguage,
        newMode,
        sessionTranslateLanguages,
        sessionIntPresets,
        sessionCdPresets,
        sessionCustomInstr,
        sessionMemoryContext,
        workerProjects,
      );

      if (newMode === 'code' && sessionAnthropicKey) {
        realtime = new ClaudeCodeBrain({
          apiKey: sessionAnthropicKey,
          ownerLanguage: sessionOwnerLanguage,
          mode: newMode,
          instructions: newInstructions,
          onWhisper: whisperHandler,
          onError: errorHandler,
          onStatus: statusHandler as any,
        });
      } else {
        realtime = new RealtimeService({
          apiKey: openaiKey,
          ownerLanguage: sessionOwnerLanguage,
          mode: newMode,
          instructions: newInstructions,
          onWhisper: whisperHandler,
          onError: errorHandler,
          onStatus: statusHandler as any,
        });
      }

      try {
        await realtime.connect();
      } catch (err) {
        console.error('[mode-switch] connect failed:', err);
        realtime = null;
        return false;
      }

      // Replay last N transcripts so the new brain has short-term context
      const SHORT_TERM_LINES = 20;
      const recent = transcriptBuffer.slice(-SHORT_TERM_LINES);
      for (const line of recent) {
        try { realtime.feedTranscript(line); } catch {}
      }
      console.log(`[mode-switch] Replayed ${recent.length} lines into new brain`);

      // Rebuild live directives + memory into the new brain's instructions
      rebuildInstructions();

      // Tell the client
      socket.emit('mode:switched', { mode: newMode, from: oldMode });
      socket.emit('whisper', {
        id: uuid(),
        type: 'mode_switch',
        content: `🎛️ Switched to ${newMode.charAt(0).toUpperCase() + newMode.slice(1)} mode`,
        createdAt: new Date().toISOString(),
      });
      return true;
    }

    function clearAllTimers() {
      if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
      if (testTimer) { clearTimeout(testTimer); testTimer = null; }
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(async () => {
        console.log(`Session ${currentSessionId} idle timeout (${IDLE_TIMEOUT_MS / 1000}s with no transcript)`);
        socket.emit('session:timeout', {
          sessionId: currentSessionId,
          reason: 'idle',
          message: 'Session timed out due to inactivity',
        });
        await cleanupSession();
      }, IDLE_TIMEOUT_MS);
    }

    let angelProcessing = false; // Guard against concurrent angel:activate calls
    let angelThinkingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastActivateTime = 0; // Timestamp-based rate limit for angel:activate

    /**
     * Handle a whisper from the Realtime API — execute any actions and emit to client.
     */
    async function handleRealtimeWhisper(
      userId: string,
      whisper: { type: string; content: string; detail?: string; confidence?: number; action?: 'save_memory' | 'web_search' | 'code_task'; actionData?: Record<string, unknown> }
    ): Promise<void> {
      // Execute actions if the model returned a command
      if (whisper.action === 'save_memory' && whisper.actionData) {
        try {
          const memContent = String(whisper.actionData.content || whisper.content);
          const mem = await prisma.memory.create({
            data: {
              userId,
              content: memContent,
              importance: Number(whisper.actionData.importance) || 7,
              category: String(whisper.actionData.category || 'fact'),
              source: currentSessionId || 'voice_command',
            },
          });
          console.log(`[agent] Saved memory for user ${userId}: ${memContent}`);

          // Generate embedding async so the memory is retrievable via vector search
          (async () => {
            try {
              const retrieval = new RetrievalService(sessionOpenaiKey);
              const embedding = await retrieval.getEmbedding(memContent);
              const vectorStr = `[${embedding.join(',')}]`;
              await prisma.$executeRawUnsafe(
                `UPDATE "Memory" SET embedding = $1::vector WHERE id = $2`,
                vectorStr, mem.id
              );
              console.log(`[agent] Embedding saved for memory ${mem.id}`);
            } catch (embErr) {
              console.warn('[agent] Embedding generation skipped:', (embErr as any)?.message?.slice(0, 60));
            }
          })();
        } catch (memErr) {
          console.error('[agent] Failed to save memory:', memErr);
          // Silently fail — don't interrupt the user with a memory error whisper
          return;
        }
      }

      if (whisper.action === 'web_search' && whisper.actionData?.query) {
        const query = String(whisper.actionData.query);
        try {
          // Use Perplexity if available (better results with citations), else fallback
          const perplexity = new PerplexityService();
          if (perplexity.isAvailable) {
            const result = await perplexity.search(query);
            whisper.detail = result.answer;
            if (result.citations.length > 0) {
              whisper.detail += '\n\nSources: ' + result.citations.slice(0, 3).join(', ');
            }
          } else {
            const results = await search.search(query);
            whisper.detail = results.map((r) => r.title ? `${r.title}: ${r.snippet}` : r.snippet).join('\n\n');
          }
          whisper.content = `🔍 ${query}`;
        } catch (searchErr) {
          console.error('[agent] Search failed:', searchErr);
          // Fallback to basic search on Perplexity failure
          try {
            const results = await search.search(query);
            whisper.detail = results.map((r) => r.title ? `${r.title}: ${r.snippet}` : r.snippet).join('\n\n');
            whisper.content = `🔍 ${query}`;
          } catch {
            whisper.detail = 'Search failed. I\'ll answer from my knowledge instead.';
          }
        }
      }

      // Handle code_task action — dispatch to Claude Code worker
      if (whisper.action === 'code_task' && whisper.actionData?.prompt) {
        const taskPrompt = String(whisper.actionData.prompt);
        const taskContext = String(whisper.actionData.context || transcriptBuffer.slice(-5).join('\n'));
        const taskProject = whisper.actionData.project ? String(whisper.actionData.project) : undefined;
        whisper.content = `💻 ${taskPrompt.slice(0, 100)}`;
        whisper.type = 'code';

        if (codeWorkerHub.hasWorkers(userId)) {
          // Signal: code task is starting — client should pause input + show status
          socket.emit('code_task:status', { status: 'dispatching', task: taskPrompt.slice(0, 120) });

          // Capture session-scoped refs now. If the session ends or a new one
          // starts on this socket while the task is in flight, the module-level
          // tts / key bindings could point at a different session — we want the
          // completion to target the session that dispatched the task.
          const taskSessionId = currentSessionId;
          const taskTts = tts;
          const taskAnthropicKey = sessionAnthropicKey;
          const taskOwnerLanguage = sessionOwnerLanguage;
          const sessionStillActive = () => taskSessionId !== null && currentSessionId === taskSessionId;

          const task = codeWorkerHub.dispatchTask(userId, taskPrompt, taskContext, undefined, taskProject, {
            onChunk: (text) => {
              if (!sessionStillActive()) return;
              // Live progress goes to the status banner — no whisper cards
              // (prevents transcript clutter; user sees final output at completion)
              socket.emit('code_task:status', { status: 'working', detail: text.slice(-200) });
            },
            onComplete: async (result) => {
              if (!sessionStillActive()) return;
              socket.emit('code_task:status', { status: 'done', result: result.slice(0, 400) });

              // (1) RAW OUTPUT card — full Claude Code output, display only, no TTS
              socket.emit('whisper', {
                id: uuid(),
                type: 'code_output',
                content: '📄 Claude Code output',
                detail: result.slice(0, 4000),
                createdAt: new Date().toISOString(),
              });

              // (2) SYNTHESIZED SUMMARY — 1-2 sentences, spoken via TTS
              try {
                const summary = await synthesizeCodeSummary(taskAnthropicKey, taskOwnerLanguage, result, taskPrompt);
                if (!sessionStillActive()) return;
                if (summary) {
                  const summaryCard = {
                    id: uuid(),
                    type: 'code_summary',
                    content: summary,
                    createdAt: new Date().toISOString(),
                  };
                  socket.emit('whisper', summaryCard);
                  if (taskTts && taskTts.isConnected) taskTts.speak(summaryCard.id, summary);
                }
              } catch (err) {
                console.error('[code_task] summarization failed:', (err as any)?.message);
              }
            },
            onError: (error) => {
              if (!sessionStillActive()) return;
              socket.emit('code_task:status', { status: 'failed', error: error.slice(0, 200) });
              const errorMsg = `Task failed: ${error.slice(0, 100)}`;
              const errorCard = {
                id: uuid(),
                type: 'warning',
                content: `❌ ${errorMsg}`,
                detail: error.slice(0, 2000),
                createdAt: new Date().toISOString(),
              };
              socket.emit('whisper', errorCard);
              // Speak the failure so user knows without looking at screen
              if (taskTts && taskTts.isConnected) taskTts.speak(errorCard.id, errorMsg);
            },
          });
          if (task) {
            whisper.detail = `Sent to worker. Task ID: ${task.taskId}`;
          } else {
            // Dispatch failed — clear the locked state immediately
            socket.emit('code_task:status', { status: 'failed', error: 'All workers busy' });
            whisper.detail = 'All workers are busy. Try again in a moment.';
          }
        } else {
          socket.emit('code_task:status', { status: 'failed', error: 'No workers connected' });
          whisper.detail = 'No connected workers. Run the Angel worker agent on your machine.';
        }
      }

      const card = {
        id: uuid(),
        type: whisper.type,
        content: whisper.content,
        detail: whisper.detail,
        confidence: whisper.confidence,
        createdAt: new Date().toISOString(),
      };
      socket.emit('whisper', card);

      // Speak the whisper via TTS (voice output through AirPods).
      // Skip code_task dispatch announcements — user will hear the synthesized
      // summary when the task completes (avoids double-speaking).
      const skipTTS = whisper.action === 'code_task' || whisper.type === 'code_output' || whisper.type === 'code_summary';
      if (!skipTTS && tts && tts.isConnected && whisper.content && whisper.content.length >= 3) {
        tts.speak(card.id, whisper.content);
      }

      // Clear thinking indicator as soon as whisper arrives (don't wait for timeout)
      if (angelProcessing) {
        angelProcessing = false;
        if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
        socket.emit('angel:thinking', { active: false });
      }
    }

    async function cleanupSession() {
      clearAllTimers();
      angelProcessing = false;
      if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
      liveDirectives = [];

      // Close services in parallel for faster cleanup
      const closePromises: Promise<void>[] = [];
      if (realtime) {
        const rt = realtime;
        realtime = null;
        closePromises.push(rt.close().catch((err: any) => console.error('[cleanup] Realtime close error:', err)));
      }
      if (deepgram) {
        const dg = deepgram;
        deepgram = null;
        closePromises.push(dg.close().catch((err: any) => console.error('[cleanup] Deepgram close error:', err)));
      }
      if (tts) {
        const t = tts;
        tts = null;
        ttsPlaying = false;
        if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
        closePromises.push(t.close().catch((err: any) => console.error('[cleanup] TTS close error:', err)));
      }
      if (closePromises.length > 0) {
        await Promise.allSettled(closePromises);
      }

      transcriptBuffer = [];
      currentSessionId = null;
    }

    socket.on('session:start', async (payload: {
      sessionId: string;
      byok?: { provider: string; apiKey: string; model?: string };
      speech?: { keywords?: string[]; speechLocale?: string };
      instructions?: string;
      mode?: 'translation' | 'intelligence' | 'hybrid' | 'code';
      translateLanguages?: string[];
      intelligencePresets?: string[];
      codePresets?: string[];
      customInstructions?: string;
      ownerLanguage?: string;
      voiceId?: string;
    }) => {
      const { sessionId } = payload;
      if (!socket.userId) return;

      const session = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!session) return;

      // End any stale active/processing sessions for this user (prevent orphans)
      await prisma.session.updateMany({
        where: {
          userId: socket.userId,
          id: { not: sessionId },
          status: { in: ['active', 'processing'] },
        },
        data: { status: 'ended', endedAt: new Date() },
      });

      // Guard: if connections already exist (e.g., rapid reconnect),
      // clean them up before creating new ones to prevent orphaned connections.
      if (deepgram || realtime || tts) {
        console.log(`[session] Cleaning up existing connections before re-start for session ${sessionId}`);
        await cleanupSession();
      }

      transcriptBuffer = [];
      currentSessionId = sessionId;
      const userId = socket.userId;

      // Validate BYOK key format if provided
      if (payload.byok?.apiKey) {
        const keyStr = String(payload.byok.apiKey).trim();
        if (keyStr.length < 10 || keyStr.length > 200 || /[\s\x00-\x1f]/.test(keyStr)) {
          console.warn(`[session] Invalid BYOK key format from user ${socket.userId}`);
          socket.emit('session:error', { sessionId, message: 'Invalid API key format' });
          await cleanupSession();
          return;
        }
      }

      // Initialize OpenAI Realtime API for always-active Angel
      const openaiKey = payload.byok?.provider === 'openai' && payload.byok?.apiKey
        ? payload.byok.apiKey
        : process.env.OPENAI_API_KEY || '';
      sessionOpenaiKey = openaiKey; // Capture for memory/embedding operations

      const ownerLanguage = ALLOWED_OWNER_LANGUAGES.includes(payload.ownerLanguage as string)
        ? (payload.ownerLanguage as string)
        : 'English';
      sessionOwnerLanguage = ownerLanguage;
      sessionMode = payload.mode || 'intelligence';

      if (openaiKey) {
        const translateLanguages = payload.translateLanguages || [];
        const intPresets = payload.intelligencePresets || ['jargon'];
        const cdPresets = payload.codePresets || ['debug', 'explain'];
        const customInstr = payload.customInstructions || '';
        // Capture for mode-switch rebuilds
        sessionTranslateLanguages = translateLanguages;
        sessionIntPresets = intPresets;
        sessionCdPresets = cdPresets;
        sessionCustomInstr = customInstr;

        // Retrieve user memories for context injection
        let memoryContext = '';
        try {
          const retrieval = new RetrievalService(openaiKey);
          memoryContext = await retrieval.buildContext(userId, customInstr || 'general context', 2000);
          console.log(`[session] Memory context: ${memoryContext.length} chars`);
        } catch (memErr) {
          console.warn('[session] Memory retrieval skipped:', (memErr as any)?.message?.slice(0, 80));
        }
        sessionMemoryContext = memoryContext;

        const workerProjects = sessionMode === 'code' ? codeWorkerHub.getProjects(userId) : [];
        const angelInstructions = buildAngelInstructions(ownerLanguage, sessionMode, translateLanguages, intPresets, cdPresets, customInstr, memoryContext, workerProjects);
        const whisperHandler = (whisper: any) => {
          handleRealtimeWhisper(userId, whisper).catch((err) => {
            console.error('[Brain] Whisper handling error:', err);
          });
        };
        const errorHandler = (error: string) => console.error('[Brain] Error:', error);
        const statusHandler = (status: string) => {
          console.log(`[Brain] Status: ${status}`);
          socket.emit('realtime:status', { status });
        };

        // Code mode: use Claude Opus as primary brain, fallback to OpenAI Realtime
        const anthropicKey = payload.byok?.provider === 'anthropic' && payload.byok?.apiKey
          ? payload.byok.apiKey
          : process.env.ANTHROPIC_API_KEY || '';
        sessionAnthropicKey = anthropicKey; // Capture for post-task summarization

        if (sessionMode === 'code' && anthropicKey) {
          console.log(`[session] Using Claude Opus brain for Code mode`);
          realtime = new ClaudeCodeBrain({
            apiKey: anthropicKey,
            ownerLanguage,
            mode: sessionMode,
            instructions: angelInstructions,
            onWhisper: whisperHandler,
            onError: errorHandler,
            onStatus: statusHandler as any,
          });
        } else {
          console.log(`[session] Using OpenAI Realtime brain (mode: ${sessionMode})`);
          realtime = new RealtimeService({
            apiKey: openaiKey,
            ownerLanguage,
            mode: sessionMode,
            instructions: angelInstructions,
            onWhisper: whisperHandler,
            onError: errorHandler,
            onStatus: statusHandler as any,
          });
        }

        try {
          await realtime.connect();
          console.log(`[session] Realtime API connected for session ${sessionId}`);
        } catch (err) {
          console.error('[session] Realtime API connection failed:', err);
          // Non-fatal — session continues with Deepgram only, no AI whispers
          realtime = null;
        }
      } else {
        console.warn('[session] No OpenAI API key — Realtime AI whispers disabled');
      }

      // Initialize Cartesia TTS for voice output (whispers spoken aloud via AirPods)
      // Map owner language name to Cartesia language code
      const LANG_TO_TTS: Record<string, string> = {
        English: 'en', Chinese: 'zh', Malay: 'ms', Spanish: 'es',
        French: 'fr', Japanese: 'ja', Korean: 'ko', Hindi: 'hi',
      };
      const ttsLang = LANG_TO_TTS[ownerLanguage] || 'en';
      if (CARTESIA_API_KEY) {
        tts = new CartesiaTTSService({
          apiKey: CARTESIA_API_KEY,
          voiceId: payload.voiceId || DEFAULT_VOICE_ID,
          language: ttsLang,
          onAudioChunk: (data) => {
            socket.emit('tts:chunk', data);
          },
          onStart: (data) => {
            ttsPlaying = true;
            // Safety timeout: release echo gate after 15s even if client never confirms
            if (ttsEchoTimer) clearTimeout(ttsEchoTimer);
            ttsEchoTimer = setTimeout(() => {
              if (ttsPlaying) {
                console.warn('[TTS] Echo gate safety timeout — releasing after 15s');
                ttsPlaying = false;
              }
              ttsEchoTimer = null;
            }, 15_000);
            socket.emit('tts:start', data);
          },
          onDone: (data) => {
            socket.emit('tts:done', data);
            // ttsPlaying stays true until client confirms playback finished via
            // tts:finished. This prevents new transcripts from feeding to the AI
            // while audio is still playing, avoiding premature whisper interruption.
            // The 15s safety timeout (set in onStart) handles the case where
            // tts:finished never arrives.
          },
          onError: (error) => {
            console.error('[TTS] Error:', error);
            ttsPlaying = false;
            if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
          },
        });

        try {
          await tts.connect();
          console.log(`[session] TTS connected for session ${sessionId}`);
        } catch (err) {
          console.error('[session] TTS connection failed:', err);
          tts = null;
        }
      }

      // Load voiceprint for owner identification (if enrolled)
      // Wrapped in try-catch — table may not exist yet if migration hasn't run
      let voiceprintRecord: any = null;
      try {
        voiceprintRecord = await prisma.voiceprint.findUnique({
          where: { userId: socket.userId },
        });
      } catch (err) {
        console.warn('[session] Voiceprint lookup failed (table may not exist):', (err as any).code);
      }

      // Initialize Deepgram with diarization
      deepgram = new DeepgramService({
        onTranscript: (data) => {
          socket.emit('transcript', data);

          // Reset idle timer on ANY transcript (including interim results).
          resetIdleTimer();

          // Buffer transcript for whisper generation
          if (data.isFinal && data.text.trim()) {
            const label = data.speakerLabel || data.speaker || 'Unknown';
            transcriptBuffer.push(`[${label}]: ${data.text.slice(0, 500)}`);
            if (transcriptBuffer.length > 60) {
              transcriptBuffer = transcriptBuffer.slice(-40);
            }

            // Periodic memory refresh — inject fresh memories as conversation evolves
            transcriptsSinceMemoryRefresh++;
            if (transcriptsSinceMemoryRefresh >= MEMORY_REFRESH_INTERVAL && realtime && socket.userId) {
              transcriptsSinceMemoryRefresh = 0;
              const recentText = transcriptBuffer.slice(-5).join(' ');
              const uid = socket.userId;
              // Async — don't block transcript flow
              (async () => {
                try {
                  const retrieval = new RetrievalService(sessionOpenaiKey);
                  const freshMemory = await retrieval.buildContext(uid, recentText, 2000);
                  if (realtime && freshMemory.length > 50) {
                    rebuildInstructions(freshMemory);
                    console.log(`[session] Memory context refreshed (${freshMemory.length} chars)`);
                  }
                } catch (e) {
                  console.warn('[session] Memory refresh failed:', (e as any)?.message?.slice(0, 60));
                }
              })();
            }

            // Feed transcript to Realtime API (always-active Angel)
            // Echo gate: skip during TTS playback to prevent AI responding to its own voice
            // Code mode gate: transcripts stay in buffer but never auto-trigger Claude Opus —
            // user must press "Ask" or type a message to invoke Claude. Prevents burning
            // API calls on idle chatter and accidental Claude Code dispatches.
            if (realtime && !ttsPlaying && sessionMode !== 'code') {
              realtime.feedTranscript(`[${label}]: ${data.text}`);
            }

            // Voice mode switch: "switch to code mode", "switch to translation", etc.
            if (label === 'Owner') {
              const lower = data.text.toLowerCase().trim();
              const modeMatch = lower.match(/\b(?:switch|change|go)\s+to\s+(code|translation|translate|intelligence|hybrid)(?:\s+mode)?\b/)
                || lower.match(/\b(code|translation|translate|intelligence|hybrid)\s+mode\b/);
              if (modeMatch) {
                const raw = modeMatch[1];
                const target: 'translation' | 'intelligence' | 'hybrid' | 'code' =
                  raw === 'translate' ? 'translation' : (raw as any);
                // Async — don't block transcript flow
                switchMode(target).catch((e) => console.error('[mode-switch] failed:', e));
              }
            }

            // Voice wake word detection: "hi angel", "hey angel", "yo angel", "ok angel"
            if (label === 'Owner') {
              const lower = data.text.toLowerCase().trim();
              const wakePatterns = /\b(hi|hey|yo|ok|okay)\s+angel\b/;
              if (wakePatterns.test(lower) && !angelProcessing) {
                console.log(`[agent] Wake word detected: "${data.text}"`);
                angelProcessing = true;
                socket.emit('angel:thinking', { active: true });

                // Clear any existing thinking timer before setting new one
                if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); }
                // Small delay to let the owner finish their sentence, then force respond
                const wakeDelayTimer = setTimeout(async () => {
                  // Guard: if session ended or angel was deactivated while waiting
                  if (!angelProcessing || !currentSessionId) return;
                  try {
                    if (realtime) {
                      realtime.forceRespond();
                    }
                  } catch (err) {
                    console.error('[agent] Wake word response error:', err);
                  }
                  // forceRespond is async via WebSocket — set max thinking indicator
                  // Guard again to prevent setting timer after cleanup
                  if (!currentSessionId) return;
                  angelThinkingTimer = setTimeout(() => {
                    if (angelProcessing) {
                      angelProcessing = false;
                      socket.emit('angel:thinking', { active: false });
                    }
                    angelThinkingTimer = null;
                  }, 5000);
                }, 2000); // 2s delay to capture the full sentence after the wake word
                // Track the outer timer so cleanupSession can cancel it
                angelThinkingTimer = wakeDelayTimer;
              }
            }
          }
        },
        onSpeakerIdentified: (speakerId, label) => {
          socket.emit('speaker:identified', { speakerId, label });
        },
        onError: (errorMsg) => {
          socket.emit('session:error', { sessionId, message: errorMsg });
        },
        onConnectionStatus: (status) => {
          socket.emit('deepgram:status', { sessionId, status });
        },
        voiceprint: voiceprintRecord?.features ?? null,
        sessionId,
        userId,
        keywords: payload.speech?.keywords,
        speechLocale: payload.speech?.speechLocale,
        mode: sessionMode,
      });

      try {
        await deepgram.connect();
      } catch (err: any) {
        const message = err?.message || 'Failed to connect to transcription service';
        console.error('Deepgram connection failed:', message);
        socket.emit('session:error', { sessionId, message });
        await cleanupSession();
        return;
      }

      // Max session duration timeout (2 hours)
      sessionTimer = setTimeout(() => {
        console.log(`Session ${sessionId} hit max duration (${MAX_SESSION_DURATION_MS / 1000}s)`);
        socket.emit('session:timeout', {
          sessionId,
          reason: 'max_duration',
          message: 'Session reached maximum duration of 2 hours',
        });
        cleanupSession();
      }, MAX_SESSION_DURATION_MS);

      // Start idle timer (will be reset on each transcript)
      resetIdleTimer();

      console.log(`Session started: ${sessionId}`);
    });

    socket.on('audio', (audioData: string | Buffer | ArrayBuffer) => {
      // Only accept audio during an active session with a live Deepgram connection
      if (!currentSessionId || !deepgram) return;

      try {
        let buffer: Buffer;

        if (Buffer.isBuffer(audioData)) {
          buffer = audioData;
        } else if (audioData instanceof ArrayBuffer) {
          // Binary transport from mobile (Uint8Array.buffer)
          buffer = Buffer.from(audioData);
        } else if (typeof audioData === 'string') {
          // Legacy base64 transport (fallback)
          buffer = Buffer.from(audioData, 'base64');
        } else {
          return;
        }

        // Reject empty or oversized chunks (max ~256KB ≈ 8s of audio)
        if (buffer.length === 0 || buffer.length > 262144) return;

        deepgram.sendAudio(buffer);
      } catch (err) {
        console.warn('[socket] Failed to process audio chunk:', err);
      }
    });

    // Angel manual activation — button press triggers immediate response via Realtime API
    // Stop button — aborts whatever the AI is doing right now:
    //   1. Brain request in flight (ClaudeCodeBrain or RealtimeService) → abort
    //   2. Claude Code task running on a worker → send cancel → worker kills process
    //   3. Active TTS playback → cancel
    socket.on('angel:stop', () => {
      if (!socket.userId) return;
      console.log(`[angel:stop] User ${socket.userId} requested stop`);

      // 1. Cancel any running worker task
      const cancelledTaskId = codeWorkerHub.cancelUserTasks(socket.userId);
      if (cancelledTaskId) {
        socket.emit('code_task:status', { status: 'failed', error: 'Stopped by user' });
      }

      // 2. Abort current brain request (doesn't disconnect, just cancels in-flight work)
      if (realtime) {
        try { realtime.abort(); } catch {}
      }
      if (angelProcessing) {
        angelProcessing = false;
        if (angelThinkingTimer) { clearTimeout(angelThinkingTimer); angelThinkingTimer = null; }
        socket.emit('angel:thinking', { active: false });
      }

      // 3. Cancel TTS if playing
      if (tts) { try { tts.cancel(); } catch {} }
      if (ttsPlaying) {
        ttsPlaying = false;
        if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
        socket.emit('tts:cancel', {});
      }

      socket.emit('whisper', {
        id: uuid(),
        type: 'mode_switch',
        content: '⏹ Stopped',
        createdAt: new Date().toISOString(),
      });
    });

    socket.on('angel:activate', async () => {
      if (!currentSessionId || !socket.userId || angelProcessing) return;

      // Rate limit: reject if called within 5 seconds of last activation
      const now = Date.now();
      if (now - lastActivateTime < 5000) {
        return;
      }
      lastActivateTime = now;
      if (transcriptBuffer.length < 1) {
        socket.emit('whisper', {
          id: uuid(),
          type: 'response',
          content: 'I need some conversation to work with first. Keep talking!',
          createdAt: new Date().toISOString(),
        });
        return;
      }

      angelProcessing = true;
      socket.emit('angel:thinking', { active: true });

      try {
        if (realtime) {
          // Code mode: transcripts are NOT auto-fed to the brain, so we replay
          // the recent buffer now so Claude Opus has context when answering.
          if (sessionMode === 'code') {
            const recent = transcriptBuffer.slice(-20);
            for (const line of recent) {
              try { realtime.feedTranscript(line); } catch {}
            }
          }
          realtime.forceRespond();
          // forceRespond triggers async response via WebSocket
          // Set a max timeout to clear thinking indicator
          angelThinkingTimer = setTimeout(() => {
            angelProcessing = false;
            socket.emit('angel:thinking', { active: false });
            angelThinkingTimer = null;
          }, 8000);
        } else {
          // No Realtime connection — fallback message
          socket.emit('whisper', {
            id: uuid(),
            type: 'warning',
            content: 'Angel AI is not connected. Check your API key in settings.',
            createdAt: new Date().toISOString(),
          });
          angelProcessing = false;
          socket.emit('angel:thinking', { active: false });
        }
      } catch (err) {
        console.error('[angel:activate] Error:', err);
        socket.emit('whisper', {
          id: uuid(),
          type: 'warning',
          content: 'Something went wrong. Try again in a moment.',
          createdAt: new Date().toISOString(),
        });
        angelProcessing = false;
        socket.emit('angel:thinking', { active: false });
      }
    });

    // Text message from user — fed to AI and forces an immediate response
    socket.on('session:message', (data: { text: string }) => {
      if (!realtime || !data?.text?.trim()) return;
      resetIdleTimer(); // Text activity keeps session alive even with mic paused
      const text = data.text.trim();
      console.log(`[session] Text message from owner: "${text.slice(0, 80)}"`);

      // Add to transcript buffer
      transcriptBuffer.push(`[Owner]: ${text.slice(0, 500)}`);
      if (transcriptBuffer.length > 60) transcriptBuffer = transcriptBuffer.slice(-40);

      // In Code mode, the brain didn't receive the buffered context — replay now
      if (sessionMode === 'code') {
        const recent = transcriptBuffer.slice(-20, -1); // all except the message we just pushed
        for (const line of recent) {
          try { realtime.feedTranscript(line); } catch {}
        }
      }

      // Feed to AI then force immediate response — user typed directly, always answer
      realtime.feedTranscript(`[Owner]: ${text}`);
      realtime.forceRespond();
    });

    socket.on('session:instruct', (data: { text: string }) => {
      if (!realtime || !data?.text?.trim()) return;
      resetIdleTimer();
      const directive = data.text.trim();

      // Detect mode switch via text (e.g. "/switch to code" or "/mode code")
      const modeMatch = directive.toLowerCase().match(/^(?:switch\s+to\s+|mode\s+|switch\s+mode\s+)?(code|translation|translate|intelligence|hybrid)(?:\s+mode)?$/);
      if (modeMatch) {
        const raw = modeMatch[1];
        const target: 'translation' | 'intelligence' | 'hybrid' | 'code' =
          raw === 'translate' ? 'translation' : (raw as any);
        switchMode(target).catch((e) => console.error('[mode-switch] failed:', e));
        return;
      }

      liveDirectives.push(directive);
      console.log(`[session] Live directive: "${directive}"`);
      rebuildInstructions(); // Atomic rebuild preserves memory + adds all directives
    });

    // TTS client control events
    socket.on('tts:skip', () => {
      if (tts) tts.cancel();
      ttsPlaying = false;
      if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
      socket.emit('tts:cancel', {});
    });

    socket.on('tts:finished', () => {
      ttsPlaying = false;
      if (ttsEchoTimer) { clearTimeout(ttsEchoTimer); ttsEchoTimer = null; }
    });

    socket.on('tts:speed', (data: { speed: string }) => {
      const valid = ['normal', 'fast', 'fastest'] as const;
      if (tts) {
        // Map 'ultra' to 'fastest' (Cartesia's max) — client handles 3x via decimation
        const mapped = data.speed === 'ultra' ? 'fastest' : data.speed;
        if (valid.includes(mapped as any)) tts.setSpeed(mapped as any);
      }
    });

    // ── Test conversation mode ──
    socket.on('session:test', (data?: { type?: string }) => {
      if (!currentSessionId || !realtime) {
        console.warn('[test] session:test received but session not ready');
        socket.emit('test:not-ready');
        return;
      }
      const testType = data?.type || 'fusion';
      console.log(`[test] Starting test conversation: ${testType}`);

      // ── Test scripts by type ──
      const TEST_SCRIPTS: Record<string, {
        speakers: { id: string; label: string }[];
        script: { speaker: number; text: string; delay: number }[];
      }> = {
        fusion: {
          speakers: [
            { id: 'speaker_0', label: 'Dr. Chen' },
            { id: 'speaker_1', label: 'Dr. Morrison' },
            { id: 'speaker_2', label: 'Owner' },
          ],
          script: [
            { speaker: 2, delay: 1000, text: "Good morning. Let's review the latest results from the SPARC tokamak high-field test campaign. Sarah, you want to lead us off?" },
            { speaker: 0, delay: 7000, text: "Sure. The big headline — we achieved a plasma current of 8.7 mega-amperes in the latest deuterium-tritium shot. The ion temperature peaked at 120 million Kelvin, well above the Lawson criterion threshold." },
            { speaker: 1, delay: 8000, text: "What about the energy confinement time? Last run we were struggling with neoclassical tearing modes destabilizing the plasma edge." },
            { speaker: 0, delay: 7000, text: "We deployed a new ECCD profile — electron cyclotron current drive — targeting the q equals 2 rational surface. That fully suppressed the NTMs. Energy confinement time improved to 1.4 seconds." },
            { speaker: 2, delay: 7000, text: "And the Q factor? That's what the board is waiting for." },
            { speaker: 0, delay: 6000, text: "Q equals 2.3 for this shot. That's genuine net energy gain. Fusion power output was approximately 140 megawatts thermal against 60 megawatts of auxiliary heating input." },
            { speaker: 1, delay: 8000, text: "I need to flag a materials concern. The tungsten divertor tiles showed significant sputtering erosion — roughly 3 microns per shot. At this rate, we need a replacement cycle every 200 plasma discharges." },
            { speaker: 2, delay: 5000, text: "Is that within the design envelope?" },
            { speaker: 1, delay: 7000, text: "Barely. The neutron flux at the first wall reached 2.4 megawatts per square meter. The RAFM steel — reduced activation ferritic martensitic — is holding up, but we're seeing helium bubble formation at the grain boundaries after 5 dpa." },
            { speaker: 0, delay: 7000, text: "James, what about the silicon carbide fiber composite as an alternative PFC? The thermal shock resistance should be significantly better." },
            { speaker: 1, delay: 8000, text: "We have SiC-f samples under neutron irradiation at the IFMIF facility. Early results are mixed — better radiation hardness, but thermal conductivity degrades 40 percent after 10 displacements per atom." },
            { speaker: 2, delay: 6000, text: "OK, let's move to tritium breeding. We need a TBR above 1.1 for fuel self-sufficiency." },
            { speaker: 0, delay: 7000, text: "The lithium-lead eutectic blanket modules measured a TBR of 1.08 this campaign. Below target. The beryllium neutron multiplier layer needs to be thicker." },
            { speaker: 1, delay: 7000, text: "My MCNP Monte Carlo neutronics simulations suggest increasing the beryllium pebble bed from 2 to 3 centimeters. That should push us to 1.14 TBR with acceptable tritium permeation rates through the EUROFER membrane." },
            { speaker: 0, delay: 8000, text: "Now here's the real breakthrough. We observed a new operating regime we're calling Super H-mode. The pedestal pressure was 30 percent higher than standard H-mode, with zero ELMs — no edge localized modes at all." },
            { speaker: 2, delay: 5000, text: "That's significant. ELM mitigation has been one of our biggest engineering headaches. What's driving it?" },
            { speaker: 0, delay: 8000, text: "The bootstrap current fraction reached 65 percent, which reduces external current drive requirements substantially. Gyrokinetic TGLF simulations show turbulent transport is dominated by trapped electron modes rather than the usual ITG modes." },
            { speaker: 1, delay: 8000, text: "On the magnets — the REBCO high-temperature superconducting coils sustained 20 Tesla on axis with zero quench events. And since they operate at 20 Kelvin instead of 4K for legacy NbTi coils, cryoplant power drops 60 percent." },
            { speaker: 0, delay: 7000, text: "Alpha particle confinement was excellent too. Fast-ion loss detectors showed under 5 percent alpha losses. Most 3.5 MeV fusion alphas are thermalizing in the core and driving self-heating." },
            { speaker: 2, delay: 7000, text: "Excellent work. Next DT campaign in three weeks. James, I need your updated neutronics by Friday. Sarah, prepare the Super H-mode reproducibility protocol." },
          ],
        },
        chinese: {
          speakers: [
            { id: 'speaker_0', label: 'Owner' },
            { id: 'speaker_1', label: 'Mr. Wang' },
            { id: 'speaker_2', label: 'Ms. Li' },
          ],
          script: [
            { speaker: 0, delay: 1000, text: "Hi Mr. Wang, Ms. Li, thanks for meeting today. Let's discuss the supply chain updates for Q3." },
            { speaker: 1, delay: 7000, text: "好的，我先说一下目前的情况。上个月深圳工厂的产能提升了百分之二十，但是原材料价格涨了不少，特别是锂电池的正极材料。" },
            { speaker: 2, delay: 8000, text: "对，王总说的没错。碳酸锂的价格从每吨八万涨到了十二万，涨幅百分之五十。这对我们的利润率影响很大。" },
            { speaker: 0, delay: 7000, text: "That's a significant increase. What's driving the lithium carbonate price spike?" },
            { speaker: 1, delay: 8000, text: "主要是两个原因。第一，南美的锂矿开采受到了环保政策的限制，产量下降了。第二，新能源汽车的需求增长太快了，特别是比亚迪和特斯拉的订单量翻了一倍。" },
            { speaker: 2, delay: 7000, text: "我们已经跟三家备选供应商谈过了。宁德时代给了我们一个长期协议的报价，每吨九万五，锁定两年。" },
            { speaker: 0, delay: 6000, text: "Ninety-five thousand per ton for two years? That sounds reasonable. What are the terms?" },
            { speaker: 1, delay: 8000, text: "条件是我们需要提前支付百分之三十的定金，而且每个季度的最低采购量不能低于五百吨。如果达不到最低量，违约金是合同总额的百分之五。" },
            { speaker: 2, delay: 7000, text: "另外还有一个问题，物流成本也涨了。从深圳到东南亚的海运费用涨了百分之四十，因为红海那边的航线还是不稳定。" },
            { speaker: 0, delay: 6000, text: "So we're looking at both raw material and logistics cost increases. What's the total impact on unit cost?" },
            { speaker: 1, delay: 8000, text: "综合算下来，每个产品的成本大概增加了十五到二十美金。如果不调整终端售价的话，利润率会从百分之二十五降到百分之十八左右。" },
            { speaker: 2, delay: 7000, text: "我建议我们可以考虑两个方案。第一是把部分生产转移到越南工厂，那边的人工成本低百分之三十。第二是跟客户重新谈价格，提价百分之八到十。" },
            { speaker: 0, delay: 7000, text: "Let's explore the Vietnam option. What's the timeline to shift production there?" },
            { speaker: 1, delay: 8000, text: "越南工厂的新产线预计下个月底可以投产。但是前三个月的良率可能只有百分之八十五，比深圳低大概十个百分点。需要派技术团队过去培训。" },
            { speaker: 2, delay: 7000, text: "对，我已经安排了陈工和他的团队下周飞河内。另外，越南那边的海关清关流程比较慢，平均要五到七个工作日，比深圳多两天。" },
            { speaker: 0, delay: 6000, text: "OK, so we'll have a transition period with lower yields and longer shipping. What about the pricing negotiation with clients?" },
            { speaker: 1, delay: 8000, text: "我跟美国那边的采购经理聊过了，他们可以接受百分之五的涨价，但超过这个幅度的话就要走他们的审批流程，可能需要两到三个月。" },
            { speaker: 2, delay: 7000, text: "欧洲客户那边比较难谈。他们现在也在砍预算，说最多接受百分之三。不过他们的订单量占我们总收入的百分之四十，不能丢。" },
            { speaker: 0, delay: 7000, text: "Let's go with five percent for the US and three percent for Europe. Combined with the Vietnam production shift, what does our margin look like?" },
            { speaker: 1, delay: 7000, text: "如果两个方案同时推进的话，利润率大概能维持在百分之二十一到二十二之间。比现在低一点，但还在可以接受的范围内。" },
            { speaker: 2, delay: 6000, text: "我觉得这个方案可行。我来起草一个详细的执行计划，下周一之前发给大家审核。" },
            { speaker: 0, delay: 5000, text: "Great, let's move forward with that plan. Thanks both." },
          ],
        },
      };

      const test = TEST_SCRIPTS[testType] || TEST_SCRIPTS.fusion;
      const SPEAKERS = test.speakers;
      const SCRIPT = test.script;

      let idx = 0;

      // Stream a single line word-by-word (interim transcripts) then final
      const streamLine = (segIdx: number, onDone: () => void) => {
        const seg = SCRIPT[segIdx];
        const sp = SPEAKERS[seg.speaker];
        const interimId = `test-interim-${segIdx}`;
        const finalId = `test-final-${segIdx}`;

        // Stream only lines containing Chinese characters — English lines emit immediately
        const hasChinese = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(seg.text);
        const isStreaming = testType === 'chinese' && hasChinese;
        if (!isStreaming) {
          socket.emit('transcript', { id: finalId, speaker: sp.id, speakerLabel: sp.label, text: seg.text, isFinal: true, timestamp: Date.now() });
          transcriptBuffer.push(`[${sp.label}]: ${seg.text.slice(0, 500)}`);
          if (transcriptBuffer.length > 60) transcriptBuffer = transcriptBuffer.slice(-40);
          if (realtime) realtime.feedTranscript(`[${sp.label}]: ${seg.text}`);
          resetIdleTimer();
          onDone();
          return;
        }

        // Word-by-word streaming for Chinese test
        const words = seg.text.split(/(?<=[\u4e00-\u9fff\u3400-\u4dbf])|(\s+)/).filter(Boolean);
        // Group into chunks of ~4 characters for natural pacing
        const chunks: string[] = [];
        let current = '';
        for (const w of words) {
          current += w;
          if (current.length >= 4) {
            chunks.push(current);
            current = '';
          }
        }
        if (current) chunks.push(current);

        let ci = 0;
        const streamNext = () => {
          if (!currentSessionId) return;
          ci++;
          const partial = chunks.slice(0, ci).join('');
          if (ci < chunks.length) {
            // Interim — words appearing one by one
            socket.emit('transcript', { id: interimId, speaker: sp.id, speakerLabel: sp.label, text: partial, isFinal: false, timestamp: Date.now() });
            testTimer = setTimeout(streamNext, 600 + Math.random() * 450); // 600-1050ms per chunk — mimics real speech pace
          } else {
            // Final — full sentence
            socket.emit('transcript', { id: finalId, speaker: sp.id, speakerLabel: sp.label, text: seg.text, isFinal: true, timestamp: Date.now() });
            transcriptBuffer.push(`[${sp.label}]: ${seg.text.slice(0, 500)}`);
            if (transcriptBuffer.length > 60) transcriptBuffer = transcriptBuffer.slice(-40);
            if (realtime) realtime.feedTranscript(`[${sp.label}]: ${seg.text}`);
            resetIdleTimer();
            onDone();
          }
        };
        streamNext();
      };

      const emitNext = () => {
        if (idx >= SCRIPT.length || !currentSessionId) { testTimer = null; return; }
        streamLine(idx, () => {
          idx++;
          if (idx < SCRIPT.length) {
            testTimer = setTimeout(emitNext, SCRIPT[idx].delay);
          }
        });
      };

      testTimer = setTimeout(emitNext, SCRIPT[0].delay);
    });

    socket.on('session:stop', async ({ sessionId }: { sessionId: string }) => {
      // Validate session ownership to prevent another user from stopping a session
      if (!socket.userId) return;
      const sessionRecord = await prisma.session.findFirst({
        where: { id: sessionId, userId: socket.userId },
      });
      if (!sessionRecord) {
        console.warn(`[session:stop] Rejected — user ${socket.userId} does not own session ${sessionId}`);
        return;
      }

      // Grab speakers and flush episodes BEFORE cleanup closes connections
      const speakers = deepgram ? deepgram.getSpeakers() : {};
      if (deepgram) await deepgram.flush();
      const userId = socket.userId;

      // Use shared cleanup (closes realtime, deepgram, clears timers + state)
      await cleanupSession();

      if (userId) {
        await prisma.session.update({
          where: { id: sessionId },
          data: { endedAt: new Date(), status: 'processing', speakers },
        });

        // Post-session: extract memories, entities, reflections
        const extraction = new ExtractionService(sessionOpenaiKey);
        extraction.processSession(sessionId, userId).then(async (extractionResult) => {
          const summary = extractionResult?.summary || 'Session completed';

          await prisma.session.update({
            where: { id: sessionId },
            data: { status: 'ended', summary },
          });

          // Emit session:debrief with comprehensive data
          socket.emit('session:debrief', {
            sessionId,
            summary,
            memoriesExtracted: extractionResult?.memoriesExtracted ?? 0,
            entitiesFound: extractionResult?.entitiesFound ?? 0,
            duration: extractionResult?.duration ?? null,
            completedAt: new Date().toISOString(),
          });

          // Run reflection + maintenance
          runPostSessionReflection(userId).catch((err) => {
            console.error('Post-session reflection/maintenance error:', err);
          });
        }).catch(async (err) => {
          console.error('Post-session extraction error:', err);
          // Update session status even on failure (prevent permanent "processing" state)
          try {
            await prisma.session.update({
              where: { id: sessionId },
              data: { status: 'ended', summary: 'Session ended (extraction failed)' },
            });
          } catch {}
          socket.emit('session:debrief', {
            sessionId,
            summary: 'Session ended',
            error: true,
            completedAt: new Date().toISOString(),
          });
        });
      }

      console.log(`Session stopped: ${sessionId}`);
    });

    socket.on('disconnect', async () => {
      unsubscribeProjects();
      const sid = currentSessionId;
      const uid = socket.userId;
      const speakers = deepgram ? deepgram.getSpeakers() : {};
      if (deepgram) await deepgram.flush().catch(() => {});
      const keyForExtraction = sessionOpenaiKey;

      await cleanupSession();

      // Continuous-session UX: disconnect IS the session end. Run extraction
      // + reflection so memories/debriefs are still produced. Fire-and-forget;
      // the socket is already closed so we can't emit debrief — that's OK,
      // the next session start will retrieve the updated memories.
      if (sid && uid) {
        try {
          // Mark processing so UI won't show it as active
          await prisma.session.update({
            where: { id: sid },
            data: { endedAt: new Date(), status: 'processing', speakers },
          });
        } catch {
          // Session may not exist or already ended — fall through
        }

        // Run extraction in the background (don't block disconnect handler)
        (async () => {
          try {
            const extraction = new ExtractionService(keyForExtraction);
            const result = await extraction.processSession(sid, uid);
            const summary = result?.summary || 'Session completed';
            await prisma.session.update({
              where: { id: sid },
              data: { status: 'ended', summary },
            }).catch(() => {});
            console.log(`[disconnect] Extraction done for ${sid}: ${result?.memoriesExtracted ?? 0} memories`);
            // Post-session reflection (entity merging, core memory update)
            runPostSessionReflection(uid).catch((e) => console.error('[disconnect] reflection:', e));
          } catch (err) {
            console.error('[disconnect] extraction failed:', (err as any)?.message);
            await prisma.session.update({
              where: { id: sid },
              data: { status: 'ended', summary: 'Session ended (extraction failed)' },
            }).catch(() => {});
          }
        })();
      }

      console.log(`Client disconnected: ${uid}`);
    });
  });
}
