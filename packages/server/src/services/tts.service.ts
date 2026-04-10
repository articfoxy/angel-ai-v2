/**
 * Cartesia TTS (Text-to-Speech) service for Angel AI.
 *
 * Maintains a persistent WebSocket connection to Cartesia's streaming TTS API.
 * Converts whisper text into PCM audio chunks that are streamed back to the
 * client in real time for earpiece playback.
 */
import WebSocket from 'ws';
import { v4 as uuid } from 'uuid';

interface TTSCallbacks {
  onAudioChunk: (data: { whisperId: string; audio: string; chunkIndex: number }) => void;
  onStart: (data: { whisperId: string; estimatedDurationMs: number }) => void;
  onDone: (data: { whisperId: string }) => void;
  onError?: (error: string) => void;
}

interface CartesiaTTSConfig extends TTSCallbacks {
  apiKey: string;
  voiceId: string;
  language?: string; // Cartesia language code (default: 'en')
}

const CARTESIA_WS_BASE = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_VERSION = '2024-06-10';
const CARTESIA_MODEL = 'sonic-2024-12-12';
const MAX_RECONNECT_ATTEMPTS = 3;
const MIN_TEXT_LENGTH = 3;
// Rough estimate: ~75ms per word for UI progress indication
const MS_PER_WORD = 75;

export class CartesiaTTSService {
  private ws: WebSocket | null = null;
  private connected = false;
  private currentContextId: string | null = null;
  private currentWhisperId: string | null = null;
  private chunkIndex = 0;
  private voiceId: string;
  private apiKey: string;
  private language: string;
  private callbacks: TTSCallbacks;
  private reconnectAttempts = 0;
  private intentionallyClosed = false;

  constructor(config: CartesiaTTSConfig) {
    this.apiKey = config.apiKey;
    this.voiceId = config.voiceId;
    this.language = config.language || 'en';
    this.callbacks = {
      onAudioChunk: config.onAudioChunk,
      onStart: config.onStart,
      onDone: config.onDone,
      onError: config.onError,
    };
  }

