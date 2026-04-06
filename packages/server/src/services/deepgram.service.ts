import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { v4 as uuid } from 'uuid';
import { prisma } from '../index';

interface DeepgramConfig {
  onTranscript: (data: {
    id: string;
    text: string;
    speaker?: string;
    speakerLabel?: string;
    timestamp: number;
    isFinal: boolean;
  }) => void;
  onSpeakerIdentified: (speakerId: string, label: string) => void;
  sessionId: string;
  userId: string;
}

const CONNECTION_TIMEOUT_MS = 5000;
const MAX_BUFFERED_CHUNKS = 10;

export class DeepgramService {
  private connection: any = null;
  private config: DeepgramConfig;
  private speakerMap: Map<number, string> = new Map();
  private speakerCounts: Map<number, number> = new Map();
  private ownerIdentified = false;
  private sessionStartTime: number = 0;
  private ready = false;
  private audioBuffer: Buffer[] = [];

  constructor(config: DeepgramConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const deepgram = createClient(process.env.DEEPGRAM_API_KEY || '');

    this.connection = deepgram.listen.live({
      model: 'nova-3',
      language: 'en',
      smart_format: true,
      diarize: true,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
    });

    // Wait for the connection to actually open before returning.
    // Audio sent before Open fires is silently dropped by Deepgram.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Deepgram connection timed out after ${CONNECTION_TIMEOUT_MS}ms for session ${this.config.sessionId}`));
      }, CONNECTION_TIMEOUT_MS);

      this.connection.on(LiveTranscriptionEvents.Open, () => {
        clearTimeout(timeout);
        this.sessionStartTime = Date.now();
        this.ready = true;

        // Flush any audio that arrived while we were connecting
        for (const chunk of this.audioBuffer) {
          this.connection.send(chunk);
        }
        this.audioBuffer = [];

        console.log(`Deepgram connected for session ${this.config.sessionId}`);
        resolve();
      });

      // If the connection errors before Open, reject immediately
      this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0];
      if (!transcript?.transcript) return;

      const words = transcript.words || [];
      const speaker = words[0]?.speaker;
      const isFinal = data.is_final;

      // Track speaker counts for owner identification
      if (speaker !== undefined && isFinal) {
        const count = this.speakerCounts.get(speaker) || 0;
        this.speakerCounts.set(speaker, count + 1);

        // After first 30s of speech, identify owner as most frequent speaker
        if (!this.ownerIdentified) {
          const totalCount = Array.from(this.speakerCounts.values()).reduce((a, b) => a + b, 0);
          if (totalCount >= 10) {
            this.identifyOwner();
          }
        }
      }

      const speakerLabel = this.getSpeakerLabel(speaker);
      const segmentId = isFinal ? uuid() : `interim-${speaker ?? 'unknown'}`;

      this.config.onTranscript({
        id: segmentId,
        text: transcript.transcript,
        speaker: speaker !== undefined ? `speaker_${speaker}` : undefined,
        speakerLabel,
        timestamp: Date.now(),
        isFinal,
      });

      // Store final segments as episodes
      if (isFinal && transcript.transcript.trim()) {
        // data.start = seconds offset from stream start; data.duration = segment duration in seconds
        const startTime = new Date(this.sessionStartTime + (data.start ?? 0) * 1000);
        const endTime = new Date(this.sessionStartTime + ((data.start ?? 0) + (data.duration ?? 0)) * 1000);

        prisma.episode.create({
          data: {
            sessionId: this.config.sessionId,
            userId: this.config.userId,
            speaker: speakerLabel || `speaker_${speaker ?? 'unknown'}`,
            content: transcript.transcript,
            startTime,
            endTime,
          },
        }).catch((err: Error) => console.error('Episode save error:', err));
      }
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error('Deepgram error:', err);
      // Close the broken connection to prevent hanging state
      this.close();
    });
  }

  private identifyOwner() {
    let maxSpeaker = 0;
    let maxCount = 0;

    this.speakerCounts.forEach((count, speaker) => {
      if (count > maxCount) {
        maxCount = count;
        maxSpeaker = speaker;
      }
    });

    this.speakerMap.set(maxSpeaker, 'Owner');
    this.config.onSpeakerIdentified(`speaker_${maxSpeaker}`, 'Owner');

    // Label other speakers
    const letters = ['A', 'B', 'C', 'D', 'E'];
    let letterIdx = 0;
    this.speakerCounts.forEach((_, speaker) => {
      if (speaker !== maxSpeaker) {
        const label = `Person ${letters[letterIdx] || letterIdx}`;
        this.speakerMap.set(speaker, label);
        this.config.onSpeakerIdentified(`speaker_${speaker}`, label);
        letterIdx++;
      }
    });

    this.ownerIdentified = true;
  }

  private getSpeakerLabel(speaker?: number): string | undefined {
    if (speaker === undefined) return undefined;
    return this.speakerMap.get(speaker) || `Speaker ${speaker}`;
  }

  getSpeakers(): Record<string, string> {
    const speakers: Record<string, string> = {};
    this.speakerMap.forEach((label, speaker) => {
      speakers[`speaker_${speaker}`] = label;
    });
    return speakers;
  }

  sendAudio(data: Buffer) {
    if (!this.connection) return;

    if (this.ready) {
      this.connection.send(data);
    } else if (this.audioBuffer.length < MAX_BUFFERED_CHUNKS) {
      // Buffer audio until the connection is ready (up to MAX_BUFFERED_CHUNKS)
      this.audioBuffer.push(data);
    }
    // Chunks beyond the buffer limit are dropped to avoid unbounded memory growth
  }

  close() {
    if (this.connection) {
      this.connection.finish();
      this.connection = null;
    }
    this.ready = false;
    this.audioBuffer = [];
  }
}
