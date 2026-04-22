/**
 * ─── Audio Streaming Service ───
 *
 * True streaming audio via @siteed/audio-studio.
 *
 * Under the hood: iOS AVAudioEngine.inputNode.installTap() captures raw
 * PCM frames from the hardware (~every 64ms at 16kHz). The native module
 * accumulates frames and emits an "AudioData" event to JS every `interval`ms.
 * This is NOT polling — the native layer pushes to us.
 *
 * Audio format: linear16 PCM, 16 kHz, mono — matching Deepgram.
 *
 * ─── iOS AVAudioSession Conflict Resolution ───
 *
 * THREE packages all want to control the shared iOS AVAudioSession:
 *   1. audio-studio — configures .playAndRecord when startRecording() runs
 *   2. expo-av      — Audio.setAudioModeAsync pushes its own category
 *   3. react-native-audio-api — AudioSessionManager aggressively sets .playback
 *      on every start of its audio engine (TTS playback)
 *
 * Symptom: Listen button turns green, native tap installs successfully,
 * but zero PCM events are emitted because RNA's session manager has set
 * the category to .playback — mic input is dead.
 *
 * Fix:
 *   a) Call AudioAPI.disableSessionManagement() at module load so RNA does
 *      NOT touch the iOS audio session — audio-studio is the sole owner.
 *   b) Do NOT call Audio.setAudioModeAsync() here. audio-studio's native
 *      config already sets .playAndRecord with our options; expo-av would
 *      only create a race.
 */
import { decode as atob } from 'base-64';
import type { EventSubscription } from 'expo-modules-core';

// Low-level native module (works outside React components)
import { ExpoAudioStreamModule } from '@siteed/expo-audio-studio';
// Event listener — not re-exported from main index, import from events module directly
import {
  addAudioEventListener,
  type AudioEventPayload,
} from '@siteed/audio-studio/src/events';
import { AudioManager } from 'react-native-audio-api';

// ─── BOOT-TIME iOS AUDIO SESSION HANDOFF ───
// Tell react-native-audio-api to stay out of session management. audio-studio
// owns the AVAudioSession lifecycle because WE need .playAndRecord for the mic
// tap. Without this line, RNA sets .playback on every TTS playback cycle and
// kills mic capture permanently for the rest of the session.
try {
  AudioManager.disableSessionManagement();
  // Also announce we want playAndRecord so if anything downstream reads RNA's
  // desired category it's already pointed the right way.
  AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord',
    iosMode: 'default',
    iosOptions: ['allowBluetoothHFP', 'allowBluetoothA2DP', 'defaultToSpeaker'],
  });
} catch {
  // If RNA's native module isn't present (unlikely but possible in Expo Go)
  // just swallow — audio-studio will still work solo.
}

let currentGain = 2.0;
let isCurrentlyRecording = false;
let audioSubscription: EventSubscription | null = null;
let currentMicSource: 'auto' | 'phone' | 'bluetooth' = 'auto';
let currentOutputDevice: 'auto' | 'speaker' | 'bluetooth' = 'auto';

// ─── OBSERVABILITY ───
// Running tally of audio frames the native module has pushed to JS. The dev
// overlay on the Listen screen reads this so the user can SEE frames flowing
// without needing Railway logs. Resets to 0 each startRecording() call.
let frameCount = 0;
let lastFrameAt = 0;
let lastError: string | null = null;

export function getAudioDebugStats(): {
  frames: number;
  lastFrameAgoMs: number;
  recording: boolean;
  lastError: string | null;
} {
  return {
    frames: frameCount,
    lastFrameAgoMs: lastFrameAt === 0 ? -1 : Date.now() - lastFrameAt,
    recording: isCurrentlyRecording,
    lastError,
  };
}

// ─── GAIN CONTROL ───

/**
 * Set mic sensitivity. 1.0 = original, 2.0 = 2× louder, etc.
 * Higher values pick up distant voices but also amplify noise.
 */
export function setGain(factor: number) {
  currentGain = Math.max(0.5, Math.min(6.0, factor));
}

export function getGain(): number {
  return currentGain;
}

export function setMicSource(source: 'auto' | 'phone' | 'bluetooth') {
  currentMicSource = source;
}

