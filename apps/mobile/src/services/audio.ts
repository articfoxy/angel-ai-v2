/**
 * ─── Audio Streaming Service ───
 *
 * True streaming audio via @siteed/expo-audio-studio.
 *
 * Under the hood: iOS AVAudioEngine.inputNode.installTap() captures raw
 * PCM frames from the hardware (~every 64ms at 16kHz). The native module
 * accumulates frames and emits an "AudioData" event to JS every `interval`ms
 * (we use 100ms). This is NOT polling — the native layer pushes to us.
 *
 * Audio format: linear16 PCM, 16 kHz, mono — matching Deepgram.
 */
import { Audio } from 'expo-av';
import { decode as atob } from 'base-64';
import type { EventSubscription } from 'expo-modules-core';

// Low-level native module (works outside React components)
import { ExpoAudioStreamModule } from '@siteed/expo-audio-studio';
// Event listener — not re-exported from main index, import from events module directly
import {
  addAudioEventListener,
  type AudioEventPayload,
} from '@siteed/audio-studio/src/events';

let currentGain = 2.0;
let isCurrentlyRecording = false;
let audioSubscription: EventSubscription | null = null;

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

// ─── PUBLIC API ───

export async function requestMicPermission(): Promise<boolean> {
  const { status } = await Audio.requestPermissionsAsync();
  return status === 'granted';
}

/**
 * Start streaming audio. Calls onAudioData every ~100ms with
 * amplified raw PCM (Uint8Array, linear16, 16kHz, mono).
 *
 * Architecture:
 *   iOS hardware → AVAudioEngine tap (continuous) →
 *   native accumulates PCM → emits "AudioData" event every 100ms →
 *   JS listener → amplify → onAudioData callback → socket.emit
 */
export async function startRecording(
  onAudioData: (data: Uint8Array) => void
): Promise<void> {
  await stopRecording();

  // Configure iOS audio session for recording (AirPods, background, silent mode)
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: true,
  });

  // 1. Subscribe to native "AudioData" events BEFORE starting recording.
  //    This ensures we don't miss the first chunk.
  audioSubscription = addAudioEventListener(async (event: AudioEventPayload) => {
    try {
      // Native iOS sends base64-encoded PCM in `encoded` field
      const b64Data = event.encoded;
      if (!b64Data || b64Data.length === 0) return;

      const pcmBytes = b64ToBytes(b64Data);
      if (pcmBytes.length === 0) return;

      const amplified = amplifyPcm(pcmBytes, currentGain);
      onAudioData(amplified);
    } catch (err) {
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
        categoryOptions: [
          'DefaultToSpeaker',
          'AllowBluetooth',
          'AllowBluetoothA2DP',
        ],
        mode: 'VoiceChat', // Low-latency audio + hardware AEC for TTS
      },
    },
  };

  console.log('[audio] Starting true streaming (50ms native emission interval)');
  await ExpoAudioStreamModule.startRecording(nativeConfig);
  isCurrentlyRecording = true;
}

/**
 * Stop recording and clean up event listeners.
 */
export async function stopRecording(): Promise<void> {
  // Remove event listener first to stop processing
  if (audioSubscription) {
    audioSubscription.remove();
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

  await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});
}
