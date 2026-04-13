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
  TextInput,
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
import { requestMicPermission, startRecording, stopRecording, setGain, getGain, setMicSource, setOutputDevice } from '../services/audio';
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
  'realtime:status',
] as const;

type AngelMode = 'translation' | 'intelligence' | 'hybrid';

const ANGEL_MODES: { id: AngelMode; label: string; icon: string; desc: string }[] = [
  { id: 'translation', label: 'Translation', icon: 'language-outline', desc: 'Smart live translation' },
  { id: 'intelligence', label: 'Intelligence', icon: 'bulb-outline', desc: 'Insights & coaching' },
  { id: 'hybrid', label: 'Hybrid', icon: 'git-merge-outline', desc: 'Translate + insights' },
];

const TRANSLATE_LANGUAGES = [
  { id: 'Chinese', flag: '🇨🇳' },
  { id: 'Spanish', flag: '🇪🇸' },
  { id: 'Japanese', flag: '🇯🇵' },
  { id: 'Korean', flag: '🇰🇷' },
  { id: 'French', flag: '🇫🇷' },
  { id: 'German', flag: '🇩🇪' },
  { id: 'Malay', flag: '🇲🇾' },
  { id: 'Hindi', flag: '🇮🇳' },
];

const INTELLIGENCE_PRESETS = [
  { id: 'jargon', label: 'Explain jargon', icon: '📖' },
  { id: 'meeting', label: 'Track action items', icon: '📋' },
  { id: 'coach', label: 'Coach me', icon: '🎯' },
  { id: 'fact_check', label: 'Fact-check', icon: '⚠️' },
  { id: 'sales', label: 'Sales help', icon: '💰' },
  { id: 'learn', label: 'Help me learn', icon: '🧠' },
];

