import React, { useState } from 'react';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';
import { VoiceEnrollment } from '../components/VoiceEnrollment';
import { colors, spacing, fontSize } from '../theme';

const API_KEY_STORAGE = {
  openai: 'angel_v2_openai_key',
  anthropic: 'angel_v2_anthropic_key',
  google: 'angel_v2_google_key',
};

type ModelProvider = 'openai' | 'anthropic' | 'google';

const ANGEL_INSTRUCTION_PRESETS = [
  { id: 'jargon', label: 'Explain jargon & acronyms', icon: '📖' },
  { id: 'translate_zh', label: 'Translate Chinese to English', icon: '🇨🇳' },
  { id: 'translate_es', label: 'Translate Spanish to English', icon: '🇪🇸' },
  { id: 'meeting', label: 'Track action items & decisions', icon: '📋' },
  { id: 'coach', label: 'Coach my communication style', icon: '🎯' },
  { id: 'fact_check', label: 'Flag inaccuracies & contradictions', icon: '⚠️' },
  { id: 'sales', label: 'Help me close the deal', icon: '💰' },
  { id: 'learn', label: 'Help me learn & remember key points', icon: '🧠' },
];

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
type AudioRoute = 'auto' | 'speaker' | 'bluetooth';

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
  const [angelInstructions, setAngelInstructions] = useState('');
  const [activePresets, setActivePresets] = useState<string[]>([]);
  const [ownerLanguage, setOwnerLanguage] = useState('English');
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [audioRoute, setAudioRoute] = useState<AudioRoute>('auto');

  const version = Constants.expoConfig?.version || '2.0.0';
  const buildNumber = Constants.expoConfig?.ios?.buildNumber || '';

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

  const loadAudioRoute = React.useCallback(async () => {
    const saved = await SecureStore.getItemAsync('angel_v2_audio_route');
    if (saved === 'speaker' || saved === 'bluetooth') setAudioRoute(saved);
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
    loadAudioRoute();
    loadSelectedVoice();
  }, [loadVoiceprintStatus, loadVoices, loadAudioRoute, loadSelectedVoice]);

  const loadSpeechSettings = async () => {
    const locale = await SecureStore.getItemAsync('angel_v2_speech_locale');
    if (locale) setSpeechLocale(locale);
    const kw = await SecureStore.getItemAsync('angel_v2_speech_keywords');
    if (kw) setKeywordsText(kw);
    // Load Owner Language
    const savedOwnerLang = await SecureStore.getItemAsync('angel_v2_owner_language');
    if (savedOwnerLang) setOwnerLanguage(savedOwnerLang);
    // Load Angel Instructions
    const savedPresets = await SecureStore.getItemAsync('angel_v2_instruction_presets');
    if (savedPresets) {
      try {
        const parsed = JSON.parse(savedPresets);
        if (Array.isArray(parsed)) {
          setActivePresets(parsed);
        }
      } catch {}
    }
    const savedCustom = await SecureStore.getItemAsync('angel_v2_custom_instructions');
    if (savedCustom) setAngelInstructions(savedCustom);
  };

  const togglePreset = async (presetId: string) => {
    const updated = activePresets.includes(presetId)
      ? activePresets.filter(p => p !== presetId)
      : [...activePresets, presetId];
    setActivePresets(updated);
    await SecureStore.setItemAsync('angel_v2_instruction_presets', JSON.stringify(updated));
  };

  const saveCustomInstructions = async () => {
    await SecureStore.setItemAsync('angel_v2_custom_instructions', angelInstructions);
    Alert.alert('Saved', 'Angel will use these instructions in your next session.');
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

  const saveAudioRoute = async (route: AudioRoute) => {
    setAudioRoute(route);
    await SecureStore.setItemAsync('angel_v2_audio_route', route);
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

        {/* Angel Instructions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Angel Instructions</Text>
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
          <View style={styles.card}>
            <Text style={styles.cardLabel}>What should Angel help with?</Text>
            <Text style={styles.cardDesc}>Angel is always active — these instructions control when it speaks up.</Text>
            <View style={styles.presetGrid}>
              {ANGEL_INSTRUCTION_PRESETS.map((preset) => (
                <TouchableOpacity
                  key={preset.id}
                  style={[
                    styles.presetChip,
                    activePresets.includes(preset.id) && styles.presetChipActive,
                  ]}
                  onPress={() => togglePreset(preset.id)}
                >
                  <Text style={styles.presetIcon}>{preset.icon}</Text>
                  <Text style={[
                    styles.presetLabel,
                    activePresets.includes(preset.id) && styles.presetLabelActive,
                  ]} numberOfLines={1}>
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardLabel}>Custom Instructions</Text>
            <Text style={styles.cardDesc}>Add anything else you want Angel to do during conversations.</Text>
            <TextInput
              style={styles.keywordsInput}
              value={angelInstructions}
              onChangeText={setAngelInstructions}
              placeholder={"e.g. Remind me to follow up on pricing\nAlert me if anyone mentions deadlines"}
              placeholderTextColor={colors.textTertiary}
              multiline
              numberOfLines={4}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity style={styles.saveKeyButton} onPress={saveCustomInstructions}>
              <Text style={styles.saveKeyText}>Save Instructions</Text>
            </TouchableOpacity>
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
                      <Text style={[
                        styles.voiceName,
                        selectedVoice === v.id && styles.voiceNameActive,
                      ]} numberOfLines={1}>{v.name}</Text>
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
            <Text style={styles.cardLabel}>Microphone & Output</Text>
            <Text style={styles.cardDesc}>Choose where Angel listens and speaks.</Text>
            <View style={styles.presetGrid}>
              {([
                { key: 'auto' as const, label: 'Auto', icon: 'phone-portrait-outline' },
                { key: 'bluetooth' as const, label: 'AirPods / BT', icon: 'bluetooth-outline' },
                { key: 'speaker' as const, label: 'Speaker', icon: 'volume-high-outline' },
              ]).map((opt) => (
                <TouchableOpacity
                  key={opt.key}
                  style={[
                    styles.presetChip,
                    audioRoute === opt.key && styles.presetChipActive,
                  ]}
                  onPress={() => saveAudioRoute(opt.key)}
                >
                  <Ionicons
                    name={opt.icon as any}
                    size={14}
                    color={audioRoute === opt.key ? colors.primary : colors.textSecondary}
                  />
                  <Text style={[
                    styles.presetLabel,
                    audioRoute === opt.key && styles.presetLabelActive,
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
    minWidth: 100,
  },
  voiceChipActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryMuted,
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
  versionText: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
