import { Audio } from 'expo-av';
import {
  readAsStringAsync,
  deleteAsync,
  EncodingType,
} from 'expo-file-system/legacy';

let recording: Audio.Recording | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let processing = false;

/** WAV header is 44 bytes = ceil(44 * 4/3) = 60 base64 chars */
const WAV_HEADER_BASE64_LEN = 60;

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

      // Read the completed chunk, strip WAV header, and send raw PCM
      if (uri) {
        try {
          const base64 = await readAsStringAsync(uri, {
            encoding: EncodingType.Base64,
          });
          if (base64 && base64.length > WAV_HEADER_BASE64_LEN) {
            const rawPcm = base64.substring(WAV_HEADER_BASE64_LEN);
            onAudioData(rawPcm);
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
