import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { AngelButton } from '../components/AngelButton';
import { TranscriptView } from '../components/TranscriptView';
import { SessionCard } from '../components/SessionCard';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { connectSocket, disconnectSocket, getSocket, onSocketStateChange } from '../services/socket';
import { requestMicPermission, startRecording, stopRecording, setGain, getGain } from '../services/audio';
import { api } from '../services/api';
import { getTTSPlayer, disposeTTSPlayer } from '../services/ttsPlayer';
import { colors, spacing, fontSize, radius } from '../theme';
import type { Session, SessionsListResponse, TranscriptSegment, WhisperCardData } from '../types';

/** Session-specific socket events that we register listeners for */
const SESSION_EVENTS = [
  'transcript',
  'whisper',
  'speaker:identified',
  'session:debrief',
  'session:timeout',
  'session:error',
  'deepgram:status',
  'angel:thinking',
  'tts:start',
  'tts:chunk',
  'tts:done',
  'tts:cancel',
] as const;

export function StartScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const [isActive, setIsActive] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [whisperCards, setWhisperCards] = useState<WhisperCardData[]>([]);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [gain, setGainState] = useState(getGain());
  const [showGain, setShowGain] = useState(false);
  const [angelThinking, setAngelThinking] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isStartingRef = useRef(false); // Double-tap guard for session creation

  // Keep refs so socket callbacks can read the latest values
  const isActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  /** Cache the full session:start payload so reconnect can re-send it intact */
  const startPayloadRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Pulsing active dot
  const dotOpacity = useSharedValue(1);
  useEffect(() => {
    if (isActive) {
      dotOpacity.value = withRepeat(
        withSequence(
          withTiming(0.3, { duration: 800, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) })
        ),
        -1
      );
    } else {
      dotOpacity.value = withTiming(1, { duration: 200 });
    }
  }, [isActive]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: dotOpacity.value }));

  const {
    data: sessionsResponse,
    isLoading: sessionsLoading,
    refetch: refetchSessions,
  } = useApi<SessionsListResponse>('sessions?limit=20');

  const sessions = sessionsResponse?.sessions;
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchSessions();
    setRefreshing(false);
  }, [refetchSessions]);

  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  /**
   * Remove all session-specific socket listeners.
   * Safe to call even if socket is null or listeners were never registered.
   */
  const cleanupSessionListeners = useCallback(() => {
    const sock = getSocket();
    if (!sock) return;
    for (const event of SESSION_EVENTS) {
      sock.off(event);
    }
  }, []);

  /**
   * Register session-specific socket listeners.
   * Removes any existing listeners first to prevent duplicates on reconnect.
   */
  const registerSessionListeners = useCallback((sock: ReturnType<typeof getSocket>) => {
    if (!sock) return;

    // Remove stale listeners before adding fresh ones
    for (const event of SESSION_EVENTS) {
      sock.off(event);
    }

    sock.on('transcript', (data: TranscriptSegment) => {
      setSegments((prev) => {
        let next = prev;

        // When a final segment arrives, remove the stale interim for that speaker
        // to prevent unbounded memory growth over long sessions.
        if (data.isFinal && data.speaker) {
          const interimId = `interim-${data.speaker.replace('speaker_', '')}`;
          next = prev.filter((s) => s.id !== interimId);
        }

        const existing = next.findIndex((s) => s.id === data.id);
        if (existing >= 0) {
          const updated = [...next];
          updated[existing] = data;
          return updated;
        }
        const added = [...next, data];
        // Cap at 200 segments to prevent unbounded memory growth in long sessions.
        // Keep the most recent segments (user sees the latest transcript).
        if (added.length > 200) {
          return added.slice(-150);
        }
        return added;
      });
    });

    sock.on('whisper', (data: WhisperCardData) => {
      setWhisperCards((prev) => [data, ...prev].slice(0, 50));
    });

    sock.on('speaker:identified', (data: { speakerId: string; label: string }) => {
      setSpeakerNames((prev) => ({ ...prev, [data.speakerId]: data.label }));
    });

    sock.on('session:debrief', () => {
      // Server finished processing — just refresh history list (no popup)
      refetchSessions();
    });

    sock.on('session:timeout', (data: { reason: string; message: string }) => {
      // Server timed out the session
      stopRecording().catch(() => {});
      if (timerRef.current) clearInterval(timerRef.current);
      setIsActive(false);
      setAngelThinking(false);
      setSessionId(null);
      setSegments([]);
      setWhisperCards([]);
      setSpeakerNames({});
      setElapsed(0);
      startPayloadRef.current = null;
      disposeTTSPlayer();
      cleanupSessionListeners();
      disconnectSocket();
      refetchSessions();
      Alert.alert('Session Ended', data.message || 'Session timed out');
    });

    sock.on('angel:thinking', (data: { active: boolean }) => {
      setAngelThinking(data.active);
    });

    sock.on('deepgram:status', (data: { status: string }) => {
      if (data.status === 'reconnecting') {
        setIsReconnecting(true);
      } else if (data.status === 'connected') {
        setIsReconnecting(false);
      }
      // 'disconnected' status will be followed by session:error
    });

    sock.on('session:error', (data: { message: string }) => {
      // Server-side error (e.g., Deepgram connection failed)
      stopRecording().catch(() => {});
      if (timerRef.current) clearInterval(timerRef.current);
      setIsActive(false);
      setAngelThinking(false);
      setSessionId(null);
      setSegments([]);
      setWhisperCards([]);
      setSpeakerNames({});
      setElapsed(0);
      startPayloadRef.current = null;
      disposeTTSPlayer();
      cleanupSessionListeners();
      disconnectSocket();
      refetchSessions();
      Alert.alert('Session Error', data.message || 'An error occurred during your session');
    });

    // ── TTS audio playback handlers ──
    sock.on('tts:start', (data: { whisperId: string }) => {
      const player = getTTSPlayer();
      player.startWhisper(data.whisperId);
    });

    sock.on('tts:chunk', (data: { whisperId: string; audio: string; chunkIndex: number }) => {
      const player = getTTSPlayer();
      player.feedChunk(data.whisperId, data.audio);
    });

    sock.on('tts:done', (data: { whisperId: string }) => {
      const player = getTTSPlayer();
      player.finishWhisper(data.whisperId);
    });

    sock.on('tts:cancel', () => {
      const player = getTTSPlayer();
      player.stop();
    });
  }, [cleanupSessionListeners, navigation, refetchSessions]);

  // Subscribe to socket connection state changes
  useEffect(() => {
    const unsubscribe = onSocketStateChange((connected) => {
      if (!isActiveRef.current) return; // Only care during active sessions

      if (!connected) {
        setIsReconnecting(true);
      } else {
        setIsReconnecting(false);
        // Socket reconnected during an active session — re-register listeners
        // and re-emit session:start with the FULL original payload so the server
        // gets instructions, BYOK, and speech settings again.
        const sock = getSocket();
        if (sock && sessionIdRef.current) {
          registerSessionListeners(sock);
          const payload = startPayloadRef.current || { sessionId: sessionIdRef.current };
          sock.emit('session:start', payload);
        }
      }
    });

    return unsubscribe;
  }, [registerSessionListeners]);

  // Clean up recording AND socket on unmount (e.g. if user navigates away while active)
  useEffect(() => {
    return () => {
      stopRecording().catch(() => {});
      disposeTTSPlayer();
      cleanupSessionListeners();
      disconnectSocket();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cleanupSessionListeners]);

  const handleAngelActivate = useCallback(() => {
    const sock = getSocket();
    if (!sock?.connected || !isActive) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    sock.emit('angel:activate');
  }, [isActive]);

  const handleToggle = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    if (isActive) {
      // Show confirmation before stopping
      Alert.alert('End Session?', 'This will stop recording and process your conversation.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'End Session',
          style: 'destructive',
          onPress: async () => {
            await stopRecording();
            if (timerRef.current) clearInterval(timerRef.current);

            // Tell server to stop, then clean up immediately (no debrief wait)
            const socket = getSocket();
            if (socket && sessionId) {
              socket.emit('session:stop', { sessionId });
            }

            setIsActive(false);
            setIsReconnecting(false);
            setAngelThinking(false);
            setSessionId(null);
            setSegments([]);
            setWhisperCards([]);
            setSpeakerNames({});
            setElapsed(0);
            startPayloadRef.current = null;
            disposeTTSPlayer();
            cleanupSessionListeners();
            disconnectSocket();
            refetchSessions();
          },
        },
      ]);
    } else {
      // Start session — guard against double-tap
      if (isStartingRef.current) return;
      isStartingRef.current = true;
      try {
        // Request microphone permission before anything else
        const hasPermission = await requestMicPermission();
        if (!hasPermission) {
          Alert.alert(
            'Microphone Required',
            'Angel AI needs microphone access to listen to your conversations. Please enable it in Settings.',
            [{ text: 'OK' }]
          );
          return;
        }

        const session = await api.post<Session>('sessions', {});
        setSessionId(session.id);
        setIsActive(true);
        setIsReconnecting(false);
        setElapsed(0);

        timerRef.current = setInterval(() => {
          setElapsed((prev) => prev + 1);
        }, 1000);

        const socket = await connectSocket();

        // Check for BYOK keys and include them in session:start
        const byokProvider = await SecureStore.getItemAsync('angel_v2_byok_provider');
        const byokKey = byokProvider
          ? await SecureStore.getItemAsync(
              byokProvider === 'anthropic' ? 'angel_v2_anthropic_key'
              : byokProvider === 'google' ? 'angel_v2_google_key'
              : 'angel_v2_openai_key'
            )
          : null;

        const startPayload: Record<string, unknown> = { sessionId: session.id };
        if (byokKey) {
          startPayload.byok = { provider: byokProvider, apiKey: byokKey };
        }

        // Load speech recognition settings (keywords for boosting)
        const keywordsRaw = await SecureStore.getItemAsync('angel_v2_speech_keywords');
        const keywords = keywordsRaw
          ? keywordsRaw.split('\n').map(k => k.trim()).filter(Boolean)
          : undefined;
        if (keywords && keywords.length > 0) {
          startPayload.speech = { keywords };
        }

        // Load Angel Instructions (presets + custom) — wrapped in try/catch
        // so corrupted data can't prevent session start
        try {
          const presetsRaw = await SecureStore.getItemAsync('angel_v2_instruction_presets');
          const customInstructions = await SecureStore.getItemAsync('angel_v2_custom_instructions');
          const PRESET_MAP: Record<string, string> = {
            jargon: 'Explain any jargon, acronyms, or technical terms used in the conversation.',
            translate_zh: 'When someone speaks Chinese (Mandarin/Cantonese), translate it to English for me.',
            translate_es: 'When someone speaks Spanish, translate it to English for me.',
            meeting: 'Track action items, decisions, and key takeaways from the conversation.',
            coach: 'Give me tips on my communication — tone, clarity, persuasiveness.',
            fact_check: 'Flag any inaccuracies, contradictions, or questionable claims.',
            sales: 'Help me navigate the sales conversation — objection handling, closing techniques, value framing.',
            learn: 'Help me learn from the conversation — summarize key points, explain concepts, suggest follow-ups.',
          };
          const parsed = presetsRaw ? JSON.parse(presetsRaw) : [];
          const presetIds: string[] = Array.isArray(parsed) ? parsed : [];
          const presetTexts = presetIds.map(id => PRESET_MAP[id]).filter(Boolean);
          const allInstructions = [...presetTexts, customInstructions?.trim()].filter(Boolean).join('\n');
          if (allInstructions) {
            startPayload.instructions = allInstructions;
          }
          // Load owner language preference
          const ownerLang = await SecureStore.getItemAsync('angel_v2_owner_language');
          if (ownerLang) {
            startPayload.ownerLanguage = ownerLang;
          }
        } catch (instrErr) {
          console.warn('[session] Failed to load Angel instructions:', instrErr);
          // Non-fatal — session starts with default instructions
        }

        // Cache the full payload for reconnect and register listeners BEFORE
        // emitting so we don't miss any fast server responses.
        startPayloadRef.current = startPayload;
        registerSessionListeners(socket);

        // Initialize TTS player for voice whisper playback via AirPods
        const ttsPlayer = getTTSPlayer({
          onPlaybackStart: (whisperId) => {
            const currentSocket = getSocket();
            currentSocket?.emit('tts:ack', { whisperId });
          },
          onPlaybackDone: (whisperId) => {
            const currentSocket = getSocket();
            currentSocket?.emit('tts:finished', { whisperId });
          },
        });
        await ttsPlayer.init();

        socket.emit('session:start', startPayload);

        // Start audio recording and stream raw PCM chunks to the server.
        // Audio is sent as binary (ArrayBuffer) for 33% less bandwidth vs base64.
        // IMPORTANT: We must slice the buffer to get an exact-size copy.
        // Uint8Array.buffer can be larger than byteLength if the view is a subarray.
        await startRecording((pcmBytes: Uint8Array) => {
          const currentSocket = getSocket();
          if (currentSocket?.connected) {
            const exactBuffer = pcmBytes.buffer.slice(
              pcmBytes.byteOffset,
              pcmBytes.byteOffset + pcmBytes.byteLength
            );
            currentSocket.emit('audio', exactBuffer);
          }
        });
        isStartingRef.current = false;
      } catch (err: any) {
        console.error('Failed to start session:', err);
        await stopRecording();
        disposeTTSPlayer();
        cleanupSessionListeners();
        disconnectSocket();
        if (timerRef.current) clearInterval(timerRef.current);
        setIsActive(false);
        setIsReconnecting(false);
        setSessionId(null);
        setElapsed(0);
        startPayloadRef.current = null;
        isStartingRef.current = false;
        Alert.alert(
          'Connection Failed',
          err?.message || 'Could not start session. Please check your connection and try again.'
        );
      }
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.appTitle}>Angel AI</Text>
          {isActive && (
            <View style={styles.activeRow}>
              <Animated.View style={[styles.activeDot, dotStyle]} />
              <Text style={styles.activeText}>ACTIVE</Text>
              <Text style={styles.timer}>{formatTimer(elapsed)}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Reconnecting banner */}
      {isReconnecting && isActive && (
        <View style={styles.reconnectBanner}>
          <ActivityIndicator size="small" color={colors.warning} />
          <Text style={styles.reconnectText}>Reconnecting...</Text>
        </View>
      )}

      {isActive ? (
        /* Active Session View */
        <View style={styles.activeContainer}>
          {/* Live Transcript with inline whisper cards */}
          <TranscriptView
            segments={segments}
            speakerNames={speakerNames}
            whisperCards={whisperCards}
          />

          {/* Bottom control bar */}
          <View style={styles.activeButtonRow}>
            {/* Gain slider toggle */}
            {showGain && (
              <View style={styles.gainRow}>
                <Ionicons name="mic-outline" size={16} color={colors.textSecondary} />
                <Slider
                  style={styles.gainSlider}
                  minimumValue={0.5}
                  maximumValue={5.0}
                  step={0.5}
                  value={gain}
                  onValueChange={(v) => {
                    setGainState(v);
                    setGain(v);
                  }}
                  minimumTrackTintColor={colors.primary}
                  maximumTrackTintColor={colors.border}
                  thumbTintColor={colors.primary}
                />
                <Text style={styles.gainLabel}>{gain.toFixed(1)}×</Text>
              </View>
            )}
            <View style={styles.bottomControls}>
              <TouchableOpacity
                onPress={() => setShowGain(!showGain)}
                style={[
                  styles.gainToggle,
                  showGain && { backgroundColor: colors.primaryMuted },
                ]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name="volume-high-outline"
                  size={18}
                  color={showGain ? colors.primary : colors.textSecondary}
                />
                <Text style={[
                  styles.gainToggleText,
                  showGain && { color: colors.primary },
                ]}>
                  {gain.toFixed(1)}×
                </Text>
              </TouchableOpacity>
              <AngelButton onPress={handleToggle} isActive={true} />
              <TouchableOpacity
                onPress={handleAngelActivate}
                disabled={angelThinking}
                style={[
                  styles.askAngelBtn,
                  angelThinking && { opacity: 0.5 },
                ]}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {angelThinking ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Ionicons name="sparkles" size={18} color={colors.primary} />
                )}
                <Text style={styles.askAngelText}>Ask</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      ) : (
        /* Idle View */
        <ScrollView
          contentContainerStyle={styles.idleContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
        >
          {/* Angel Button */}
          <View style={styles.angelSection}>
            <AngelButton onPress={handleToggle} isActive={false} />
          </View>

          {/* Conversation History */}
          <View style={styles.historySection}>
            <Text style={styles.sectionTitle}>Conversation History</Text>
            {sessionsLoading && !sessions ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
            ) : Array.isArray(sessions) && sessions.length > 0 ? (
              sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onPress={() => navigation.navigate('Debrief', { sessionId: session.id })}
                  onDelete={async () => {
                    try {
                      await api.delete(`sessions/${session.id}`);
                      refetchSessions();
                    } catch (err) {
                      console.error('Failed to delete session:', err);
                      Alert.alert('Error', 'Failed to delete session. Please try again.');
                    }
                  }}
                />
              ))
            ) : (
              <View style={styles.emptyState}>
                <Ionicons name="mic-outline" size={32} color={colors.textTertiary} />
                <Text style={styles.emptyText}>No conversations yet</Text>
                <Text style={styles.emptySubtext}>Tap Start Session to begin</Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  appTitle: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs + 2,
  },
  activeDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: colors.success,
  },
  activeText: {
    color: colors.success,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  timer: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warningMuted,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'rgba(251, 191, 36, 0.2)',
  },
  reconnectText: {
    color: colors.warning,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  activeContainer: { flex: 1 },
  askAngelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: colors.primaryMuted,
    width: 56,
    justifyContent: 'center',
  },
  askAngelText: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '700',
  },
  activeButtonRow: {
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  bottomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
  },
  gainToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    width: 56,
  },
  gainToggleText: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    fontVariant: ['tabular-nums'] as any,
  },
  gainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  gainSlider: {
    flex: 1,
    height: 32,
  },
  gainLabel: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    fontVariant: ['tabular-nums'] as any,
    width: 32,
    textAlign: 'right',
  },
  idleContent: { paddingBottom: spacing.xxl },
  angelSection: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl * 1.5,
  },
  historySection: { marginTop: spacing.sm },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: 'center',
  },
});
