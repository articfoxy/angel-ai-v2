/**
 * TTS Audio Playback Service for Angel AI.
 *
 * Receives base64-encoded PCM audio chunks from the server (via socket.io)
 * and plays them through AirPods using react-native-audio-api's
 * AudioBufferQueueSourceNode for gapless streaming playback.
 */
import { AudioContext, AudioBufferQueueSourceNode } from 'react-native-audio-api';

const SAMPLE_RATE = 24000; // Cartesia outputs 24kHz
const NUM_CHANNELS = 1;    // Mono
const PRE_BUFFER_CHUNKS = 2; // Buffer 2 chunks before starting playback

interface TTSPlayerConfig {
  onPlaybackStart?: (whisperId: string) => void;
  onPlaybackDone?: (whisperId: string) => void;
}

class TTSPlayer {
  private audioContext: AudioContext | null = null;
  private queueSource: AudioBufferQueueSourceNode | null = null;
  private config: TTSPlayerConfig;
  private currentWhisperId: string | null = null;
  private chunkBuffer: string[] = []; // Pre-buffer before playback
  private isPlaying = false;
  private chunksReceived = 0;
  private playbackStarted = false;

  constructor(config: TTSPlayerConfig = {}) {
    this.config = config;
  }

  /**
   * Initialize the audio context. Call once when session starts.
   */
  async init(): Promise<void> {
    if (this.audioContext) return;
    this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    console.log('[TTS] AudioContext initialized, sample rate:', this.audioContext.sampleRate);
  }

  /**
   * Prepare for a new whisper's audio. Resets internal state.
   */
  startWhisper(whisperId: string): void {
    // If already playing something, stop it first
    if (this.isPlaying) {
      this.stop();
    }

    this.currentWhisperId = whisperId;
    this.chunkBuffer = [];
    this.chunksReceived = 0;
    this.playbackStarted = false;
    this.isPlaying = true;

    // Create a fresh queue source node
    if (this.audioContext) {
      this.queueSource = this.audioContext.createBufferQueueSource();
      this.queueSource.connect(this.audioContext.destination);
      this.queueSource.onEnded = () => {
        if (this.isPlaying && this.currentWhisperId) {
          console.log('[TTS] Playback finished:', this.currentWhisperId);
          const id = this.currentWhisperId;
          this.isPlaying = false;
          this.currentWhisperId = null;
          this.config.onPlaybackDone?.(id);
        }
      };
    }

    console.log('[TTS] Ready for whisper:', whisperId);
  }

  /**
   * Feed a base64-encoded PCM chunk (16-bit signed LE, 24kHz mono).
   */
  feedChunk(whisperId: string, base64Audio: string): void {
    if (whisperId !== this.currentWhisperId || !this.audioContext || !this.queueSource) return;

    this.chunksReceived++;

    if (!this.playbackStarted) {
      // Pre-buffer: collect chunks before starting playback to avoid gaps
      this.chunkBuffer.push(base64Audio);
      if (this.chunkBuffer.length >= PRE_BUFFER_CHUNKS) {
        this.flushBufferAndStart();
      }
    } else {
      // Streaming: decode and push directly to queue
      const audioBuffer = this.decodeBase64PCM(base64Audio);
      if (audioBuffer) {
        this.enqueueAudio(audioBuffer);
      }
    }
  }

  private flushBufferAndStart(): void {
    if (!this.audioContext || !this.queueSource) return;

    for (const chunk of this.chunkBuffer) {
      const audioBuffer = this.decodeBase64PCM(chunk);
      if (audioBuffer) {
        this.enqueueAudio(audioBuffer);
      }
    }
    this.chunkBuffer = [];

    this.queueSource.start();
    this.playbackStarted = true;

    if (this.currentWhisperId) {
      console.log('[TTS] Playback started:', this.currentWhisperId, 'after', this.chunksReceived, 'chunks');
      this.config.onPlaybackStart?.(this.currentWhisperId);
    }
  }

  private enqueueAudio(float32Data: Float32Array): void {
    if (!this.audioContext || !this.queueSource) return;

    const buffer = this.audioContext.createBuffer(NUM_CHANNELS, float32Data.length, SAMPLE_RATE);
    buffer.copyToChannel(float32Data, 0, 0);
    this.queueSource.enqueueBuffer(buffer);
  }

  /**
   * Decode base64-encoded PCM (16-bit signed LE) to Float32Array.
   */
  private decodeBase64PCM(base64: string): Float32Array | null {
    try {
      // Decode base64 to binary string
      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert 16-bit signed LE PCM to Float32
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768; // Normalize to [-1, 1]
      }

      return float32;
    } catch (err) {
      console.error('[TTS] Failed to decode PCM chunk:', err);
      return null;
    }
  }

  /**
   * Signal that all chunks have been sent for the current whisper.
   * If we haven't started playback yet (not enough chunks), flush and start anyway.
   */
  finishWhisper(whisperId: string): void {
    if (whisperId !== this.currentWhisperId) return;

    if (!this.playbackStarted && this.chunkBuffer.length > 0) {
      // Didn't reach pre-buffer threshold — flush what we have
      this.flushBufferAndStart();
    }
    // The onEnded callback will fire when all audio finishes playing
  }

  /**
   * Immediately stop any playing audio.
   */
  stop(): void {
    if (this.queueSource) {
      try { this.queueSource.clearBuffers(); } catch {}
      try { this.queueSource.stop(); } catch {}
      try { this.queueSource.disconnect(); } catch {}
      this.queueSource = null;
    }

    const id = this.currentWhisperId;
    this.isPlaying = false;
    this.currentWhisperId = null;
    this.chunkBuffer = [];
    this.chunksReceived = 0;
    this.playbackStarted = false;

    if (id) {
      console.log('[TTS] Stopped:', id);
    }
  }

  /**
   * Clean up everything. Call when session ends.
   */
  async dispose(): Promise<void> {
    this.stop();
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    console.log('[TTS] Disposed');
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get activeWhisperId(): string | null {
    return this.currentWhisperId;
  }
}

// Singleton instance
let instance: TTSPlayer | null = null;

export function getTTSPlayer(config?: TTSPlayerConfig): TTSPlayer {
  if (!instance) {
    instance = new TTSPlayer(config);
  }
  return instance;
}

export function disposeTTSPlayer(): void {
  if (instance) {
    instance.dispose();
    instance = null;
  }
}

export type { TTSPlayer };
