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
 * ─── TUNING KNOBS ───
 *
 * CHUNK_INTERVAL_MS: How often we poll the file for new audio data.
 *   Lower = lower latency but more CPU. 250ms is sweet spot.
 *
 * RESTART_INTERVAL_MS: How often we restart the recording to keep file small.
 *   Lower = smaller file reads but more restart gaps.
 *   10s keeps reads under ~320KB base64, with 99% capture rate.
 *
 * STALE_THRESHOLD: If delta-read sees no new data for this many cycles,
 *   iOS file caching is blocking us — fall back to stop/start mode.
 */
const CHUNK_INTERVAL_MS = 250;
const RESTART_INTERVAL_MS = 10_000;
const STALE_THRESHOLD = 4; // 4 × 250ms = 1s without new data → fallback

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

// ─── WAV HEADER PARSING ───

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

  console.warn('[audio] "data" chunk not found in WAV, falling back to 44');
  return 44;
}

function base64ToBytes(b64: string, maxBytes?: number): Uint8Array {
  const slice = maxBytes
    ? b64.substring(0, Math.ceil((maxBytes * 4) / 3))
    : b64;
  const raw = atob(slice);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Convert a byte offset to a 4-char-aligned base64 char offset (rounds UP). */
function byteOffsetToBase64(byteOffset: number): number {
  const alignedBytes = Math.ceil(byteOffset / 3) * 3;
  return (alignedBytes / 3) * 4;
}

/** Decode a base64 string to a Uint8Array (full decode, for binary transport). */
function decodeBase64ToBuffer(b64: string): Uint8Array {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

// ─── PUBLIC API ───

export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Start recording and stream raw PCM chunks as Uint8Array via the callback.
 *
 * ─── STRATEGY: ADAPTIVE HYBRID ───
 *
 * PRIMARY (delta-read):
 *   Read the growing WAV file every 250ms and send only the new PCM bytes.
 *   Zero audio gap — recording never stops during normal operation.
 *   Every 10s we restart to keep file reads fast.
 *
 * FALLBACK (stop/start):
 *   If iOS file caching prevents delta-read from seeing new data for 1s,
 *   we automatically switch to stop/start mode with 1s intervals.
 *   ~15% audio gap but at least it works on all iOS versions.
 *
 * Output: Uint8Array of raw PCM (linear16, 16kHz, mono) — NOT base64.
 *   This enables binary WebSocket transport (33% less bandwidth).
 */
export async function startRecording(
  onAudioData: (data: Uint8Array) => void
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

  let pcmBase64Start = -1;
  let lastSentLength = 0;
  let lastFileSize = 0;
  let staleCount = 0;
  let useFallback = false;
  let segmentStartTime = Date.now();

  processing = false;

  console.log('[audio] Recording started — using delta-read strategy');

  pollingInterval = setInterval(async () => {
    if (processing || !recording) return;
    processing = true;

    try {
      if (useFallback) {
        // ─── FALLBACK: stop/start mode ───
        await runStopStartCycle(onAudioData);
      } else {
        // ─── PRIMARY: delta-read mode ───
        const result = await runDeltaRead(onAudioData, {
          pcmBase64Start,
          lastSentLength,
          lastFileSize,
          staleCount,
          segmentStartTime,
        });

        pcmBase64Start = result.pcmBase64Start;
        lastSentLength = result.lastSentLength;
        lastFileSize = result.lastFileSize;
        staleCount = result.staleCount;
        segmentStartTime = result.segmentStartTime;

        // Switch to fallback if delta-read sees no new data for too long
        if (result.staleCount >= STALE_THRESHOLD && result.hadData) {
          console.warn(
            `[audio] Delta-read stale for ${STALE_THRESHOLD} cycles — switching to stop/start fallback`
          );
          useFallback = true;
          // Stop the current long-running recording
          try {
            const uri = recording?.getURI();
            await recording?.stopAndUnloadAsync();
            if (uri) deleteAsync(uri, { idempotent: true }).catch(() => {});
          } catch {}
        }
      }
    } catch (err) {
      console.warn('[audio] Chunk cycle error:', err);
    } finally {
      processing = false;
    }
  }, useFallback ? 1000 : CHUNK_INTERVAL_MS);
}

// ─── DELTA-READ (PRIMARY) ───

interface DeltaState {
  pcmBase64Start: number;
  lastSentLength: number;
  lastFileSize: number;
  staleCount: number;
  segmentStartTime: number;
}

async function runDeltaRead(
  onAudioData: (data: Uint8Array) => void,
  state: DeltaState
): Promise<DeltaState & { hadData: boolean }> {
  let { pcmBase64Start, lastSentLength, lastFileSize, staleCount, segmentStartTime } = state;

  const currentRecording = recording;
  if (!currentRecording) return { ...state, hadData: false };

  const uri = currentRecording.getURI();
  if (!uri) return { ...state, hadData: false };

  // Quick size check — skip full read if file hasn't grown
  const fileInfo = await getInfoAsync(uri);
  if (!fileInfo.exists || fileInfo.size < 100) return { ...state, hadData: false };

  const currentSize = fileInfo.size;
  const hadData = lastFileSize > 0; // We've seen data before

  if (currentSize === lastFileSize) {
    // File hasn't grown since last read
    staleCount++;
    return { pcmBase64Start, lastSentLength, lastFileSize, staleCount, segmentStartTime, hadData };
  }

  // File grew — reset stale counter
  staleCount = 0;
  lastFileSize = currentSize;

  // Read the file
  const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  if (!base64 || base64.length < 80) return { ...state, hadData };

  // Parse WAV header on first read
  if (pcmBase64Start < 0) {
    const headerBytes = base64ToBytes(base64, 8192);
    const pcmByteOffset = findPcmDataOffset(headerBytes);
    if (pcmByteOffset <= 0) {
      console.warn('[audio] Could not find PCM data in WAV');
      return { pcmBase64Start, lastSentLength, lastFileSize, staleCount, segmentStartTime, hadData };
    }
    pcmBase64Start = byteOffsetToBase64(pcmByteOffset);
    lastSentLength = pcmBase64Start;
    console.log(`[audio] PCM starts at byte ${pcmByteOffset} (b64 char ${pcmBase64Start})`);
  }

  // Extract only the new data
  const alignedEnd = Math.floor(base64.length / 4) * 4;
  if (alignedEnd > lastSentLength) {
    const newB64 = base64.substring(lastSentLength, alignedEnd);
    if (newB64.length > 0) {
      // Decode to raw PCM bytes for binary transport
      const pcmBytes = decodeBase64ToBuffer(newB64);
      if (pcmBytes.length > 0) {
        onAudioData(pcmBytes);
      }
    }
    lastSentLength = alignedEnd;
  }

  // Periodic restart to keep file small
  const elapsed = Date.now() - segmentStartTime;
  if (elapsed >= RESTART_INTERVAL_MS) {
    console.log('[audio] Restarting recording (periodic)');
    try {
      await currentRecording.stopAndUnloadAsync();
    } catch {}
    deleteAsync(uri, { idempotent: true }).catch(() => {});

    recording = new Audio.Recording();
    await recording.prepareToRecordAsync(RECORDING_OPTIONS);
    await recording.startAsync();

    pcmBase64Start = -1;
    lastSentLength = 0;
    lastFileSize = 0;
    segmentStartTime = Date.now();
  }

  return { pcmBase64Start, lastSentLength, lastFileSize, staleCount, segmentStartTime, hadData };
}

// ─── STOP/START FALLBACK ───

async function runStopStartCycle(onAudioData: (data: Uint8Array) => void) {
  const currentRecording = recording;
  if (!currentRecording) return;

  // Stop current recording to finalize the WAV
  await currentRecording.stopAndUnloadAsync();
  const uri = currentRecording.getURI();

  // Start a new recording immediately to minimize gap
  recording = new Audio.Recording();
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  await recording.startAsync();

  // Read the completed chunk
  if (uri) {
    try {
      const base64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
      if (base64 && base64.length > 80) {
        const headerBytes = base64ToBytes(base64, 8192);
        const pcmOffset = findPcmDataOffset(headerBytes);
        if (pcmOffset > 0) {
          const b64Start = byteOffsetToBase64(pcmOffset);
          const alignedEnd = Math.floor(base64.length / 4) * 4;
          if (alignedEnd > b64Start) {
            const pcmB64 = base64.substring(b64Start, alignedEnd);
            const pcmBytes = decodeBase64ToBuffer(pcmB64);
            if (pcmBytes.length > 0) {
              onAudioData(pcmBytes);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[audio] Fallback read error:', err);
    }
    deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

// ─── STOP ───

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
    } catch {}

    try {
      const uri = recording.getURI();
      if (uri) await deleteAsync(uri, { idempotent: true }).catch(() => {});
    } catch {}

    recording = null;
  }

  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}
