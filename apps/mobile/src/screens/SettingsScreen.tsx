import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  Switch,
  Linking,
  ActivityIndicator,
} from 'react-native';
import * as ExpoClipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AudioContext, AudioBufferQueueSourceNode } from 'react-native-audio-api';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';
import { getStoredToken } from '../services/auth';
import { API_URL } from '../config';
import { VoiceEnrollment } from '../components/VoiceEnrollment';
import { colors, spacing, fontSize } from '../theme';

const API_KEY_STORAGE = {
  openai: 'angel_v2_openai_key',
  anthropic: 'angel_v2_anthropic_key',
  google: 'angel_v2_google_key',
};

type ModelProvider = 'openai' | 'anthropic' | 'google';


const ENGLISH_LOCALES = [
  { code: 'en', label: 'General', flag: '🌐' },
  { code: 'en-US', label: 'US', flag: '🇺🇸' },
  { code: 'en-GB', label: 'UK', flag: '🇬🇧' },
  { code: 'en-AU', label: 'Australia', flag: '🇦🇺' },
  { code: 'en-IN', label: 'India', flag: '🇮🇳' },
  { code: 'en-SG', label: 'Singapore', flag: '🇸🇬' },
  { code: 'en-NZ', label: 'NZ', flag: '🇳🇿' },
  { code: 'en-IE', label: 'Ireland', flag: '🇮🇪' },
];

const OWNER_LANGUAGES = [
  { code: 'English', flag: '🇬🇧' },
  { code: 'Chinese', flag: '🇨🇳' },
  { code: 'Malay', flag: '🇲🇾' },
  { code: 'Spanish', flag: '🇪🇸' },
  { code: 'French', flag: '🇫🇷' },
  { code: 'Japanese', flag: '🇯🇵' },
  { code: 'Korean', flag: '🇰🇷' },
  { code: 'Hindi', flag: '🇮🇳' },
];

type VoiceOption = { id: string; name: string; description: string; language: string };
type MicSource = 'auto' | 'phone' | 'bluetooth';
type OutputDevice = 'auto' | 'speaker' | 'bluetooth';

