import { Audio } from 'expo-av';
import {
  readAsStringAsync,
  deleteAsync,
  getInfoAsync,
  EncodingType,
} from 'expo-file-system/legacy';
import { decode as atob } from 'base-64';

let recording: Audio.Recording | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let processing = false;

/**
 * Interval between chunk reads (ms).
 * We read the growing file every 300ms — no stop/start gap.
 */
const CHUNK_INTERVAL_MS = 300;

/**
 * Restart the recording every ~30s to prevent the WAV file from growing too
 * large (at 16kHz/16bit/mono ≈ 32KB/s → ~960KB per 30s). During the brief
 * restart gap (~100ms) we lose a tiny amount of audio, but 99.7% is captured.
 */
const RESTART_INTERVAL_MS = 30_000;

const RECORDING_OPTIONS: Audio.RecordingOptions = {
  isMeteringEnabled: false,
  android: {
    extension: '.wav',
    outputFormat: Audio.AndroidOutputFormat.DEFAULT,
    audioEncoder: Audio.AndroidAudioEncoder.DEFAULT,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
  },
  ios: {
    extension: '.wav',
    outputFormat: Audio.IOSOutputFormat.LINEARPCM,
    audioQuality: Audio.IOSAudioQuality.HIGH,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 256000,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/wav',
    bitsPerSecond: 256000,
  },
};

/**
 * Find the byte offset where the actual PCM "data" chunk begins in a WAV file.
 *
 * WAV files are RIFF containers with variable-length sub-chunks. The standard
 * header is 44 bytes, but expo-av (especially on iOS) may insert extra
 * metadata chunks (e.g., "LIST", "FLLR") before the "data" chunk, making the
 * header length unpredictable.
 *
 * This function properly parses the RIFF structure to find the "data" sub-chunk
 * and returns the offset of the first PCM sample byte.
 */
function findPcmDataOffset(bytes: Uint8Array): number {
  if (bytes.length < 44) return -1;

  const riff =
    String.fromCharCode(bytes[0]) +
    String.fromCharCode(bytes[1]) +
    String.fromCharCode(bytes[2]) +
    String.fromCharCode(bytes[3]);
  if (riff !== 'RIFF') return -1;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId =
      String.fromCharCode(bytes[offset]) +
      String.fromCharCode(bytes[offset + 1]) +
      String.fromCharCode(bytes[offset + 2]) +
      String.fromCharCode(bytes[offset + 3]);

    const chunkSize =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);

    if (chunkId === 'data') {
      return offset + 8;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }

  console.warn('[audio] "data" chunk not found in WAV, falling back to 44-byte offset');
  return 44;
}

/**
 * Convert a base64 string to Uint8Array.
 * Only decodes up to maxBytes for header parsing.
 */
function base64ToBytes(b64: string, maxBytes?: number): Uint8Array {
  const slice = maxBytes ? b64.substring(0, Math.ceil((maxBytes * 4) / 3)) : b64;
  const raw = atob(slice);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert a byte offset to a base64-aligned character offset.
 * Rounds UP to the next 4-char boundary so we never include header bytes.
 */
function byteOffsetToBase64(byteOffset: number): number {
  // 3 bytes = 4 base64 chars
  // Round byte offset up to next multiple of 3, then convert
  const alignedBytes = Math.ceil(byteOffset / 3) * 3;
  return (alignedBytes / 3) * 4;
}

/**
 * Request microphone permission.
 */
export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Start audio recording and stream base64-encoded PCM chunks
 * via the onAudioData callback.
 *
 * ─── HOW IT WORKS ───
 * Instead of stop/start cycling (which loses 40-80% of audio in the gap),
 * we READ the growing WAV file while recording continues, and send only the
 * new PCM data since the last read. This gives us zero-gap audio streaming.
 *
 * Every ~30 seconds we restart the recording to prevent the file from growing
 * unboundedly. The brief restart gap (~100ms) loses <0.3% of audio.
 *
 * Audio format: linear16 PCM, 16 kHz, mono — matching Deepgram's configuration.
 */
export async function startRecording(
  onAudioData: (data: string) => void
): Promise<void> {
  await stopRecording();

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
  });

  recording = new Audio.Recording();
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  await recording.startAsync();

  /** Base64 char position of the PCM data start in the current WAV file */
  let pcmBase64Start = -1;
  /** How many base64 chars we've already sent from the current file */
  let lastSentLength = 0;
  /** Timestamp of the current recording segment start */
  let segmentStartTime = Date.now();

  processing = false;

  pollingInterval = setInterval(async () => {
    if (processing || !recording) return;
    processing = true;

    try {
      const currentRecording = recording;
      const uri = currentRecording.getURI();
      if (!uri) {
        processing = false;
        return;
      }

      // Check the file exists and has data before reading
      const fileInfo = await getInfoAsync(uri);
      if (!fileInfo.exists || fileInfo.size < 100) {
        processing = false;
        return;
      }

      // Read the entire file as base64 (this includes the WAV header + all PCM data so far)
      const base64 = await readAsStringAsync(uri, {
        encoding: EncodingType.Base64,
      });

      if (!base64 || base64.length < 80) {
        processing = false;
        return;
      }

      // On first read of a new file, parse WAV header to find PCM data offset
      if (pcmBase64Start < 0) {
        const headerBytes = base64ToBytes(base64, 8192);
        const pcmByteOffset = findPcmDataOffset(headerBytes);
        if (pcmByteOffset <= 0) {
          console.warn('[audio] Could not find PCM data in WAV file');
          processing = false;
          return;
        }

        pcmBase64Start = byteOffsetToBase64(pcmByteOffset);
        lastSentLength = pcmBase64Start;
        console.log(`[audio] WAV PCM starts at byte ${pcmByteOffset} (base64 char ${pcmBase64Start})`);
      }

      // Align the readable end to a 4-char base64 boundary
      const alignedEnd = Math.floor(base64.length / 4) * 4;

      // Send only the new PCM data since last read
      if (alignedEnd > lastSentLength) {
        const chunk = base64.substring(lastSentLength, alignedEnd);
        if (chunk.length > 0) {
          onAudioData(chunk);
        }
        lastSentLength = alignedEnd;
      }

      // Periodically restart recording to prevent unbounded file growth
      const elapsed = Date.now() - segmentStartTime;
      if (elapsed >= RESTART_INTERVAL_MS) {
        console.log('[audio] Restarting recording to prevent file bloat');

        // Stop the old recording
        try {
          await currentRecording.stopAndUnloadAsync();
        } catch {
          // May already be stopped
        }
        deleteAsync(uri, { idempotent: true }).catch(() => {});

        // Start fresh
        recording = new Audio.Recording();
        await recording.prepareToRecordAsync(RECORDING_OPTIONS);
        await recording.startAsync();

        // Reset state for the new file
        pcmBase64Start = -1;
        lastSentLength = 0;
        segmentStartTime = Date.now();
      }
    } catch (err) {
      console.warn('[audio] Chunk read error (may be normal during stop):', err);
    } finally {
      processing = false;
    }
  }, CHUNK_INTERVAL_MS);
}

/**
 * Stop recording and clean up all resources.
 */
export async function stopRecording(): Promise<void> {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  processing = false;

  if (recording) {
    try {
      const status = await recording.getStatusAsync();
      if (status.isRecording) {
        await recording.stopAndUnloadAsync();
      }
    } catch {
      // Recording may already be stopped
    }

    try {
      const uri = recording.getURI();
      if (uri) {
        await deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    } catch {
      // ignore
    }

    recording = null;
  }

  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
  }).catch(() => {});
}
