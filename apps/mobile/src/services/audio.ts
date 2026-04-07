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
 * ─── TUNING ───
 *
 * POLL_MS: How often we check for new audio. 100ms ≈ real-time.
 *   getInfoAsync acts as a cheap gate (1ms) — we only do the expensive
 *   file read when the file actually grew. So 100ms is fine on CPU.
 *
 * RESTART_MS: Reset the recording file every 8s.
 *   At 16kHz/16bit/mono = 32KB/s → ~256KB per 8s.
 *   Smaller file = faster reads = lower latency.
 *
 * STALE_LIMIT: If no new data for this many cycles, iOS file caching
 *   is blocking us — fall back to stop/start mode.
 */
const POLL_MS = 100;
const RESTART_MS = 8_000;
const STALE_LIMIT = 10; // 10 × 100ms = 1s
const FALLBACK_INTERVAL_MS = 800;

/** Current gain factor. Controlled by the UI slider. */
let currentGain = 2.0;

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

// ─── GAIN CONTROL ───

/**
 * Set the mic sensitivity gain factor.
 * 1.0 = original volume, 2.0 = 2× louder, 4.0 = 4× louder.
 * Higher values pick up quieter/distant voices but also amplify noise.
 */
export function setGain(factor: number) {
  currentGain = Math.max(0.5, Math.min(6.0, factor));
}

/** Get the current gain factor. */
export function getGain(): number {
  return currentGain;
}

/**
 * Amplify PCM audio samples by the given gain factor.
 * Input: Uint8Array of little-endian 16-bit signed PCM samples.
 * Clamps to [-32768, 32767] to prevent overflow distortion.
 */
function amplifyPcm(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1.0) return pcm;

  // Ensure even length (16-bit samples = 2 bytes each)
  const len = pcm.length & ~1;
  const out = new Uint8Array(len);
  const inView = new DataView(pcm.buffer, pcm.byteOffset, len);
  const outView = new DataView(out.buffer, 0, len);

  for (let i = 0; i < len; i += 2) {
    let sample = inView.getInt16(i, true); // little-endian
    sample = (sample * gain) | 0; // fast float→int truncation
    // Clamp to 16-bit signed range
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    outView.setInt16(i, sample, true);
  }

  return out;
}

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

    if (chunkId === 'data') return offset + 8;

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset += 1;
  }

  console.warn('[audio] "data" chunk not found, fallback to 44');
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

function byteOffsetToBase64(byteOffset: number): number {
  const alignedBytes = Math.ceil(byteOffset / 3) * 3;
  return (alignedBytes / 3) * 4;
}

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
 * Start recording and stream amplified PCM chunks via the callback.
 *
 * Strategy: delta-read the growing WAV file every 100ms.
 * Falls back to stop/start if iOS file caching blocks reads.
 * Applies gain amplification before sending.
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

  let pcmB64Start = -1;
  let lastSent = 0;
  let lastSize = 0;
  let stale = 0;
  let fallback = false;
  let segStart = Date.now();

  processing = false;
  console.log('[audio] Started — delta-read mode, 100ms poll');

  const emit = (pcm: Uint8Array) => {
    const amplified = amplifyPcm(pcm, currentGain);
    if (amplified.length > 0) onAudioData(amplified);
  };

  pollingInterval = setInterval(async () => {
    if (processing || !recording) return;
    processing = true;

    try {
      if (fallback) {
        await doStopStart(emit);
      } else {
        const r = await doDeltaRead(emit, {
          pcmB64Start, lastSent, lastSize, stale, segStart,
        });
        pcmB64Start = r.pcmB64Start;
        lastSent = r.lastSent;
        lastSize = r.lastSize;
        stale = r.stale;
        segStart = r.segStart;

        if (r.stale >= STALE_LIMIT && r.hadData) {
          console.warn('[audio] Stale — switching to stop/start fallback');
          fallback = true;
          try {
            const uri = recording?.getURI();
            await recording?.stopAndUnloadAsync();
            if (uri) deleteAsync(uri, { idempotent: true }).catch(() => {});
          } catch {}
          // Restart the interval at a slower rate for fallback
          if (pollingInterval) clearInterval(pollingInterval);
          pollingInterval = setInterval(async () => {
            if (processing || !recording) return;
            processing = true;
            try { await doStopStart(emit); }
            catch (e) { console.warn('[audio] Fallback error:', e); }
            finally { processing = false; }
          }, FALLBACK_INTERVAL_MS);
        }
      }
    } catch (err) {
      console.warn('[audio] Cycle error:', err);
    } finally {
      processing = false;
    }
  }, POLL_MS);
}

