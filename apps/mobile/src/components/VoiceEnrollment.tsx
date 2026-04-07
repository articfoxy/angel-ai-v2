import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import { decode as atob, encode as btoa } from 'base-64';
import type { EventSubscription } from 'expo-modules-core';
import { ExpoAudioStreamModule } from '@siteed/expo-audio-studio';
import {
  addAudioEventListener,
  type AudioEventPayload,
} from '@siteed/audio-studio/src/events';
import { api } from '../services/api';
import { colors, spacing, fontSize, radius } from '../theme';

const ENROLLMENT_DURATION_MS = 15_000;

interface VoiceEnrollmentProps {
  enrolled: boolean;
  enrolledDate?: string | null;
  onEnrollmentChange: () => void;
}

export function VoiceEnrollment({ enrolled, enrolledDate, onEnrollmentChange }: VoiceEnrollmentProps) {
  const [recording, setRecording] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const pcmChunksRef = useRef<Uint8Array[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const subscriptionRef = useRef<EventSubscription | null>(null);
  const startTimeRef = useRef(0);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (subscriptionRef.current) subscriptionRef.current.remove();
    };
  }, []);

  const startEnrollment = async () => {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Microphone access is needed for voice enrollment.');
      return;
    }

    pcmChunksRef.current = [];
    setRecording(true);
    setProgress(0);

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    // Collect PCM via native streaming
    subscriptionRef.current = addAudioEventListener(async (event: AudioEventPayload) => {
      if (event.encoded) {
        const raw = atob(event.encoded);
        const buf = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
        pcmChunksRef.current.push(buf);
      }
    });

    await ExpoAudioStreamModule.startRecording({
      sampleRate: 16000,
      channels: 1,
      encoding: 'pcm_16bit' as const,
      interval: 100,
      output: { primary: { enabled: false } },
      ios: {
        audioSession: {
          category: 'PlayAndRecord',
          categoryOptions: ['DefaultToSpeaker', 'AllowBluetooth', 'AllowBluetoothA2DP'],
          mode: 'Default',
        },
      },
    });

    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const p = Math.min(elapsed / ENROLLMENT_DURATION_MS, 1);
      setProgress(p);

      if (elapsed >= ENROLLMENT_DURATION_MS) {
        stopAndUpload();
      }
    }, 200);
  };

  const stopAndUpload = async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (subscriptionRef.current) {
      subscriptionRef.current.remove();
      subscriptionRef.current = null;
    }
    try {
      await ExpoAudioStreamModule.stopRecording();
    } catch {}
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false }).catch(() => {});

    setRecording(false);
    setProgress(1);
    setUploading(true);

    // Concatenate all PCM chunks
    const totalLength = pcmChunksRef.current.reduce((sum, c) => sum + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of pcmChunksRef.current) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    // Convert to base64 in chunks to avoid call stack overflow
    let b64 = '';
    const CHUNK_SIZE = 8192;
    for (let i = 0; i < combined.length; i += CHUNK_SIZE) {
      const slice = combined.subarray(i, Math.min(i + CHUNK_SIZE, combined.length));
      let binary = '';
      for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
      b64 += btoa(binary);
    }

    try {
      await api.post('voiceprint/enroll', { audio: b64 });
      Alert.alert('Voice Enrolled', 'Angel will now recognize your voice in conversations.');
      onEnrollmentChange();
    } catch (err: any) {
      Alert.alert('Enrollment Failed', err?.message || 'Could not process your voice sample. Please try again.');
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const deleteVoiceprint = () => {
    Alert.alert('Remove Voice Profile', 'Angel will no longer recognize your voice. You can re-enroll anytime.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete('voiceprint');
            onEnrollmentChange();
          } catch (err: any) {
            Alert.alert('Error', err?.message || 'Failed to remove voice profile');
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View style={[styles.iconBadge, enrolled && styles.iconBadgeActive]}>
          <Ionicons
            name={enrolled ? 'finger-print' : 'finger-print-outline'}
            size={20}
            color={enrolled ? colors.primary : colors.textTertiary}
          />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.label}>Voice Identity</Text>
          <Text style={styles.desc}>
            {enrolled
              ? 'Your voice is enrolled. Angel recognizes you.'
              : 'Record your voice so Angel can identify you in conversations.'}
          </Text>
        </View>
      </View>

      {/* Progress bar during recording */}
      {(recording || uploading) && (
        <View style={styles.progressContainer}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={styles.progressText}>
            {uploading
              ? 'Processing...'
              : `Recording... ${Math.ceil((ENROLLMENT_DURATION_MS - progress * ENROLLMENT_DURATION_MS) / 1000)}s`}
          </Text>
        </View>
      )}

      {/* Action buttons */}
      <View style={styles.actions}>
        {enrolled ? (
          <>
            <TouchableOpacity style={styles.reEnrollButton} onPress={startEnrollment} disabled={recording || uploading}>
              <Ionicons name="refresh-outline" size={16} color={colors.primary} />
              <Text style={styles.reEnrollText}>Re-enroll</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.removeButton} onPress={deleteVoiceprint} disabled={recording || uploading}>
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
              <Text style={styles.removeText}>Remove</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.enrollButton, (recording || uploading) && styles.enrollButtonDisabled]}
            onPress={startEnrollment}
            disabled={recording || uploading}
          >
            {uploading ? (
              <ActivityIndicator color={colors.bg} size="small" />
            ) : recording ? (
              <>
                <View style={styles.recordingDot} />
                <Text style={styles.enrollButtonText}>Listening...</Text>
              </>
            ) : (
              <>
                <Ionicons name="mic-outline" size={18} color={colors.bg} />
                <Text style={styles.enrollButtonText}>Record Voice Sample</Text>
              </>
            )}
          </TouchableOpacity>
        )}
      </View>

      {!enrolled && !recording && !uploading && (
        <Text style={styles.hint}>Speak naturally for 15 seconds in a quiet environment.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceHover,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeActive: {
    backgroundColor: colors.primary + '20',
  },
  headerText: {
    flex: 1,
  },
  label: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
    marginBottom: 2,
  },
  desc: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  progressContainer: {
    marginBottom: spacing.md,
  },
  progressTrack: {
    height: 4,
    backgroundColor: colors.border,
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: spacing.xs,
  },
  progressFill: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 2,
  },
  progressText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  enrollButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
  },
  enrollButtonDisabled: {
    backgroundColor: colors.primary + '80',
  },
  enrollButtonText: {
    color: colors.bg,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  reEnrollButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.primary + '15',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
  },
  reEnrollText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  removeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.danger + '15',
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  removeText: {
    color: colors.danger,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  hint: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
});
