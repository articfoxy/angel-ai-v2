import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
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
import { WhisperCard } from '../components/WhisperCard';
import { SessionCard } from '../components/SessionCard';
import { useAuth } from '../hooks/useAuth';
import { useApi } from '../hooks/useApi';
import { connectSocket, disconnectSocket, getSocket, onSocketStateChange } from '../services/socket';
import { requestMicPermission, startRecording, stopRecording } from '../services/audio';
import { api } from '../services/api';
import { colors, spacing, fontSize } from '../theme';
import type { Session, SessionsListResponse, TranscriptSegment, WhisperCardData } from '../types';

/** Session-specific socket events that we register listeners for */
const SESSION_EVENTS = [
  'transcript',
  'whisper',
  'speaker:identified',
  'session:debrief',
  'session:timeout',
  'session:error',
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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep refs so socket callbacks can read the latest values
  const isActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);

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
        const existing = prev.findIndex((s) => s.id === data.id);
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = data;
          return updated;
        }
        return [...prev, data];
      });
    });

    sock.on('whisper', (data: WhisperCardData) => {
      setWhisperCards((prev) => [data, ...prev]);
    });

    sock.on('speaker:identified', (data: { speakerId: string; label: string }) => {
      setSpeakerNames((prev) => ({ ...prev, [data.speakerId]: data.label }));
    });

    sock.on('session:debrief', (data: { sessionId: string }) => {
      // Session ended server-side, navigate to debrief
      stopRecording().catch(() => {});
      if (timerRef.current) clearInterval(timerRef.current);
      setIsActive(false);
      setSessionId(null);
      setSegments([]);
      setWhisperCards([]);
      setSpeakerNames({});
      setElapsed(0);
      cleanupSessionListeners();
      disconnectSocket();
      refetchSessions();
      navigation.navigate('Debrief', { sessionId: data.sessionId });
    });

    sock.on('session:timeout', (data: { reason: string; message: string }) => {
      // Server timed out the session
      stopRecording().catch(() => {});
      if (timerRef.current) clearInterval(timerRef.current);
      setIsActive(false);
      setSessionId(null);
      setSegments([]);
      setWhisperCards([]);
      setSpeakerNames({});
      setElapsed(0);
      cleanupSessionListeners();
      disconnectSocket();
      refetchSessions();
      Alert.alert('Session Ended', data.message || 'Session timed out');
    });

    sock.on('session:error', (data: { message: string }) => {
      // Server-side error (e.g., Deepgram connection failed)
      stopRecording().catch(() => {});
      if (timerRef.current) clearInterval(timerRef.current);
      setIsActive(false);
      setSessionId(null);
      setSegments([]);
      setWhisperCards([]);
      setSpeakerNames({});
      setElapsed(0);
      cleanupSessionListeners();
      disconnectSocket();
      refetchSessions();
      Alert.alert('Session Error', data.message || 'An error occurred during your session');
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
        // and re-emit session:start so the server resumes the session
        const sock = getSocket();
        if (sock && sessionIdRef.current) {
          registerSessionListeners(sock);
          sock.emit('session:start', { sessionId: sessionIdRef.current });
        }
      }
    });

    return unsubscribe;
  }, [registerSessionListeners]);

  // Clean up recording AND socket on unmount (e.g. if user navigates away while active)
  useEffect(() => {
    return () => {
      stopRecording().catch(() => {});
      cleanupSessionListeners();
      disconnectSocket();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [cleanupSessionListeners]);

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
            // Stop recording first so no more audio is sent
            await stopRecording();

            // Stop session
            const socket = getSocket();
            if (socket && sessionId) {
              socket.emit('session:stop', { sessionId });
            }
            cleanupSessionListeners();
            disconnectSocket();
            if (timerRef.current) clearInterval(timerRef.current);
            setIsActive(false);
            setIsReconnecting(false);
            setSessionId(null);
            setSegments([]);
            setWhisperCards([]);
            setSpeakerNames({});
            setElapsed(0);
            refetchSessions();
          },
        },
      ]);
    } else {
      // Start session
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
        socket.emit('session:start', startPayload);

        // Register all session-specific listeners (removes stale ones first)
        registerSessionListeners(socket);

        // Start audio recording and stream chunks to the server
        await startRecording((audioBase64: string) => {
          const currentSocket = getSocket();
          if (currentSocket?.connected) {
            currentSocket.emit('audio', audioBase64);
          }
        });
      } catch (err: any) {
        console.error('Failed to start session:', err);
        await stopRecording();
        cleanupSessionListeners();
        disconnectSocket();
        if (timerRef.current) clearInterval(timerRef.current);
        setIsActive(false);
        setIsReconnecting(false);
        setSessionId(null);
        setElapsed(0);
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
          <ActivityIndicator size="small" color="#000" />
          <Text style={styles.reconnectText}>Reconnecting...</Text>
        </View>
      )}

      {isActive ? (
        /* Active Session View */
        <View style={styles.activeContainer}>
          {/* Whisper Cards */}
          {whisperCards.length > 0 && (
            <View style={styles.whisperSection}>
              {whisperCards.slice(0, 3).map((card) => (
                <WhisperCard key={card.id} card={card} />
              ))}
            </View>
          )}

          {/* Live Transcript */}
          <TranscriptView segments={segments} speakerNames={speakerNames} />

          {/* Small stop button at bottom */}
          <View style={styles.activeButtonRow}>
            <AngelButton onPress={handleToggle} isActive={true} />
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
                <Text style={styles.emptySubtext}>Tap "Come Alive" to start your first session</Text>
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
    paddingVertical: spacing.md,
  },
  appTitle: {
    color: colors.text,
    fontSize: fontSize.xxl,
    fontWeight: '700',
  },
  activeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  activeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#22c55e',
  },
  activeText: {
    color: '#22c55e',
    fontSize: fontSize.sm,
    fontWeight: '700',
    letterSpacing: 1,
  },
  timer: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  reconnectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: '#facc15',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
  },
  reconnectText: {
    color: '#000',
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  activeContainer: { flex: 1 },
  whisperSection: { marginBottom: spacing.sm },
  activeButtonRow: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  idleContent: { paddingBottom: spacing.xl },
  angelSection: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl * 2,
  },
  historySection: { marginTop: spacing.md },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl,
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
  },
});
