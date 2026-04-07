/**
 * Live integration test for Angel AI v2 transcription pipeline.
 *
 * Connects directly to Deepgram Nova-3 with the exact same config the app
 * uses, sends ~2 seconds of generated PCM linear16 audio (a 440 Hz sine
 * tone), and logs Open / Transcript / Error events.
 *
 * Usage:
 *   cd packages/server
 *   npx ts-node --skip-project test-transcription.ts
 */

import { config } from 'dotenv';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import * as path from 'path';

// ---------------------------------------------------------------------------
// 1. Load .env from the server package directory
// ---------------------------------------------------------------------------
config({ path: path.resolve(__dirname, '.env') });

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY ?? '';

if (!DEEPGRAM_API_KEY) {
  console.error('[FAIL] DEEPGRAM_API_KEY is missing or empty. Set it in packages/server/.env');
  process.exit(1);
}

console.log(`[OK]   DEEPGRAM_API_KEY found (${DEEPGRAM_API_KEY.substring(0, 8)}...)`);

// ---------------------------------------------------------------------------
// 2. Generate ~2 seconds of PCM linear16, 16 kHz, mono audio
//    A 440 Hz sine wave — simple, deterministic, no file dependencies.
// ---------------------------------------------------------------------------
function generateToneBuffer(
  frequencyHz: number,
  durationSec: number,
  sampleRate: number,
): Buffer {
  const numSamples = sampleRate * durationSec;
  const buf = Buffer.alloc(numSamples * 2); // 2 bytes per sample (16-bit)

  for (let i = 0; i < numSamples; i++) {
    // Amplitude ~80 % of max to avoid clipping
    const sample = Math.round(0.8 * 32767 * Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate));
    buf.writeInt16LE(sample, i * 2);
  }

  return buf;
}

const SAMPLE_RATE = 16000;
const DURATION_SEC = 2;
const audioBuffer = generateToneBuffer(440, DURATION_SEC, SAMPLE_RATE);

console.log(`[OK]   Generated ${DURATION_SEC}s of 440 Hz tone (${audioBuffer.length} bytes, linear16 @ ${SAMPLE_RATE} Hz mono)`);

// ---------------------------------------------------------------------------
// 3. Connect to Deepgram with the exact app config and stream the audio
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const deepgram = createClient(DEEPGRAM_API_KEY);

  console.log('[...]  Connecting to Deepgram Nova-3...');

  const connection = deepgram.listen.live({
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

  let transcriptCount = 0;
  let opened = false;

  // -- Timeout: if nothing meaningful happens in 15 s, bail out -----------
  const timeout = setTimeout(() => {
    console.log('\n[WARN] Timed out after 15 s waiting for events.');
    printSummary();
    connection.finish();
    process.exit(opened ? 0 : 1);
  }, 15_000);

  function printSummary() {
    console.log('\n--- Summary ---');
    console.log(`  Connection opened: ${opened}`);
    console.log(`  Transcript events: ${transcriptCount}`);
  }

  // -- Event handlers -----------------------------------------------------
  connection.on(LiveTranscriptionEvents.Open, () => {
    opened = true;
    console.log('[OK]   Connection OPEN');

    // Send audio in 100 ms chunks (1600 samples = 3200 bytes per chunk)
    const chunkSize = SAMPLE_RATE * 2 * 0.1; // 3200 bytes = 100 ms
    let offset = 0;
    while (offset < audioBuffer.length) {
      const end = Math.min(offset + chunkSize, audioBuffer.length);
      connection.send(audioBuffer.subarray(offset, end));
      offset = end;
    }

    console.log(`[OK]   Sent ${audioBuffer.length} bytes of audio in ${Math.ceil(audioBuffer.length / chunkSize)} chunks`);

    // After sending all audio, wait a beat then close the stream so
    // Deepgram flushes any remaining transcripts.
    setTimeout(() => {
      console.log('[...]  Closing stream (requesting final flush)...');
      connection.finish();
    }, 3000);
  });

  connection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
    transcriptCount++;
    const alt = data.channel?.alternatives?.[0];
    const text = alt?.transcript ?? '';
    const isFinal = data.is_final;
    const speechFinal = data.speech_final;

    console.log(
      `[TRANSCRIPT #${transcriptCount}] final=${isFinal} speech_final=${speechFinal} text="${text}"`,
    );
  });

  connection.on(LiveTranscriptionEvents.Error, (err: any) => {
    console.error('[ERROR]', err?.message ?? err);
  });

  connection.on(LiveTranscriptionEvents.Close, () => {
    clearTimeout(timeout);
    console.log('[OK]   Connection CLOSED');
    printSummary();
    process.exit(transcriptCount > 0 || opened ? 0 : 1);
  });
}

run().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