export function StartScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const [isActive, setIsActive] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [whisperCards, setWhisperCards] = useState<WhisperCardData[]>([]);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const [elapsed, setElapsed] = useState(0);
  const [gain, setGainState] = useState(getGain());
  const [showGain, setShowGain] = useState(false);
  const [angelThinking, setAngelThinking] = useState(false);
  const [angelMode, setAngelMode] = useState<AngelMode>('intelligence');
  const [translateLangs, setTranslateLangs] = useState<string[]>(['Chinese']);
  const [intelligencePresets, setIntelligencePresets] = useState<string[]>(['jargon']);
  const [customInstructions, setCustomInstructions] = useState('');
  const [liveDirective, setLiveDirective] = useState('');
  const [instructionsFocused, setInstructionsFocused] = useState(false);
  const [directiveFocused, setDirectiveFocused] = useState(false);
  const [ttsSpeed, setTtsSpeed] = useState<'normal' | 'fast' | 'fastest' | 'ultra'>('normal');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isStartingRef = useRef(false); // Double-tap guard for session creation
  const testModeRef = useRef(false);
  const testTypeRef = useRef<string>('fusion');

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
      if (testRetryRef.current) { clearTimeout(testRetryRef.current); testRetryRef.current = null; }
      setIsActive(false);
      setAngelThinking(false);
      setAiStatus(null);
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
      if (testRetryRef.current) { clearTimeout(testRetryRef.current); testRetryRef.current = null; }
      setIsActive(false);
      setAngelThinking(false);
      setAiStatus(null);
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

    sock.on('realtime:status', (data: { status: string }) => {
      setAiStatus(data.status);
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
      if (testRetryRef.current) { clearTimeout(testRetryRef.current); testRetryRef.current = null; }
    };
  }, [cleanupSessionListeners]);

  // Load mode settings from SecureStore
  useEffect(() => {
    (async () => {
      try {
        const savedMode = await SecureStore.getItemAsync('angel_v2_mode');
        if (savedMode === 'translation' || savedMode === 'intelligence' || savedMode === 'hybrid') setAngelMode(savedMode);
        const savedLangs = await SecureStore.getItemAsync('angel_v2_translate_languages');
        if (savedLangs) { const p = JSON.parse(savedLangs); if (Array.isArray(p)) setTranslateLangs(p); }
        const savedPresets = await SecureStore.getItemAsync('angel_v2_intelligence_presets');
        if (savedPresets) { const p = JSON.parse(savedPresets); if (Array.isArray(p)) setIntelligencePresets(p); }
        const savedCustom = await SecureStore.getItemAsync('angel_v2_custom_instructions');
        if (savedCustom) setCustomInstructions(savedCustom);
      } catch {}
    })();
  }, []);

  const selectMode = useCallback((mode: AngelMode) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setAngelMode(mode);
    SecureStore.setItemAsync('angel_v2_mode', mode);
  }, []);

  const toggleTranslateLang = useCallback((lang: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTranslateLangs((prev) => {
      const updated = prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang];
      SecureStore.setItemAsync('angel_v2_translate_languages', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const toggleIntelligencePreset = useCallback((presetId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIntelligencePresets((prev) => {
      const updated = prev.includes(presetId) ? prev.filter((p) => p !== presetId) : [...prev, presetId];
      SecureStore.setItemAsync('angel_v2_intelligence_presets', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const saveCustomInstructions = useCallback(async (text: string) => {
    setCustomInstructions(text);
    await SecureStore.setItemAsync('angel_v2_custom_instructions', text);
  }, []);

  const sendLiveDirective = useCallback(() => {
    const text = liveDirective.trim();
    if (!text) return;
    const sock = getSocket();
    if (sock?.connected) {
      sock.emit('session:instruct', { text });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLiveDirective('');
    }
  }, [liveDirective]);

  const changeTtsSpeed = useCallback((speed: 'normal' | 'fast' | 'fastest' | 'ultra') => {
    setTtsSpeed(speed);
    // Client-side speed control (reliable — adjusts AudioBuffer sample rate)
    const multiplier = speed === 'normal' ? 1.0 : speed === 'fast' ? 1.5 : speed === 'fastest' ? 2.0 : 3.0;
    const player = getTTSPlayer();
    player.setSpeed(multiplier);
    // Also tell server (for Cartesia-native speed if supported)
    const sock = getSocket();
    if (sock?.connected) sock.emit('tts:speed', { speed });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  const handleTest = () => {
    Alert.alert('Test Conversation', 'Choose a scenario:', [
      {
        text: '🔬 Nuclear Fusion (Jargon)',
        onPress: () => { testTypeRef.current = 'fusion'; testModeRef.current = true; handleToggle(); },
      },
      {
        text: '🇨🇳 Chinese Business Meeting',
        onPress: () => { testTypeRef.current = 'chinese'; testModeRef.current = true; handleToggle(); },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleAngelActivate = useCallback(() => {
    const sock = getSocket();
    if (!sock?.connected || !isActive) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Interrupt any playing TTS so new response can come through
    const player = getTTSPlayer();
    if (player.playing) {
      sock.emit('tts:skip');
      player.stop();
    }
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
            setAiStatus(null);
            setSessionId(null);
            setSegments([]);
            setWhisperCards([]);
            setSpeakerNames({});
            setElapsed(0);
            startPayloadRef.current = null;
            if (testRetryRef.current) { clearTimeout(testRetryRef.current); testRetryRef.current = null; }
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
        // Request microphone permission (skip in test mode — no mic needed)
        if (!testModeRef.current) {
          const hasPermission = await requestMicPermission();
          if (!hasPermission) {
            Alert.alert(
              'Microphone Required',
              'Angel AI needs microphone access to listen to your conversations. Please enable it in Settings.',
              [{ text: 'OK' }]
            );
            return;
          }
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

        // Load speech recognition settings (keywords + locale)
        const keywordsRaw = await SecureStore.getItemAsync('angel_v2_speech_keywords');
        const keywords = keywordsRaw
          ? keywordsRaw.split('\n').map(k => k.trim()).filter(Boolean)
          : undefined;
        const speechLocale = await SecureStore.getItemAsync('angel_v2_speech_locale');
        const speech: Record<string, unknown> = {};
        if (keywords && keywords.length > 0) speech.keywords = keywords;
        if (speechLocale && speechLocale !== 'en') speech.speechLocale = speechLocale;
        if (Object.keys(speech).length > 0) startPayload.speech = speech;

        // Load Angel mode + settings
        try {
          startPayload.mode = angelMode;
          startPayload.translateLanguages = translateLangs;
          startPayload.intelligencePresets = intelligencePresets;
          const savedCustom = await SecureStore.getItemAsync('angel_v2_custom_instructions');
          if (savedCustom?.trim()) startPayload.customInstructions = savedCustom.trim();
          const ownerLang = await SecureStore.getItemAsync('angel_v2_owner_language');
          if (ownerLang) startPayload.ownerLanguage = ownerLang;
        } catch (instrErr) {
          console.warn('[session] Failed to load Angel instructions:', instrErr);
        }

        // Load TTS voice preference (outside instruction try/catch so it always loads)
        const savedVoice = await SecureStore.getItemAsync('angel_v2_voice_id');
        if (savedVoice) {
          startPayload.voiceId = savedVoice;
        }

        // Load audio device preferences before recording starts
        const savedMic = await SecureStore.getItemAsync('angel_v2_mic_source');
        setMicSource(savedMic === 'phone' || savedMic === 'bluetooth' ? savedMic : 'auto');
        const savedOutput = await SecureStore.getItemAsync('angel_v2_output_device');
        setOutputDevice(savedOutput === 'speaker' || savedOutput === 'bluetooth' ? savedOutput : 'auto');

        // Cache the full payload for reconnect and register listeners BEFORE
        // emitting so we don't miss any fast server responses.
        startPayloadRef.current = startPayload;
        registerSessionListeners(socket);

        // Initialize TTS player for voice whisper playback via AirPods
        const ttsPlayer = getTTSPlayer({
          onPlaybackDone: (whisperId) => {
            const currentSocket = getSocket();
            currentSocket?.emit('tts:finished', { whisperId });
          },
        });
        await ttsPlayer.init();

        socket.emit('session:start', startPayload);

        // If test mode — trigger test script and SKIP recording so TTS audio
        // can play without the recording session claiming the audio hardware.
        // Retry every 1s up to 10s waiting for server to be ready.
        const isTestMode = testModeRef.current;
        if (isTestMode) {
          testModeRef.current = false;
          let attempts = 0;
          const tryTest = () => {
            attempts++;
            const s = getSocket();
            if (!s?.connected || !isActiveRef.current) return;
            s.off('test:not-ready');
            s.emit('session:test', { type: testTypeRef.current });
            s.once('test:not-ready', () => {
              if (attempts < 10 && isActiveRef.current) {
                testRetryRef.current = setTimeout(tryTest, 1000);
              }
            });
          };
          testRetryRef.current = setTimeout(tryTest, 2000);
        } else {
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
        }
        isStartingRef.current = false;
      } catch (err: any) {
        console.error('Failed to start session:', err);
        await stopRecording();
        disposeTTSPlayer();
        cleanupSessionListeners();
        disconnectSocket();
        if (timerRef.current) clearInterval(timerRef.current);
        if (testRetryRef.current) { clearTimeout(testRetryRef.current); testRetryRef.current = null; }
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

      {/* AI engine status banner */}
      {aiStatus === 'error' && isActive && (
        <View style={styles.reconnectBanner}>
          <Ionicons name="warning-outline" size={16} color={colors.warning} />
          <Text style={styles.reconnectText}>AI engine disconnected — whispers paused</Text>
        </View>
      )}

      {/* Unified single-screen layout */}
      {isActive || segments.length > 0 ? (
        <View style={styles.activeContainer}>
          <TranscriptView
            segments={segments}
            speakerNames={speakerNames}
            whisperCards={whisperCards}
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.idleContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
        >
          {/* Mode selector */}
          <View style={styles.instructionSection}>
            <Text style={styles.sectionTitle}>Angel Mode</Text>
            <View style={styles.modeRow}>
              {ANGEL_MODES.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.modeCard, angelMode === m.id && styles.modeCardActive]}
                  onPress={() => selectMode(m.id)}
                  activeOpacity={0.7}
                >
                  <Ionicons name={m.icon as any} size={20} color={angelMode === m.id ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.modeLabel, angelMode === m.id && styles.modeLabelActive]}>{m.label}</Text>
                  <Text style={styles.modeDesc} numberOfLines={1}>{m.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {(angelMode === 'translation' || angelMode === 'hybrid') && (
              <View style={styles.modeOptions}>
                <Text style={styles.optionLabel}>Translate from:</Text>
                <View style={styles.presetGrid}>
                  {TRANSLATE_LANGUAGES.map((lang) => (
                    <TouchableOpacity key={lang.id} style={[styles.presetChip, translateLangs.includes(lang.id) && styles.presetChipActive]} onPress={() => toggleTranslateLang(lang.id)}>
                      <Text style={styles.presetIcon}>{lang.flag}</Text>
                      <Text style={[styles.presetLabel, translateLangs.includes(lang.id) && styles.presetLabelActive]} numberOfLines={1}>{lang.id}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            {(angelMode === 'intelligence' || angelMode === 'hybrid') && (
              <View style={styles.modeOptions}>
                <Text style={styles.optionLabel}>{angelMode === 'hybrid' ? 'Also help with:' : 'Help with:'}</Text>
                <View style={styles.presetGrid}>
                  {INTELLIGENCE_PRESETS.map((preset) => (
                    <TouchableOpacity key={preset.id} style={[styles.presetChip, intelligencePresets.includes(preset.id) && styles.presetChipActive]} onPress={() => toggleIntelligencePreset(preset.id)}>
                      <Text style={styles.presetIcon}>{preset.icon}</Text>
                      <Text style={[styles.presetLabel, intelligencePresets.includes(preset.id) && styles.presetLabelActive]} numberOfLines={1}>{preset.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            <TextInput
              style={[styles.customInput, instructionsFocused && styles.inputFocused]}
              value={customInstructions}
              onChangeText={saveCustomInstructions}
              onFocus={() => setInstructionsFocused(true)}
              onBlur={() => setInstructionsFocused(false)}
              placeholder="Custom instructions..."
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={2}
            />
          </View>

          {/* History */}
          <View style={styles.historySection}>
            <Text style={styles.sectionTitle}>History</Text>
            {sessionsLoading && !sessions ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.lg }} />
            ) : Array.isArray(sessions) && sessions.length > 0 ? (
              sessions.map((session) => (
                <SessionCard
                  key={session.id}
                  session={session}
                  onPress={() => navigation.navigate('Debrief', { sessionId: session.id })}
                  onDelete={async () => {
                    try { await api.delete(`sessions/${session.id}`); refetchSessions(); } catch (err) {
                      Alert.alert('Error', 'Failed to delete session.');
                    }
                  }}
                />
              ))
            ) : (
              <View style={styles.emptyState}>
                <Ionicons name="mic-outline" size={32} color={colors.textTertiary} />
                <Text style={styles.emptyText}>No conversations yet</Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}

      {/* Angel command input (only during active session) */}
      {isActive && (
        <View style={styles.directiveRow}>
          <TextInput
            style={[styles.directiveInput, directiveFocused && styles.inputFocused]}
            value={liveDirective}
            onChangeText={setLiveDirective}
            onFocus={() => setDirectiveFocused(true)}
            onBlur={() => setDirectiveFocused(false)}
            placeholder="Angel command..."
            placeholderTextColor={colors.textTertiary}
            returnKeyType="send"
            onSubmitEditing={sendLiveDirective}
            blurOnSubmit={false}
          />
          {liveDirective.trim().length > 0 && (
            <TouchableOpacity onPress={sendLiveDirective} style={styles.directiveSend}>
              <Ionicons name="arrow-up-circle" size={28} color={colors.primary} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Speed toggle for TTS (translation mode only) */}
      {isActive && angelMode === 'translation' && (
        <View style={styles.speedRow}>
          {(['normal', 'fast', 'fastest', 'ultra'] as const).map((s) => (
            <TouchableOpacity
              key={s}
              style={[styles.speedChip, ttsSpeed === s && styles.speedChipActive]}
              onPress={() => changeTtsSpeed(s)}
            >
              <Text style={[styles.speedText, ttsSpeed === s && styles.speedTextActive]}>
                {s === 'normal' ? '1×' : s === 'fast' ? '1.5×' : s === 'fastest' ? '2×' : '3×'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Bottom control bar */}
      <View style={styles.activeButtonRow}>
        {isActive && showGain && (
          <View style={styles.gainRow}>
            <Ionicons name="mic-outline" size={16} color={colors.textSecondary} />
            <Slider
              style={styles.gainSlider}
              minimumValue={0.5}
              maximumValue={5.0}
              step={0.5}
              value={gain}
              onValueChange={(v) => { setGainState(v); setGain(v); }}
              minimumTrackTintColor={colors.primary}
              maximumTrackTintColor={colors.border}
              thumbTintColor={colors.primary}
            />
            <Text style={styles.gainLabel}>{gain.toFixed(1)}×</Text>
          </View>
        )}
        <View style={styles.bottomControls}>
          {isActive ? (
            <TouchableOpacity
              onPress={() => setShowGain(!showGain)}
              style={[styles.gainToggle, showGain && { backgroundColor: colors.primaryMuted }]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="volume-high-outline" size={18} color={showGain ? colors.primary : colors.textSecondary} />
              <Text style={[styles.gainToggleText, showGain && { color: colors.primary }]}>{gain.toFixed(1)}×</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={styles.testButton} onPress={handleTest}>
              <Ionicons name="flask-outline" size={14} color={colors.primary} />
              <Text style={styles.testButtonText}>Test</Text>
            </TouchableOpacity>
          )}
          <AngelButton onPress={handleToggle} isActive={isActive} />
          {isActive ? (
            <TouchableOpacity
              onPress={handleAngelActivate}
              disabled={angelThinking}
              style={[styles.askAngelBtn, angelThinking && { opacity: 0.5 }]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              {angelThinking ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Ionicons name="sparkles" size={18} color={colors.primary} />
              )}
              <Text style={styles.askAngelText}>Ask</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.settingsBtn}
              onPress={() => navigation.navigate('Settings' as never)}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="settings-outline" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>
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
  directiveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  directiveInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 20,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    fontSize: fontSize.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  directiveSend: {
    padding: 2,
  },
  inputFocused: {
    borderColor: colors.primary,
    backgroundColor: colors.surfaceRaised,
  },
  speedRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  speedChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  speedChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  speedText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  speedTextActive: {
    color: colors.primary,
  },
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
  settingsBtn: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs + 2,
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
    paddingVertical: spacing.xxl,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.lg,
    borderRadius: 22,
    backgroundColor: colors.primaryMuted,
    borderWidth: 1,
    borderColor: colors.primary + '40',
  },
  testButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  instructionSection: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  modeRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  modeCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  modeCardActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  modeLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  modeLabelActive: {
    color: colors.primary,
  },
  modeDesc: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textAlign: 'center',
  },
  modeOptions: {
    marginTop: spacing.md,
  },
  optionLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  presetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  presetChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 4,
    borderRadius: 20,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  presetIcon: { fontSize: 14 },
  presetLabel: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '600',
    flexShrink: 1,
  },
  presetLabelActive: { color: colors.primary },
  customInput: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.sm,
    color: colors.text,
    fontSize: fontSize.sm,
    marginTop: spacing.md,
    minHeight: 60,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: colors.border,
  },
  historySection: { marginTop: spacing.sm },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
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