// ─── DELTA-READ ───

interface DS {
  pcmB64Start: number;
  lastSent: number;
  lastSize: number;
  stale: number;
  segStart: number;
}

async function doDeltaRead(
  emit: (pcm: Uint8Array) => void,
  s: DS
): Promise<DS & { hadData: boolean }> {
  let { pcmB64Start, lastSent, lastSize, stale, segStart } = s;

  const rec = recording;
  if (!rec) return { ...s, hadData: false };
  const uri = rec.getURI();
  if (!uri) return { ...s, hadData: false };

  // Cheap size gate — avoid full read if nothing changed
  const info = await getInfoAsync(uri);
  if (!info.exists || info.size < 100) return { ...s, hadData: false };

  const hadData = lastSize > 0;
  if (info.size === lastSize) {
    stale++;
    return { pcmB64Start, lastSent, lastSize, stale, segStart, hadData };
  }

  stale = 0;
  lastSize = info.size;

  const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
  if (!b64 || b64.length < 80) return { ...s, hadData };

  if (pcmB64Start < 0) {
    const hdr = base64ToBytes(b64, 8192);
    const off = findPcmDataOffset(hdr);
    if (off <= 0) return { pcmB64Start, lastSent, lastSize, stale, segStart, hadData };
    pcmB64Start = byteOffsetToBase64(off);
    lastSent = pcmB64Start;
    console.log(`[audio] PCM @ byte ${off} (b64 ${pcmB64Start})`);
  }

  const end = Math.floor(b64.length / 4) * 4;
  if (end > lastSent) {
    const chunk = b64.substring(lastSent, end);
    if (chunk.length > 0) {
      const pcm = decodeBase64ToBuffer(chunk);
      if (pcm.length > 0) emit(pcm);
    }
    lastSent = end;
  }

  // Periodic restart
  if (Date.now() - segStart >= RESTART_MS) {
    console.log('[audio] Restarting (periodic)');
    try { await rec.stopAndUnloadAsync(); } catch {}
    deleteAsync(uri, { idempotent: true }).catch(() => {});
    recording = new Audio.Recording();
    await recording.prepareToRecordAsync(RECORDING_OPTIONS);
    await recording.startAsync();
    pcmB64Start = -1;
    lastSent = 0;
    lastSize = 0;
    segStart = Date.now();
  }

  return { pcmB64Start, lastSent, lastSize, stale, segStart, hadData };
}

// ─── STOP/START FALLBACK ───

async function doStopStart(emit: (pcm: Uint8Array) => void) {
  const rec = recording;
  if (!rec) return;

  await rec.stopAndUnloadAsync();
  const uri = rec.getURI();

  recording = new Audio.Recording();
  await recording.prepareToRecordAsync(RECORDING_OPTIONS);
  await recording.startAsync();

  if (uri) {
    try {
      const b64 = await readAsStringAsync(uri, { encoding: EncodingType.Base64 });
      if (b64 && b64.length > 80) {
        const hdr = base64ToBytes(b64, 8192);
        const off = findPcmDataOffset(hdr);
        if (off > 0) {
          const start = byteOffsetToBase64(off);
          const end = Math.floor(b64.length / 4) * 4;
          if (end > start) {
            const pcm = decodeBase64ToBuffer(b64.substring(start, end));
            if (pcm.length > 0) emit(pcm);
          }
        }
      }
    } catch (e) {
      console.warn('[audio] Fallback read error:', e);
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
      const st = await recording.getStatusAsync();
      if (st.isRecording) await recording.stopAndUnloadAsync();
    } catch {}
    try {
      const uri = recording.getURI();
      if (uri) await deleteAsync(uri, { idempotent: true }).catch(() => {});
    } catch {}
    recording = null;
  }

  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}
