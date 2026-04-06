import { Audio } from 'expo-av';
import {
  readAsStringAsync,
  deleteAsync,
  EncodingType,
} from 'expo-file-system/legacy';
import { decode as atob } from 'base-64';

let recording: Audio.Recording | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let processing = false;

/** Interval between chunk cycles (ms). 500ms balances chunk size vs latency. */
const CHUNK_INTERVAL_MS = 500;

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
  // Minimum WAV header: RIFF(4) + size(4) + WAVE(4) + fmt(4) + size(4) + ...
  if (bytes.length < 44) return -1;

  // Verify RIFF header
  const riff =
    String.fromCharCode(bytes[0]) +
    String.fromCharCode(bytes[1]) +
    String.fromCharCode(bytes[2]) +
    String.fromCharCode(bytes[3]);
  if (riff !== 'RIFF') return -1;

  // Start scanning sub-chunks after the 12-byte RIFF/WAVE header
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId =
      String.fromCharCode(bytes[offset]) +
      String.fromCharCode(bytes[offset + 1]) +
      String.fromCharCode(bytes[offset + 2]) +
      String.fromCharCode(bytes[offset + 3]);

    // Chunk size is a 32-bit little-endian int at offset+4
    const chunkSize =
      bytes[offset + 4] |
      (bytes[offset + 5] << 8) |
      (bytes[offset + 6] << 16) |
      (bytes[offset + 7] << 24);

    if (chunkId === 'data') {
      // PCM data starts right after the 8-byte chunk header (id + size)
      return offset + 8;
    }

    // Move to next chunk: header (8 bytes) + chunk data (chunkSize bytes)
    // Chunks are word-aligned (pad to even byte boundary)
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1; // padding byte
  }

  // "data" chunk not found — fall back to standard 44 bytes
  console.warn('[audio] "data" chunk not found in WAV, falling back to 44-byte offset');
  return 44;
}

/**
 * Convert a base64 string to Uint8Array.
 * We only need the first ~200 bytes to parse the WAV header.
 */
function base64ToBytes(b64: string, maxBytes?: number): Uint8Array {
  const raw = atob(maxBytes ? b64.substring(0, Math.ceil((maxBytes * 4) / 3)) : b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

/**
 * Request microphone permission.
 * Returns true if granted, false otherwise.
 */
export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Start audio recording and stream base64-encoded PCM chunks
 * via the onAudioData callback at ~500ms intervals.
 *
 * The recording is configured for linear16 PCM, 16kHz, mono —
 * matching the server's Deepgram configuration.
 *
 * A processing lock prevents the interval from firing while
 * the previous stop/read/start cycle is still in progress,
 * eliminating race conditions that caused overlapping async ops.
 */
export async function startRecording(
  onAudioData: (data: string) => void
): Promise<void> {
  // Clean up any stale recording
  await stopRecording();

  // Configure audio mode for iOS (AirPods, silent mode, background)
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
  });

  recording = new Audio.Recording();
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  await recording.startAsync();

  processing = false;

  pollingInterval = setInterval(async () => {
    // Skip if previous cycle is still running or recording was cleared
    if (processing || !recording) return;
    processing = true;

    try {
      const currentRecording = recording;

      // Stop the current recording to finalize the WAV file
      await currentRecording.stopAndUnloadAsync();
      const uri = currentRecording.getURI();

      // Start a new recording immediately to minimize the gap
      recording = new Audio.Recording();
      await recording.prepareToRecordAsync(RECORDING_OPTIONS);
      await recording.startAsync();

      // Read the completed chunk, find actual PCM data, and send it
      if (uri) {
        try {
          const base64 = await readAsStringAsync(uri, {
            encoding: EncodingType.Base64,
          });
          if (base64 && base64.length > 80) {
            // Parse the WAV header bytes to find where PCM data actually starts.
            // We only decode the first 512 bytes to find the "data" chunk offset.
            const headerBytes = base64ToBytes(base64, 512);
            const pcmOffset = findPcmDataOffset(headerBytes);

            if (pcmOffset > 0) {
              // Convert byte offset to base64 character offset:
              // Every 3 bytes = 4 base64 chars. Ensure we align to a 4-char boundary.
              const base64Offset = Math.ceil((pcmOffset * 4) / 3);
              // Round up to next multiple of 4 for valid base64 slicing
              const alignedOffset = Math.ceil(base64Offset / 4) * 4;

              if (base64.length > alignedOffset) {
                const rawPcm = base64.substring(alignedOffset);
                onAudioData(rawPcm);
              }
            }
          }
        } catch (readErr) {
          console.warn('Failed to read audio chunk file, skipping:', readErr);
        }

        // Clean up the temp file regardless of read success
        deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    } catch (err) {
      // If the recording was stopped externally (user pressed stop),
      // the interval will naturally fail — that's expected.
      console.warn('Audio chunk cycle error (may be normal during stop):', err);
    } finally {
      processing = false;
    }
  }, CHUNK_INTERVAL_MS);
}

/**
 * Stop recording and clean up all resources.
 */
export async function stopRecording(): Promise<void> {
  // Clear the polling interval first to prevent new cycles from starting
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  // Reset the lock so a future startRecording begins clean
  processing = false;

  if (recording) {
    try {
      const status = await recording.getStatusAsync();
      if (status.isRecording) {
        await recording.stopAndUnloadAsync();
      }
    } catch {
      // Recording may already be stopped — ignore
    }

    // Clean up the last file
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

  // Reset audio mode so other apps can use audio normally
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
  }).catch(() => {});
}
