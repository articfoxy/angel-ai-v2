/**
 * ─── Audio Streaming Service ───
 *
 * True streaming audio capture using @siteed/expo-audio-studio.
 * No polling, no file reads — the native layer calls us directly
 * with PCM audio chunks via the onAudioStream callback.
 *
 * Audio format: linear16 PCM, 16 kHz, mono — matching Deepgram.
 */
import { Audio } from 'expo-av';
import { decode as atob } from 'base-64';

// expo-audio-studio provides the native streaming recorder.
// ExpoAudioStreamModule is the low-level native module (works outside React components).
import {
  ExpoAudioStreamModule,
  type AudioDataEvent,
  type RecordingConfig,
} from '@siteed/expo-audio-studio';

/** Current gain factor. Controlled by the UI slider. */
let currentGain = 2.0;
let isCurrentlyRecording = false;

// ─── GAIN CONTROL ───

/**
 * Set the mic sensitivity gain factor.
 * 1.0 = original, 2.0 = 2× louder, etc.
 * Higher values pick up distant/quiet voices but also amplify noise.
 */
export function setGain(factor: number) {
  currentGain = Math.max(0.5, Math.min(6.0, factor));
}

export function getGain(): number {
  return currentGain;
}

/**
 * Amplify 16-bit PCM samples by the current gain factor.
 * Clamps to [-32768, 32767] to prevent clipping distortion.
 */
function amplifyPcm(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1.0) return pcm;

  const len = pcm.length & ~1; // ensure even (16-bit samples)
  const out = new Uint8Array(len);
  const inView = new DataView(pcm.buffer, pcm.byteOffset, len);
  const outView = new DataView(out.buffer, 0, len);

  for (let i = 0; i < len; i += 2) {
    let sample = inView.getInt16(i, true);
    sample = (sample * gain) | 0;
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    outView.setInt16(i, sample, true);
  }

  return out;
}

/** Decode a base64 string to a Uint8Array. */
function b64ToBytes(b64: string): Uint8Array {
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
 * Start streaming audio. The onAudioData callback fires every ~100ms
 * with a Uint8Array of amplified raw PCM (linear16, 16kHz, mono).
 *
 * This is TRUE STREAMING — no file polling. The native audio layer
 * pushes PCM chunks directly to JS via the bridge.
 */
export async function startRecording(
  onAudioData: (data: Uint8Array) => void
): Promise<void> {
  await stopRecording();

  // Configure iOS audio session for recording through AirPods / background
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
  });

  const config: RecordingConfig = {
    sampleRate: 16000,
    channels: 1,
    encoding: 'pcm_16bit',
    interval: 100, // Fire callback every 100ms
    keepAwake: true,
    onAudioStream: async (event: AudioDataEvent) => {
      try {
        if (!event.data) return;

        let pcmBytes: Uint8Array;

        if (typeof event.data === 'string') {
          // Native iOS/Android: base64-encoded PCM
          if (event.data.length === 0) return;
          pcmBytes = b64ToBytes(event.data);
        } else if (event.data instanceof Float32Array) {
          // Web or float32 mode: convert to 16-bit PCM
          const float32 = event.data;
          pcmBytes = new Uint8Array(float32.length * 2);
          const view = new DataView(pcmBytes.buffer);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
          }
        } else if (event.data instanceof Int16Array) {
          pcmBytes = new Uint8Array(event.data.buffer);
        } else {
          return;
        }

        if (pcmBytes.length === 0) return;

        // Apply gain amplification
        const amplified = amplifyPcm(pcmBytes, currentGain);
        onAudioData(amplified);
      } catch (err) {
        console.warn('[audio] Stream callback error:', err);
      }
    },
    // Don't save to file — we only need the stream
    output: {
      primary: { enabled: false },
    },
    ios: {
      audioSession: {
        category: 'PlayAndRecord',
        categoryOptions: [
          'DefaultToSpeaker',
          'AllowBluetooth',
          'AllowBluetoothA2DP',
        ],
        mode: 'Default',
      },
    },
  };

  console.log('[audio] Starting true streaming recording (100ms interval)');
  await ExpoAudioStreamModule.startRecording(config);
  isCurrentlyRecording = true;
}

/**
 * Stop recording and clean up.
 */
export async function stopRecording(): Promise<void> {
  if (isCurrentlyRecording) {
    try {
      await ExpoAudioStreamModule.stopRecording();
    } catch (err) {
      console.warn('[audio] Stop error (may be already stopped):', err);
    }
    isCurrentlyRecording = false;
  }

  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}