export function setOutputDevice(device: 'auto' | 'speaker' | 'bluetooth') {
  currentOutputDevice = device;
}

export function getMicSource() { return currentMicSource; }
export function getOutputDevice() { return currentOutputDevice; }

/**
 * Amplify 16-bit little-endian PCM samples.
 * Clamps to [-32768, 32767] to prevent clipping.
 */
function amplifyPcm(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1.0) return pcm;

  const len = pcm.length & ~1;
  const out = new Uint8Array(len);
  const inView = new DataView(pcm.buffer, pcm.byteOffset, len);
  const outView = new DataView(out.buffer, 0, len);

  for (let i = 0; i < len; i += 2) {
    let s = inView.getInt16(i, true);
    s = (s * gain) | 0;
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    outView.setInt16(i, s, true);
  }

  return out;
}

function b64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf;
}

function float32ToPcm16(samples: Float32Array | number[]): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    view.setInt16(i * 2, int16 | 0, true);
  }
  return out;
}

/**
 * Tolerantly decode a native AudioData payload into linear16 PCM bytes.
 *
 * Handles every shape we've seen in the wild:
 *  - event.encoded (base64 string)  — current iOS path
 *  - event.data (base64 string)     — some older native builds
 *  - event.pcmFloat32 (Float32Array or number[]) — when streamFormat='float32'
 *  - event.buffer (Float32Array)    — some web builds
 *  - event.data (Int16Array)        — some legacy builds
 *
 * If nothing matches, returns null and sets lastError for the debug overlay.
 */
function decodeAudioEvent(event: AudioEventPayload & { data?: unknown; buffer?: unknown }): Uint8Array | null {
  // 1) base64 in `encoded` — the expected iOS path
  if (typeof event.encoded === 'string' && event.encoded.length > 0) {
    return b64ToBytes(event.encoded);
  }

  // 2) base64 in `data`
  const data: unknown = event.data;
  if (typeof data === 'string' && data.length > 0) {
    return b64ToBytes(data);
  }

  // 3) Int16Array in `data`
  if (data && typeof data === 'object' && data instanceof Int16Array && data.length > 0) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // 4) Float32Array in `data`
  if (data && typeof data === 'object' && data instanceof Float32Array && data.length > 0) {
    return float32ToPcm16(data);
  }

  // 5) pcmFloat32 array (iOS float32 mode)
  if (Array.isArray(event.pcmFloat32) && event.pcmFloat32.length > 0) {
    return float32ToPcm16(event.pcmFloat32);
  }
  if (event.pcmFloat32 instanceof Float32Array && event.pcmFloat32.length > 0) {
    return float32ToPcm16(event.pcmFloat32);
  }

  // 6) buffer (Float32Array)
  const buffer: unknown = event.buffer;
  if (buffer instanceof Float32Array && buffer.length > 0) {
    return float32ToPcm16(buffer);
  }

  // Nothing recognizable — record why so the overlay shows it.
  const keys = Object.keys(event || {}).join(',');
  lastError = `no-pcm-payload keys=${keys}`;
  return null;
}

// ─── AUDIO ROUTING ───

/**
 * Build iOS AVAudioSession categoryOptions based on user's mic + output preferences.
 *
 * AllowBluetooth  → enables HFP (mic + output through BT, lower quality)
 * AllowBluetoothA2DP → enables A2DP (high-quality BT output, no BT mic)
 * DefaultToSpeaker → routes output to speaker when no BT connected
 */
function buildCategoryOptions(): string[] {
  const opts: string[] = [];

  // Mic: bluetooth → need HFP (AllowBluetooth)
  const wantBtMic = currentMicSource === 'bluetooth' || currentMicSource === 'auto';
  // Output: bluetooth → need A2DP or HFP
  const wantBtOutput = currentOutputDevice === 'bluetooth' || currentOutputDevice === 'auto';
  // Output: speaker → DefaultToSpeaker
  const wantSpeaker = currentOutputDevice === 'speaker' || currentOutputDevice === 'auto';

  if (wantBtMic) opts.push('AllowBluetooth');
  if (wantBtOutput) opts.push('AllowBluetoothA2DP');
  if (wantSpeaker) opts.push('DefaultToSpeaker');

  // Ensure at least one option
  if (opts.length === 0) opts.push('DefaultToSpeaker');

  return opts;
}

