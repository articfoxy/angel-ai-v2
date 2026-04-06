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

export class DeepgramService {
  private connection: any = null;
  private config: DeepgramConfig;
  private speakerMap: Map<number, string> = new Map();
  private speakerCounts: Map<number, number> = new Map();
  private ownerIdentified = false;

  constructor(config: DeepgramConfig) {
    this.config = config;
  }

  async connect() {
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

    this.connection.on(LiveTranscriptionEvents.Open, () => {
      console.log(`Deepgram connected for session ${this.config.sessionId}`);
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
        prisma.episode.create({
          data: {
            sessionId: this.config.sessionId,
            userId: this.config.userId,
            speaker: speakerLabel || `speaker_${speaker ?? 'unknown'}`,
            content: transcript.transcript,
            startTime: new Date(data.start * 1000 + Date.now() - data.duration * 1000),
            endTime: new Date(),
          },
        }).catch((err: Error) => console.error('Episode save error:', err));
      }
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error('Deepgram error:', err);
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

  sendAudio(data: Buffer) {
    if (this.connection) {
      this.connection.send(data);
    }
  }

  close() {
    if (this.connection) {
      this.connection.finish();
      this.connection = null;
    }
  }
}