  /** Whether the WebSocket is open and ready to accept speak() calls. */
  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Open a persistent WebSocket connection to Cartesia's TTS API.
   * Resolves once the connection is open; rejects on timeout or error.
   */
  async connect(isReconnect = false): Promise<void> {
    return new Promise((resolve, reject) => {
      // Only reset flags on user-initiated connects, not auto-reconnects
      if (!isReconnect) {
        this.intentionallyClosed = false;
        this.reconnectAttempts = 0;
      }

      // Clean up any stale connection before opening a new one
      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          this.ws.close();
        } catch {}
        this.ws = null;
        this.connected = false;
      }

      const url = `${CARTESIA_WS_BASE}?api_key=${this.apiKey}&cartesia_version=${CARTESIA_VERSION}`;
      console.log('[TTS] Connecting to Cartesia WebSocket...');

      this.ws = new WebSocket(url);

      const timeout = setTimeout(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) {
          console.error('[TTS] Connection timeout after 10s');
          this.ws?.close();
          reject(new Error('Cartesia TTS connection timeout'));
        }
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.reconnectAttempts = 0;
        console.log('[TTS] WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.warn('[TTS] Failed to parse message:', err);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[TTS] WebSocket error:', err.message);
        this.callbacks.onError?.(err.message);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(timeout);
        this.connected = false;
        console.log(`[TTS] Connection closed: ${code} ${reason}`);

        if (!this.intentionallyClosed) {
          this.attemptReconnect();
        }
      });
    });
  }

  /**
   * Convert text to speech and stream audio chunks back via callbacks.
   *
   * If a previous speak() call is still streaming, it is cancelled first
   * so only the latest whisper is heard.
   */
  speak(whisperId: string, text: string): void {
    if (!text || text.trim().length < MIN_TEXT_LENGTH) {
      return;
    }

    if (!this.isConnected) {
      console.warn('[TTS] speak() called but WebSocket not connected');
      this.callbacks.onError?.('TTS not connected');
      return;
    }

    // Cancel any in-progress TTS before starting a new one
    this.cancel();

    const contextId = uuid();
    this.currentContextId = contextId;
    this.currentWhisperId = whisperId;
    this.chunkIndex = 0;

    // Estimate duration for UI progress indication
    const wordCount = text.trim().split(/\s+/).length;
    const estimatedDurationMs = wordCount * MS_PER_WORD;

    this.callbacks.onStart({ whisperId, estimatedDurationMs });

    const message = {
      model_id: CARTESIA_MODEL,
      transcript: text,
      voice: { mode: 'id', id: this.voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: 24000,
      },
      context_id: contextId,
      language: this.language,
    };

    this.send(message);
    console.log(`[TTS] speak() started — whisper=${whisperId} context=${contextId} words=${wordCount}`);
  }

  /**
   * Cancel any in-progress TTS generation.
   * Sends a cancel command to Cartesia so the server stops streaming.
   */
  cancel(): void {
    if (this.currentContextId && this.isConnected) {
      this.send({
        context_id: this.currentContextId,
        cancel: true,
      });
      console.log(`[TTS] Cancelled context=${this.currentContextId}`);
    }
    this.currentContextId = null;
    this.currentWhisperId = null;
  }

  /**
   * Update the voice ID used for future speak() calls.
   */
  updateVoice(voiceId: string): void {
    this.voiceId = voiceId;
    console.log(`[TTS] Voice updated to ${voiceId}`);
  }

  /**
   * Close the WebSocket connection and clean up all state.
   */
  async close(): Promise<void> {
    this.intentionallyClosed = true;
    this.currentContextId = null;
    this.currentWhisperId = null;
    this.connected = false;

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    console.log('[TTS] Closed');
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Handle an incoming message from the Cartesia WebSocket.
   */
  private handleMessage(msg: any): void {
    const contextId = msg.context_id;

    // Ignore messages for stale (cancelled) contexts
    if (contextId && contextId !== this.currentContextId) {
      return;
    }

    switch (msg.type) {
      case 'chunk': {
        if (!this.currentWhisperId) break;

        const audioData = msg.data;
        if (audioData) {
          this.callbacks.onAudioChunk({
            whisperId: this.currentWhisperId,
            audio: audioData,
            chunkIndex: this.chunkIndex++,
          });
        }
        break;
      }

      case 'done': {
        if (!this.currentWhisperId) break;

        console.log(`[TTS] Done — whisper=${this.currentWhisperId} chunks=${this.chunkIndex}`);
        this.callbacks.onDone({ whisperId: this.currentWhisperId });
        this.currentContextId = null;
        this.currentWhisperId = null;
        break;
      }

      case 'error': {
        const errorMsg = msg.message || msg.error || 'Cartesia TTS error';
        console.error('[TTS] Error from Cartesia:', errorMsg);
        this.callbacks.onError?.(errorMsg);
        this.currentContextId = null;
        this.currentWhisperId = null;
        break;
      }

      default:
        // Informational or unrecognized messages — log for debugging
        console.log(`[TTS] Message type: ${msg.type || 'unknown'}`);
    }
  }

  /**
   * Send a JSON payload over the WebSocket.
   */
  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn('[TTS] Tried to send but WebSocket not open');
    }
  }

  /**
   * Attempt to reconnect with exponential backoff (max 3 attempts).
   */
  private async attemptReconnect(): Promise<void> {
    if (this.intentionallyClosed) return;

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      this.reconnectAttempts = i + 1;
      const delay = 1000 * Math.pow(2, i); // 1s, 2s, 4s
      console.log(`[TTS] Reconnect attempt ${i + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));

      if (this.intentionallyClosed) return;

      try {
        await this.connect(true);
        console.log('[TTS] Reconnected successfully');
        return;
      } catch (err) {
        console.error(`[TTS] Reconnect attempt ${i + 1} failed:`, err);
      }
    }

    console.error('[TTS] All reconnect attempts failed');
    this.callbacks.onError?.('TTS connection lost after max reconnect attempts');
  }
}
