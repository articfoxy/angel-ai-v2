import { Audio } from 'expo-av';
import {
  readAsStringAsync,
  deleteAsync,
  EncodingType,
} from 'expo-file-system/legacy';

let recording: Audio.Recording | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;

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
 * via the onAudioData callback at ~250ms intervals.
 *
 * The recording is configured for linear16 PCM, 16kHz, mono —
 * matching the server's Deepgram configuration.
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

  const recordingOptions: Audio.RecordingOptions = {
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

  recording = new Audio.Recording();
  await recording.prepareToRecordAsync(recordingOptions);
  await recording.startAsync();

  // Poll: stop current recording, read its file, send data,
  // then start a new recording. This gives us real PCM chunks.
  pollingInterval = setInterval(async () => {
    if (!recording) return;

    try {
      const currentRecording = recording;

      // Stop the current short recording
      await currentRecording.stopAndUnloadAsync();
      const uri = currentRecording.getURI();

      // Immediately start a new recording so we don't miss audio
      recording = new Audio.Recording();
      await recording.prepareToRecordAsync(recordingOptions);
      await recording.startAsync();

      // Read the completed chunk, strip WAV header, and send raw PCM
      if (uri) {
        const base64 = await readAsStringAsync(uri, {
          encoding: EncodingType.Base64,
        });
        if (base64 && base64.length > 0) {
          // Each chunk is a complete WAV file with a 44-byte header.
          // Deepgram expects continuous raw PCM — strip the header.
          // 44 bytes = ceil(44 * 4/3) = 60 base64 chars (with padding)
          const WAV_HEADER_BASE64_LEN = 60;
          const rawPcm = base64.length > WAV_HEADER_BASE64_LEN
            ? base64.substring(WAV_HEADER_BASE64_LEN)
            : base64;
          onAudioData(rawPcm);
        }
        // Clean up the temp file
        await deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    } catch (err) {
      // If the recording was stopped externally (user pressed stop),
      // the interval will naturally fail — that's expected.
      console.warn('Audio chunk error (may be normal during stop):', err);
    }
  }, 250);
}

/**
 * Stop recording and clean up all resources.
 */
export async function stopRecording(): Promise<void> {
  // Clear the polling interval first to prevent race conditions
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

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