// ─── PUBLIC API ───

export async function requestMicPermission(): Promise<boolean> {
  // Use audio-studio's own permission check — it's the package that actually
  // needs the permission at the native layer, and its plugin declared the
  // NSMicrophoneUsageDescription string. Going through expo-av creates a
  // chance of mismatch if the two packages disagree on "granted" state.
  try {
    const mod = ExpoAudioStreamModule as unknown as {
      requestPermissionsAsync?: () => Promise<{ status?: string; granted?: boolean }>;
    };
    const result = await mod.requestPermissionsAsync?.();
    if (result && typeof result === 'object' && 'granted' in result) {
      return !!(result as { granted: boolean }).granted;
    }
    if (result && typeof result === 'object' && 'status' in result) {
      return (result as { status: string }).status === 'granted';
    }
  } catch {}
  // Fallback path — if the native method isn't exposed, assume unknown and
  // rely on the native startRecording call to throw PERMISSION_DENIED.
  return true;
}

/**
 * Start streaming audio. Calls onAudioData every ~50ms with
 * amplified raw PCM (Uint8Array, linear16, 16kHz, mono).
 *
 * Architecture:
 *   iOS hardware → AVAudioEngine tap (continuous) →
 *   native accumulates PCM → emits "AudioData" event every 50ms →
 *   JS listener → amplify → onAudioData callback → socket.emit
 */
export async function startRecording(
  onAudioData: (data: Uint8Array) => void
): Promise<void> {
  await stopRecording();

  // Reset observability counters for this recording run
  frameCount = 0;
  lastFrameAt = 0;
  lastError = null;

  // 1. Subscribe to native "AudioData" events BEFORE starting recording.
  //    This ensures we don't miss the first chunk.
  audioSubscription = addAudioEventListener(async (event: AudioEventPayload) => {
    try {
      const pcmBytes = decodeAudioEvent(event);
      if (!pcmBytes || pcmBytes.length === 0) return;

      frameCount++;
      lastFrameAt = Date.now();

      // Log the very first chunk so the client transcript/Metro shows us the
      // pipeline is alive. Subsequent frames are silent (too noisy at 20/s).
      if (frameCount === 1) {
        console.log(`[audio] FIRST frame bytes=${pcmBytes.length}`);
      }

      const amplified = amplifyPcm(pcmBytes, currentGain);
      onAudioData(amplified);
    } catch (err: any) {
      lastError = `stream-event: ${err?.message?.slice(0, 80) || 'unknown'}`;
      console.warn('[audio] Stream event error:', err);
    }
  });

  // 2. Start native recording. Options MUST NOT contain callbacks
  //    (functions can't cross the native bridge).
  const nativeConfig = {
    sampleRate: 16000,
    channels: 1,
    encoding: 'pcm_16bit' as const,
    interval: 50, // Emit accumulated PCM every 50ms for lower latency
    keepAwake: true,
    // Don't write to file — streaming only
    output: {
      primary: { enabled: false },
    },
    ios: {
      audioSession: {
        category: 'PlayAndRecord',
        categoryOptions: buildCategoryOptions(),
        mode: 'Default',
      },
    },
  };

  console.log('[audio] Starting true streaming (50ms native emission interval)');
  try {
    await ExpoAudioStreamModule.startRecording(nativeConfig);
    isCurrentlyRecording = true;
  } catch (err: any) {
    lastError = `start-failed: ${err?.message?.slice(0, 80) || 'unknown'}`;
    // Clean up listener so we don't leak a subscription to a dead session
    if (audioSubscription) {
      try { audioSubscription.remove(); } catch {}
      audioSubscription = null;
    }
    throw err;
  }
}

/**
 * Stop recording and clean up event listeners.
 */
export async function stopRecording(): Promise<void> {
  // Remove event listener first to stop processing
  if (audioSubscription) {
    try { audioSubscription.remove(); } catch {}
    audioSubscription = null;
  }

  if (isCurrentlyRecording) {
    try {
      await ExpoAudioStreamModule.stopRecording();
    } catch (err) {
      console.warn('[audio] Stop error (may be already stopped):', err);
    }
    isCurrentlyRecording = false;
  }
}