export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const [selectedProvider, setSelectedProvider] = useState<ModelProvider>('openai');
  const [apiKeys, setApiKeys] = useState<Record<ModelProvider, string>>({
    openai: '',
    anthropic: '',
    google: '',
  });
  const [showKeys, setShowKeys] = useState(false);
  const [byok, setByok] = useState(false);
  const [testingKey, setTestingKey] = useState<ModelProvider | null>(null);
  const [voiceprintEnrolled, setVoiceprintEnrolled] = useState(false);
  const [speechLocale, setSpeechLocale] = useState('en');
  const [keywordsText, setKeywordsText] = useState('');
  const [ownerLanguage, setOwnerLanguage] = useState('English');
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const previewSourceRef = useRef<AudioBufferQueueSourceNode | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const [micSource, setMicSource] = useState<MicSource>('auto');
  const [outputDevice, setOutputDevice] = useState<OutputDevice>('auto');

  const version = Constants.expoConfig?.version || '2.0.0';
  const buildNumber = Constants.expoConfig?.ios?.buildNumber || '';
  const [workers, setWorkers] = useState<{ id: string; name: string; busy: boolean }[]>([]);
  const [showSetup, setShowSetup] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);

  const loadWorkers = React.useCallback(async () => {
    try {
      const res = await api.get<{ id: string; name: string; busy: boolean }[]>('workers');
      if (Array.isArray(res)) setWorkers(res);
    } catch {}
  }, []);

  const copySetupCommand = React.useCallback(async () => {
    const token = await getStoredToken();
    if (!token) { Alert.alert('Error', 'Not logged in'); return; }
    const cmd = `bash <(curl -fsSL https://raw.githubusercontent.com/articfoxy/angel-ai-v2/main/packages/worker/setup.sh) --token ${token}`;
    await ExpoClipboard.setStringAsync(cmd);
    setCopiedToken(true);
    setTimeout(() => setCopiedToken(false), 3000);
  }, []);

  const loadVoiceprintStatus = React.useCallback(async () => {
    try {
      const res = await api.get<{ enrolled: boolean }>('voiceprint/status');
      setVoiceprintEnrolled(res?.enrolled ?? false);
    } catch {}
  }, []);

  const loadVoices = React.useCallback(async () => {
    setVoicesLoading(true);
    try {
      const res = await api.get<VoiceOption[]>('voices');
      if (Array.isArray(res)) setVoices(res);
    } catch {}
    setVoicesLoading(false);
  }, []);

  const loadAudioDevices = React.useCallback(async () => {
    const mic = await SecureStore.getItemAsync('angel_v2_mic_source');
    if (mic === 'phone' || mic === 'bluetooth') setMicSource(mic);
    const out = await SecureStore.getItemAsync('angel_v2_output_device');
    if (out === 'speaker' || out === 'bluetooth') setOutputDevice(out);
  }, []);

  const loadSelectedVoice = React.useCallback(async () => {
    const saved = await SecureStore.getItemAsync('angel_v2_voice_id');
    if (saved) setSelectedVoice(saved);
  }, []);

  React.useEffect(() => {
    loadKeys();
    loadVoiceprintStatus();
    loadSpeechSettings();
    loadVoices();
    loadAudioDevices();
    loadSelectedVoice();
    loadWorkers();
  }, [loadVoiceprintStatus, loadVoices, loadAudioDevices, loadSelectedVoice, loadWorkers]);

  React.useEffect(() => {
    return () => {
      if (previewSourceRef.current) {
        try { previewSourceRef.current.stop(); } catch {}
        previewSourceRef.current = null;
      }
      if (previewCtxRef.current) {
        previewCtxRef.current.close();
        previewCtxRef.current = null;
      }
    };
  }, []);

  const loadSpeechSettings = async () => {
    const locale = await SecureStore.getItemAsync('angel_v2_speech_locale');
    if (locale) setSpeechLocale(locale);
    const kw = await SecureStore.getItemAsync('angel_v2_speech_keywords');
    if (kw) setKeywordsText(kw);
    // Load Owner Language
    const savedOwnerLang = await SecureStore.getItemAsync('angel_v2_owner_language');
    if (savedOwnerLang) setOwnerLanguage(savedOwnerLang);
  };


  const saveOwnerLanguage = async (lang: string) => {
    setOwnerLanguage(lang);
    await SecureStore.setItemAsync('angel_v2_owner_language', lang);
  };

  const saveSpeechLocale = async (locale: string) => {
    setSpeechLocale(locale);
    await SecureStore.setItemAsync('angel_v2_speech_locale', locale);
  };

  const saveKeywords = async () => {
    await SecureStore.setItemAsync('angel_v2_speech_keywords', keywordsText);
    Alert.alert('Saved', 'Keywords will be used in your next session.');
  };

  const saveVoice = async (voiceId: string) => {
    setSelectedVoice(voiceId);
    await SecureStore.setItemAsync('angel_v2_voice_id', voiceId);
  };

  const previewVoice = async (voiceId: string) => {
    // Toggle off if already playing this voice
    if (playingVoiceId === voiceId) {
      if (previewAbortRef.current) { previewAbortRef.current.abort(); previewAbortRef.current = null; }
      if (previewSourceRef.current) { try { previewSourceRef.current.stop(); } catch {} previewSourceRef.current = null; }
      if (previewCtxRef.current) { previewCtxRef.current.close(); previewCtxRef.current = null; }
      setPlayingVoiceId(null);
      return;
    }
    // Stop any existing preview + abort in-flight fetch
    if (previewAbortRef.current) { previewAbortRef.current.abort(); previewAbortRef.current = null; }
    if (previewSourceRef.current) { try { previewSourceRef.current.stop(); } catch {} previewSourceRef.current = null; }
    if (previewCtxRef.current) { previewCtxRef.current.close(); previewCtxRef.current = null; }

    setPlayingVoiceId(voiceId);
    try {
      // Fetch WAV from server (with abort controller + auth)
      const abort = new AbortController();
      previewAbortRef.current = abort;
      const token = await getStoredToken();
      const response = await fetch(`${API_URL}/api/voices/preview/${voiceId}`, {
        signal: abort.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        Alert.alert('Preview Failed', `Server returned ${response.status}`);
        setPlayingVoiceId(null);
        return;
      }
      const arrayBuffer = await response.arrayBuffer();

      // Parse WAV header to find PCM data chunk
      const view = new DataView(arrayBuffer);
      let dataOffset = 44;
      let dataSize = arrayBuffer.byteLength - 44;
      for (let i = 12; i < Math.min(arrayBuffer.byteLength - 8, 200); i++) {
        if (
          view.getUint8(i) === 0x64 &&     // 'd'
          view.getUint8(i + 1) === 0x61 &&  // 'a'
          view.getUint8(i + 2) === 0x74 &&  // 't'
          view.getUint8(i + 3) === 0x61     // 'a'
        ) {
          dataSize = view.getUint32(i + 4, true);
          dataOffset = i + 8;
          break;
        }
      }

      // Clamp dataSize to actual buffer bounds to prevent RangeError on truncated WAV
      const actualDataSize = Math.max(0, Math.min(dataSize, arrayBuffer.byteLength - dataOffset));
      if (actualDataSize < 2) {
        Alert.alert('Preview Failed', 'Audio data too short or corrupted');
        setPlayingVoiceId(null);
        return;
      }

      // Convert 16-bit signed LE PCM → Float32 [-1, 1]
      const pcmBytes = new Uint8Array(arrayBuffer, dataOffset, actualDataSize);
      const int16 = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, Math.floor(pcmBytes.byteLength / 2));
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }

      // Play via react-native-audio-api (same engine as TTS — proven to work)
      const ctx = new AudioContext({ sampleRate: 24000 });
      previewCtxRef.current = ctx;

      const buffer = ctx.createBuffer(1, float32.length, 24000);
      buffer.copyToChannel(float32, 0, 0);

      const source = ctx.createBufferQueueSource();
      source.connect(ctx.destination);
      source.onEnded = () => {
        setPlayingVoiceId(null);
        ctx.close();
        if (previewCtxRef.current === ctx) previewCtxRef.current = null;
        if (previewSourceRef.current === source) previewSourceRef.current = null;
      };
      source.enqueueBuffer(buffer);
      source.start();
      previewSourceRef.current = source;
    } catch (err: any) {
      // Silently handle user-initiated abort (tap to stop while loading)
      if (err?.name === 'AbortError') { setPlayingVoiceId(null); return; }
      console.warn('[settings] Voice preview failed:', err);
      Alert.alert('Preview Error', err?.message || 'Could not play voice preview');
      setPlayingVoiceId(null);
    }
  };

  const saveMicSource = async (source: MicSource) => {
    setMicSource(source);
    await SecureStore.setItemAsync('angel_v2_mic_source', source);
  };

  const saveOutputDevice = async (device: OutputDevice) => {
    setOutputDevice(device);
    await SecureStore.setItemAsync('angel_v2_output_device', device);
  };

  const loadKeys = async () => {
    const keys: Record<ModelProvider, string> = { openai: '', anthropic: '', google: '' };
    for (const [provider, storageKey] of Object.entries(API_KEY_STORAGE)) {
      const val = await SecureStore.getItemAsync(storageKey);
      if (val) keys[provider as ModelProvider] = val;
    }
    setApiKeys(keys);

    // Load BYOK state
    const savedByok = await SecureStore.getItemAsync('angel_v2_byok_enabled');
    if (savedByok === 'true') setByok(true);
    const savedProvider = await SecureStore.getItemAsync('angel_v2_byok_provider');
    if (savedProvider) setSelectedProvider(savedProvider as ModelProvider);
  };

  const toggleByok = async (enabled: boolean) => {
    setByok(enabled);
    await SecureStore.setItemAsync('angel_v2_byok_enabled', enabled ? 'true' : 'false');
    if (!enabled) {
      await SecureStore.deleteItemAsync('angel_v2_byok_provider');
    } else {
      await SecureStore.setItemAsync('angel_v2_byok_provider', selectedProvider);
    }
  };

  const selectProvider = async (provider: ModelProvider) => {
    setSelectedProvider(provider);
    if (byok) {
      await SecureStore.setItemAsync('angel_v2_byok_provider', provider);
    }
  };

  const saveKey = async (provider: ModelProvider, key: string) => {
    if (key.trim()) {
      await SecureStore.setItemAsync(API_KEY_STORAGE[provider], key.trim());
    } else {
      await SecureStore.deleteItemAsync(API_KEY_STORAGE[provider]);
    }
    setApiKeys((prev) => ({ ...prev, [provider]: key }));
  };

  const testApiKey = async (provider: ModelProvider) => {
    const key = apiKeys[provider]?.trim();
    if (!key) {
      Alert.alert('No Key', 'Please enter an API key first.');
      return;
    }
    setTestingKey(provider);
    try {
      let response: Response;
      if (provider === 'openai') {
        response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }),
        });
      } else if (provider === 'anthropic') {
        response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 5, messages: [{ role: 'user', content: 'Hi' }] }),
        });
      } else {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Hi' }] }] }),
        });
      }
      if (response.ok) {
        Alert.alert('Success', `${PROVIDERS.find((p) => p.key === provider)?.name} key is valid.`);
      } else {
        const body = await response.text();
        Alert.alert('Invalid Key', `Status ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Network error');
    } finally {
      setTestingKey(null);
    }
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all associated data. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            try {
              await api.delete('auth/account');
              logout();
            } catch (err) {
              Alert.alert('Error', err instanceof Error ? err.message : 'Failed to delete account');
            }
          },
        },
      ],
    );
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: logout },
    ]);
  };

  const PROVIDERS: { key: ModelProvider; name: string; icon: string; placeholder: string }[] = [
    { key: 'openai', name: 'OpenAI', icon: '🤖', placeholder: 'sk-...' },
    { key: 'anthropic', name: 'Anthropic', icon: '🧠', placeholder: 'sk-ant-...' },
    { key: 'google', name: 'Google AI', icon: '🔮', placeholder: 'AIza...' },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Agent Brain */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Agent Brain</Text>

          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <View>
                <Text style={styles.cardLabel}>Bring Your Own Keys</Text>
                <Text style={styles.cardDesc}>Use your own API keys for AI inference</Text>
              </View>
              <Switch
                value={byok}
                onValueChange={toggleByok}
                trackColor={{ false: colors.border, true: colors.primary + '60' }}
                thumbColor={byok ? colors.primary : colors.textTertiary}
              />
            </View>
          </View>

          {byok && (
            <>
              {/* Model Provider Selection */}
              <View style={styles.providerRow}>
                {PROVIDERS.map((p) => (
                  <TouchableOpacity
                    key={p.key}
                    style={[styles.providerCard, selectedProvider === p.key && styles.providerCardActive]}
                    onPress={() => selectProvider(p.key)}
                  >
                    <Text style={styles.providerIcon}>{p.icon}</Text>
                    <Text style={[
                      styles.providerName,
                      selectedProvider === p.key && styles.providerNameActive,
                    ]}>
                      {p.name}
                    </Text>
                    {apiKeys[p.key] ? (
                      <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                    ) : null}
                  </TouchableOpacity>
                ))}
              </View>

              {/* API Key Input */}
              <View style={styles.card}>
                <Text style={styles.cardLabel}>
                  {PROVIDERS.find((p) => p.key === selectedProvider)?.name} API Key
                </Text>
                <View style={styles.keyRow}>
                  <TextInput
                    style={styles.keyInput}
                    value={apiKeys[selectedProvider]}
                    onChangeText={(val) => setApiKeys((prev) => ({ ...prev, [selectedProvider]: val }))}
                    placeholder={PROVIDERS.find((p) => p.key === selectedProvider)?.placeholder}
                    placeholderTextColor={colors.textTertiary}
                    secureTextEntry={!showKeys}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <TouchableOpacity onPress={() => setShowKeys(!showKeys)}>
                    <Ionicons
                      name={showKeys ? 'eye-off' : 'eye'}
                      size={20}
                      color={colors.textTertiary}
                    />
                  </TouchableOpacity>
                </View>
                <View style={styles.keyActions}>
                  <TouchableOpacity
                    style={styles.testKeyButton}
                    onPress={() => testApiKey(selectedProvider)}
                    disabled={testingKey === selectedProvider}
                  >
                    {testingKey === selectedProvider ? (
                      <ActivityIndicator color={colors.warning} size="small" />
                    ) : (
                      <Text style={styles.testKeyText}>Test</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.saveKeyButton}
                    onPress={() => {
                      saveKey(selectedProvider, apiKeys[selectedProvider]);
                      Alert.alert('Saved', `${PROVIDERS.find((p) => p.key === selectedProvider)?.name} key saved securely`);
                    }}
                  >
                    <Text style={styles.saveKeyText}>Save Key</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </>
          )}

          {!byok && (
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Angel AI Hosting</Text>
              <Text style={styles.cardDesc}>
                $10/mo + usage credits. Coming soon.
              </Text>
            </View>
          )}
        </View>

        {/* Language */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Language</Text>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Owner Language</Text>
            <Text style={styles.cardDesc}>Angel will always respond to you in this language.</Text>
            <View style={styles.presetGrid}>
              {OWNER_LANGUAGES.map((lang) => (
                <TouchableOpacity
                  key={lang.code}
                  style={[
                    styles.presetChip,
                    ownerLanguage === lang.code && styles.presetChipActive,
                  ]}
                  onPress={() => saveOwnerLanguage(lang.code)}
                >
                  <Text style={styles.presetIcon}>{lang.flag}</Text>
                  <Text style={[
                    styles.presetLabel,
                    ownerLanguage === lang.code && styles.presetLabelActive,
                  ]} numberOfLines={1}>
                    {lang.code}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Voice Identity */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Voice Identity</Text>
          <VoiceEnrollment
            enrolled={voiceprintEnrolled}
            onEnrollmentChange={loadVoiceprintStatus}
          />
        </View>

        {/* Angel Voice */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Angel Voice</Text>
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Voice</Text>
            <Text style={styles.cardDesc}>Choose how Angel sounds when speaking whispers aloud.</Text>
            {voicesLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.sm }} />
            ) : voices.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: spacing.sm }}>
                <View style={styles.voiceRow}>
                  {voices.map((v) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[
                        styles.voiceChip,
                        selectedVoice === v.id && styles.voiceChipActive,
                      ]}
                      onPress={() => saveVoice(v.id)}
                    >
                      <View style={styles.voiceChipHeader}>
                        <Text style={[
                          styles.voiceName,
                          selectedVoice === v.id && styles.voiceNameActive,
                        ]} numberOfLines={1}>{v.name}</Text>
                        <TouchableOpacity
                          onPress={() => previewVoice(v.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          {playingVoiceId === v.id ? (
                            <ActivityIndicator size="small" color={colors.primary} />
                          ) : (
                            <Ionicons name="play-circle-outline" size={20} color={colors.primary} />
                          )}
                        </TouchableOpacity>
                      </View>
                      <Text style={styles.voiceDesc} numberOfLines={1}>{v.language}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            ) : (
              <Text style={[styles.cardDesc, { marginTop: spacing.sm }]}>
                No voices available. Voice output will use the default voice.
              </Text>
            )}
          </View>
        </View>

        {/* Audio Device */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Audio Device</Text>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Microphone Input</Text>
            <Text style={styles.cardDesc}>Where Angel listens from.</Text>
            <View style={styles.presetGrid}>
              {([
                { key: 'auto' as const, label: 'Auto', icon: 'swap-horizontal-outline' },
                { key: 'phone' as const, label: 'Phone Mic', icon: 'phone-portrait-outline' },
                { key: 'bluetooth' as const, label: 'Bluetooth', icon: 'bluetooth-outline' },
              ]).map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  style={[
                    styles.presetChip,
                    micSource === opt.key && styles.presetChipActive,
                  ]}
                  onPress={() => saveMicSource(opt.key)}
                >
                  <Ionicons
                    name={opt.icon as any}
                    size={14}
                    color={micSource === opt.key ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[
                    styles.presetLabel,
                    micSource === opt.key && styles.presetLabelActive,
                  ]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Audio Output</Text>
            <Text style={styles.cardDesc}>Where Angel speaks to you.</Text>
            <View style={styles.presetGrid}>
              {([
                { key: 'auto' as const, label: 'Auto', icon: 'swap-horizontal-outline' },
                { key: 'bluetooth' as const, label: 'Bluetooth', icon: 'bluetooth-outline' },
                { key: 'speaker' as const, label: 'Speaker', icon: 'volume-high-outline' },
              ]).map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  style={[
                    styles.presetChip,
                    outputDevice === opt.key && styles.presetChipActive,
                  ]}
                  onPress={() => saveOutputDevice(opt.key)}
                >
                  <Ionicons
                    name={opt.icon as any}
                    size={14}
                    color={outputDevice === opt.key ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[
                    styles.presetLabel,
                    outputDevice === opt.key && styles.presetLabelActive,
                  ]}>{opt.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* Speech Recognition */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Speech Recognition</Text>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>English Accent</Text>
            <Text style={styles.cardDesc}>Choose the closest match for better accuracy</Text>
            <View style={styles.localeGrid}>
              {ENGLISH_LOCALES.map((loc) => (
                <TouchableOpacity
                  key={loc.code}
                  style={[
                    styles.localeChip,
                    speechLocale === loc.code && styles.localeChipActive,
                  ]}
                  onPress={() => saveSpeechLocale(loc.code)}
                >
                  <Text style={styles.localeFlag}>{loc.flag}</Text>
                  <Text style={[
                    styles.localeLabel,
                    speechLocale === loc.code && styles.localeLabelActive,
                  ]}>
                    {loc.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Keyword Boosting</Text>
            <Text style={styles.cardDesc}>
              Add words Angel often mishears, one per line. Improves recognition for names, jargon, etc.
            </Text>
            <TextInput
              style={styles.keywordsInput}
              value={keywordsText}
              onChangeText={setKeywordsText}
              placeholder={"kubernetes\nreact native\nJensen Huang"}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.saveKeyButton} onPress={saveKeywords}>
              <Text style={styles.saveKeyText}>Save Keywords</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Claude Code Bridge */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Claude Code Bridge</Text>
          <View style={styles.card}>
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>Connected Machines</Text>
                <Text style={styles.cardDesc}>
                  {workers.length === 0
                    ? 'No machines connected. Run the setup command on your dev machine.'
                    : `${workers.length} machine${workers.length > 1 ? 's' : ''} online`}
                </Text>
              </View>
              <TouchableOpacity
                onPress={loadWorkers}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="refresh-outline" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {workers.length > 0 && (
              <View style={{ marginTop: spacing.sm, gap: spacing.xs }}>
                {workers.map((w) => (
                  <View key={w.id} style={styles.workerRow}>
                    <Ionicons
                      name={w.busy ? 'hourglass-outline' : 'checkmark-circle'}
                      size={16}
                      color={w.busy ? colors.warning : colors.success}
                    />
                    <Text style={styles.workerName}>{w.name}</Text>
                    <Text style={styles.workerStatus}>{w.busy ? 'Busy' : 'Ready'}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>

          <TouchableOpacity
            style={styles.card}
            onPress={() => setShowSetup(!showSetup)}
            activeOpacity={0.7}
          >
            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardLabel}>
                  <Ionicons name="terminal-outline" size={15} color={colors.primary} />{' '}
                  Setup New Machine
                </Text>
                <Text style={styles.cardDesc}>Connect Claude Code on your Mac, PC, or server</Text>
              </View>
              <Ionicons
                name={showSetup ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={colors.textTertiary}
              />
            </View>
            {showSetup && (
              <View style={{ marginTop: spacing.md }}>
                <Text style={[styles.cardDesc, { marginBottom: spacing.sm }]}>
                  Run this in your terminal on the machine you want to connect:
                </Text>
                <View style={{
                  backgroundColor: colors.bg,
                  borderRadius: 8,
                  padding: spacing.sm,
                  borderWidth: 1,
                  borderColor: colors.border,
                }}>
                  <Text style={{ color: colors.primary, fontSize: 11, fontFamily: 'monospace' }} numberOfLines={3}>
                    bash {'<'}(curl -fsSL https://raw.githubusercontent.com/articfoxy/angel-ai-v2/main/packages/worker/setup.sh) --token YOUR_TOKEN
                  </Text>
                </View>
                <TouchableOpacity
                  style={[styles.saveKeyButton, { marginTop: spacing.sm, alignSelf: 'flex-start' }]}
                  onPress={copySetupCommand}
                >
                  <Text style={styles.saveKeyText}>
                    {copiedToken ? '✓ Copied with your token!' : 'Copy Command (with token)'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </TouchableOpacity>
        </View>

        {/* Account */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.card}>
            <View style={styles.accountRow}>
              <Ionicons name="person" size={20} color={colors.primary} />
              <View style={styles.accountInfo}>
                <Text style={styles.accountName}>{user?.name || 'Angel User'}</Text>
                <Text style={styles.accountEmail}>{user?.email || ''}</Text>
              </View>
            </View>
          </View>

          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <Ionicons name="log-out-outline" size={20} color={colors.danger} />
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        {/* Legal */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Legal</Text>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://angelai.app/privacy')}
          >
            <Ionicons name="shield-checkmark-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.linkText}>Privacy Policy</Text>
            <Ionicons name="open-outline" size={14} color={colors.textTertiary} />
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL('https://angelai.app/terms')}
          >
            <Ionicons name="document-text-outline" size={18} color={colors.textSecondary} />
            <Text style={styles.linkText}>Terms of Service</Text>
            <Ionicons name="open-outline" size={14} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>

        {/* Danger Zone */}
        <View style={styles.section}>
          <TouchableOpacity style={styles.deleteAccountButton} onPress={handleDeleteAccount}>
            <Ionicons name="trash-outline" size={18} color={colors.danger} />
            <Text style={styles.deleteAccountText}>Delete Account</Text>
          </TouchableOpacity>
        </View>

        {/* App Info */}
        <View style={styles.section}>
          <Text style={styles.versionText}>
            Angel AI v{version}{buildNumber ? ` (${buildNumber})` : ''}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  title: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '700' },
  content: { paddingBottom: spacing.xl },
  section: { marginBottom: spacing.lg },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', marginBottom: spacing.xs },
  cardDesc: { color: colors.textSecondary, fontSize: fontSize.sm },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  providerRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  providerCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  providerCardActive: { borderColor: colors.primary, backgroundColor: colors.surfaceHover },
  providerIcon: { fontSize: 20 },
  providerName: { color: colors.textTertiary, fontSize: fontSize.xs, fontWeight: '600' },
  providerNameActive: { color: colors.primary },
  keyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  keyInput: {
    flex: 1,
    backgroundColor: colors.surfaceHover,
    borderRadius: 8,
    padding: spacing.sm,
    color: colors.text,
    fontSize: fontSize.md,
  },
  keyActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  testKeyButton: {
    backgroundColor: colors.warning + '20',
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    minWidth: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  testKeyText: { color: colors.warning, fontSize: fontSize.sm, fontWeight: '600' },
  saveKeyButton: {
    backgroundColor: colors.primary + '20',
    borderRadius: 8,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  saveKeyText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: '600' },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  accountInfo: { flex: 1 },
  accountName: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600' },
  accountEmail: { color: colors.textSecondary, fontSize: fontSize.sm },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger + '30',
  },
  logoutText: { color: colors.danger, fontSize: fontSize.md, fontWeight: '600' },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  linkText: { color: colors.text, fontSize: fontSize.md, flex: 1 },
  deleteAccountButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.danger + '10',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.danger + '30',
  },
  deleteAccountText: { color: colors.danger, fontSize: fontSize.md, fontWeight: '600' },
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
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  presetIcon: { fontSize: 14 },
  presetLabel: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600', flexShrink: 1 },
  presetLabelActive: { color: colors.primary },
  localeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  localeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    borderRadius: 20,
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.border,
  },
  localeChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
  },
  localeFlag: { fontSize: 14 },
  localeLabel: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' },
  localeLabelActive: { color: colors.primary },
  keywordsInput: {
    backgroundColor: colors.surfaceHover,
    borderRadius: 8,
    padding: spacing.sm,
    color: colors.text,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  voiceRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  voiceChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 12,
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.border,
    minWidth: 120,
  },
  voiceChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
    transform: [{ scale: 1.03 }],
  },
  voiceChipHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  voiceName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  voiceNameActive: {
    color: colors.primary,
  },
  voiceDesc: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 2,
  },
  workerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  workerName: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '600',
    flex: 1,
  },
  workerStatus: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  versionText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
