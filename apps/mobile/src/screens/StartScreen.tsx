import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { useAuth } from '../hooks/useAuth';
import { connectSocket, disconnectSocket, getSocket, onSocketStateChange } from '../services/socket';
import { requestMicPermission, startRecording, stopRecording, setGain, getGain, setMicSource, setOutputDevice } from '../services/audio';
import { api } from '../services/api'; // Used for session creation
import { getTTSPlayer, disposeTTSPlayer } from '../services/ttsPlayer';
import { colors, spacing, fontSize, radius } from '../theme';
import type { TranscriptSegment, WhisperCardData } from '../types';

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
  'code_task:status',
  'mode:switched',
  'tts:start',
  'tts:chunk',
  'tts:done',
  'tts:cancel',
  'realtime:status',
] as const;

type AngelMode = 'translation' | 'intelligence' | 'hybrid' | 'code';

const ANGEL_MODES: { id: AngelMode; label: string; icon: string; desc: string }[] = [
  { id: 'translation', label: 'Translation', icon: 'language-outline', desc: 'Real-time translation of foreign languages in your conversations' },
  { id: 'intelligence', label: 'Intelligence', icon: 'bulb-outline', desc: 'Jargon explainer, meeting notes, coaching, fact-checking & more' },
  { id: 'hybrid', label: 'Hybrid', icon: 'git-merge-outline', desc: 'Translation + intelligence insights combined in one session' },
  { id: 'code', label: 'Code', icon: 'code-slash-outline', desc: 'Coding assistant — debug, refactor, architecture & code review' },
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

const CODE_PRESETS = [
  { id: 'debug', label: 'Debug', icon: '🐛' },
  { id: 'refactor', label: 'Refactor', icon: '♻️' },
  { id: 'explain', label: 'Explain code', icon: '💡' },
  { id: 'architecture', label: 'Architecture', icon: '🏗️' },
  { id: 'review', label: 'Code review', icon: '🔍' },
  { id: 'docs', label: 'Documentation', icon: '📝' },
];

export function StartScreen() {
  const insets = useSafeAreaInsets();
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
  // Code task lifecycle: null = idle, string = "dispatching" | "working" | "done" | "failed"
  const [codeTaskStatus, setCodeTaskStatus] = useState<null | 'dispatching' | 'working' | 'done' | 'failed'>(null);
  const [codeTaskDetail, setCodeTaskDetail] = useState<string>('');
  const codeTaskClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeTaskBusyRef = useRef(false); // Synchronous gate for audio callback
  const [angelMode, setAngelMode] = useState<AngelMode>('intelligence');
  const [translateLangs, setTranslateLangs] = useState<string[]>(['Chinese']);
  const [intelligencePresets, setIntelligencePresets] = useState<string[]>(['jargon']);
  const [codePresets, setCodePresets] = useState<string[]>(['debug', 'explain']);
  const [customInstructions, setCustomInstructions] = useState('');
  const [liveDirective, setLiveDirective] = useState('');
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

  // History is now in its own tab — this is a no-op for cleanup paths
  const refetchSessions = useCallback(() => {}, []);

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

    sock.on('mode:switched', (data: { mode: AngelMode; from: AngelMode }) => {
      setAngelMode(data.mode);
      SecureStore.setItemAsync('angel_v2_mode', data.mode).catch(() => {});
    });

    sock.on('code_task:status', (data: { status: 'dispatching' | 'working' | 'done' | 'failed'; task?: string; detail?: string; result?: string; error?: string }) => {
      // Update busy ref synchronously so audio callback sees it immediately
      codeTaskBusyRef.current = data.status === 'dispatching' || data.status === 'working';
      setCodeTaskStatus(data.status);
      if (data.status === 'dispatching') setCodeTaskDetail(data.task || 'Sending to Claude Code...');
      else if (data.status === 'working') setCodeTaskDetail(data.detail || 'Working...');
      else if (data.status === 'done') setCodeTaskDetail(data.result ? data.result.slice(0, 160) : 'Task completed');
      else if (data.status === 'failed') setCodeTaskDetail(data.error || 'Task failed');

      // Clear any previous auto-clear timer
      if (codeTaskClearTimerRef.current) { clearTimeout(codeTaskClearTimerRef.current); codeTaskClearTimerRef.current = null; }

      // Terminal states auto-clear after 4s so user can see the result
      if (data.status === 'done' || data.status === 'failed') {
        codeTaskBusyRef.current = false; // Release audio/input lock immediately
        codeTaskClearTimerRef.current = setTimeout(() => {
          setCodeTaskStatus(null);
          setCodeTaskDetail('');
          codeTaskClearTimerRef.current = null;
        }, 4000);
      }
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
  }, [cleanupSessionListeners, refetchSessions]);

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
          // Re-send TTS speed setting (server creates fresh TTS on reconnect)
          if (ttsSpeed !== 'normal') {
            sock.emit('tts:speed', { speed: ttsSpeed });
          }
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

  // Load mode settings from SecureStore. Each key is parsed independently so a
  // single corrupted value doesn't prevent the rest of the settings from loading.
  useEffect(() => {
    const parseArray = async (key: string, apply: (arr: string[]) => void) => {
      try {
        const raw = await SecureStore.getItemAsync(key);
        if (!raw) return;
        const p = JSON.parse(raw);
        if (Array.isArray(p)) apply(p);
      } catch {}
    };
    (async () => {
      try {
        const savedMode = await SecureStore.getItemAsync('angel_v2_mode');
        if (savedMode === 'translation' || savedMode === 'intelligence' || savedMode === 'hybrid' || savedMode === 'code') setAngelMode(savedMode as AngelMode);
      } catch {}
      await parseArray('angel_v2_translate_languages', setTranslateLangs);
      await parseArray('angel_v2_intelligence_presets', setIntelligencePresets);
      await parseArray('angel_v2_code_presets', setCodePresets);
      try {
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

  const toggleCodePreset = useCallback((presetId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCodePresets((prev) => {
      const updated = prev.includes(presetId) ? prev.filter((p) => p !== presetId) : [...prev, presetId];
      SecureStore.setItemAsync('angel_v2_code_presets', JSON.stringify(updated));
      return updated;
    });
  }, []);

  const saveCustomInstructions = useCallback(async (text: string) => {
    setCustomInstructions(text);
    await SecureStore.setItemAsync('angel_v2_custom_instructions', text);
  }, []);

  const sendMessage = useCallback(() => {
    const text = liveDirective.trim();
    if (!text) return;
    const sock = getSocket();
    if (!sock?.connected) return;

    if (text.startsWith('/')) {
      // System command — modifies Angel's behavior
      sock.emit('session:instruct', { text: text.slice(1).trim() });
    } else {
      // Message to Angel — fed as Owner transcript so AI responds
      sock.emit('session:message', { text });
      // Show it locally as a transcript segment
      setSegments((prev) => [...prev, {
        id: `msg-${Date.now()}`,
        speaker: 'owner',
        speakerLabel: 'You',
        text,
        isFinal: true,
        timestamp: Date.now(),
      }]);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setLiveDirective('');
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

  const handleAngelStop = useCallback(() => {
    const sock = getSocket();
    if (!sock?.connected) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Stop any local TTS immediately — don't wait for server roundtrip
    const player = getTTSPlayer();
    if (player.playing) player.stop();
    sock.emit('angel:stop');
    // Clear local state optimistically; server will confirm via events
    setAngelThinking(false);
    codeTaskBusyRef.current = false;
  }, []);

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

        const session = await api.post<{ id: string }>('sessions', {});
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
          startPayload.codePresets = codePresets;
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
            // Drop audio chunks while Claude Code is working — prevents picking up
            // stray speech during long code tasks and avoids polluting transcript.
            if (codeTaskBusyRef.current) return;
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

  const modeLabel = ANGEL_MODES.find((m) => m.id === angelMode)?.label || 'Intelligence';

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.appTitle}>Angel AI</Text>
          {isActive && (
            <View style={styles.activeRow}>
              <Animated.View style={[styles.activeDot, dotStyle]} />
              <Text style={styles.activeText}>ACTIVE</Text>
              <View style={styles.modeBadge}>
                <Text style={styles.modeBadgeText}>{modeLabel}</Text>
              </View>
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

      {/* ═══ TOP: Transcript / Mode cards ═══ */}
      <View style={styles.activeContainer}>
        {segments.length > 0 || isActive ? (
          <TranscriptView
            segments={segments}
            speakerNames={speakerNames}
            whisperCards={whisperCards}
          />
        ) : (
          <ScrollView contentContainerStyle={styles.idleContent} showsVerticalScrollIndicator={false}>
            {/* Mode cards */}
            <View style={styles.modeGrid}>
              {ANGEL_MODES.map((m) => (
                <TouchableOpacity
                  key={m.id}
                  style={[styles.modeCard, angelMode === m.id && styles.modeCardActive]}
                  onPress={() => selectMode(m.id)}
                  activeOpacity={0.7}
                >
                  <View style={styles.modeCardHeader}>
                    <Ionicons name={m.icon as any} size={18} color={angelMode === m.id ? colors.primary : colors.textSecondary} />
                    <Text style={[styles.modeCardLabel, angelMode === m.id && styles.modeCardLabelActive]}>{m.label}</Text>
                    {angelMode === m.id && <Ionicons name="checkmark-circle" size={16} color={colors.primary} />}
                  </View>
                  <Text style={styles.modeCardDesc}>{m.desc}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Test button */}
            <TouchableOpacity style={styles.testButton} onPress={handleTest} activeOpacity={0.7}>
              <Ionicons name="flask-outline" size={14} color={colors.primary} />
              <Text style={styles.testButtonText}>Test with Sample</Text>
            </TouchableOpacity>
          </ScrollView>
        )}
      </View>

      {/* ═══ LIVE STATUS BANNER — thinking / code task ═══ */}
      {(angelThinking || codeTaskStatus) && (
        <View style={[
          styles.statusBanner,
          codeTaskStatus === 'done' && styles.statusBannerSuccess,
          codeTaskStatus === 'failed' && styles.statusBannerError,
        ]}>
          {codeTaskStatus === 'done' ? (
            <Ionicons name="checkmark-circle" size={16} color={colors.success} />
          ) : codeTaskStatus === 'failed' ? (
            <Ionicons name="alert-circle" size={16} color={colors.warning} />
          ) : (
            <ActivityIndicator size="small" color={colors.primary} />
          )}
          <Text style={styles.statusBannerText} numberOfLines={2}>
            {codeTaskStatus === 'dispatching' && `💻 Sending to Claude Code: ${codeTaskDetail}`}
            {codeTaskStatus === 'working' && `⚙️ Claude Code working: ${codeTaskDetail}`}
            {codeTaskStatus === 'done' && `✅ ${codeTaskDetail}`}
            {codeTaskStatus === 'failed' && `❌ ${codeTaskDetail}`}
            {!codeTaskStatus && angelThinking && '✨ Angel is thinking...'}
          </Text>
        </View>
      )}

      {/* ═══ BOTTOM: Controls ═══ */}

      {/* Text input */}
      <View style={styles.directiveRow}>
        <TextInput
          style={[
            styles.directiveInput,
            directiveFocused && styles.inputFocused,
            (codeTaskStatus === 'dispatching' || codeTaskStatus === 'working') && { opacity: 0.5 },
          ]}
          value={liveDirective}
          onChangeText={setLiveDirective}
          onFocus={() => setDirectiveFocused(true)}
          onBlur={() => setDirectiveFocused(false)}
          placeholder={
            codeTaskStatus === 'dispatching' || codeTaskStatus === 'working'
              ? '🔒 Claude Code is working — input paused...'
              : isActive ? 'Talk to Angel... ( /command )' : 'Type to Angel after starting...'
          }
          placeholderTextColor={colors.textTertiary}
          returnKeyType="send"
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
          editable={isActive && codeTaskStatus !== 'dispatching' && codeTaskStatus !== 'working'}
        />
        {liveDirective.trim().length > 0 && (
          <TouchableOpacity onPress={sendMessage} style={styles.directiveSend}>
            <Ionicons name="arrow-up-circle" size={28} color={colors.primary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Speed toggle (active only) */}
      {isActive && (
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

      {/* Gain slider */}
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

      {/* Bottom bar */}
      <View style={styles.bottomControls}>
        {isActive && (
          <TouchableOpacity
            onPress={() => setShowGain(!showGain)}
            style={[styles.gainToggle, showGain && { backgroundColor: colors.primaryMuted }]}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="volume-high-outline" size={18} color={showGain ? colors.primary : colors.textSecondary} />
          </TouchableOpacity>
        )}
        <AngelButton onPress={handleToggle} isActive={isActive} compact />
        {isActive && (
          (angelThinking || codeTaskStatus === 'dispatching' || codeTaskStatus === 'working') ? (
            <TouchableOpacity
              onPress={handleAngelStop}
              style={styles.stopAngelBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="stop-circle" size={18} color={colors.danger} />
              <Text style={styles.stopAngelText}>Stop</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={handleAngelActivate}
              style={styles.askAngelBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Ionicons name="sparkles" size={18} color={colors.primary} />
              <Text style={styles.askAngelText}>Ask</Text>
            </TouchableOpacity>
          )
        )}
      </View>
    </KeyboardAvoidingView>
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
  modeBadge: {
    backgroundColor: colors.primaryMuted,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  modeBadgeText: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '700',
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
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: 'rgba(124, 127, 255, 0.12)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(124, 127, 255, 0.3)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(124, 127, 255, 0.3)',
  },
  statusBannerSuccess: {
    backgroundColor: 'rgba(52, 211, 153, 0.12)',
    borderTopColor: 'rgba(52, 211, 153, 0.3)',
    borderBottomColor: 'rgba(52, 211, 153, 0.3)',
  },
  statusBannerError: {
    backgroundColor: 'rgba(251, 191, 36, 0.12)',
    borderTopColor: 'rgba(251, 191, 36, 0.3)',
    borderBottomColor: 'rgba(251, 191, 36, 0.3)',
  },
  statusBannerText: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },
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
  stopAngelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: radius.full,
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    width: 64,
    justifyContent: 'center',
  },
  stopAngelText: {
    color: colors.danger,
    fontSize: fontSize.xs,
    fontWeight: '700',
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
  bottomControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
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
  idleContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  modeGrid: {
    gap: spacing.sm,
  },
  modeCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  modeCardActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  modeCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  modeCardLabel: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '700',
    flex: 1,
  },
  modeCardLabelActive: {
    color: colors.primary,
  },
  modeCardDesc: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
  testButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    alignSelf: 'center',
  },
  testButtonText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
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
});
