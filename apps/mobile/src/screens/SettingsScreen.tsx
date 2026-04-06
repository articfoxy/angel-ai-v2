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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as SecureStore from 'expo-secure-store';
import { useAuth } from '../hooks/useAuth';
import { colors, spacing, fontSize } from '../theme';

const API_KEY_STORAGE = {
  openai: 'angel_v2_openai_key',
  anthropic: 'angel_v2_anthropic_key',
  google: 'angel_v2_google_key',
};

type ModelProvider = 'openai' | 'anthropic' | 'google';

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

  React.useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    const keys: Record<ModelProvider, string> = { openai: '', anthropic: '', google: '' };
    for (const [provider, storageKey] of Object.entries(API_KEY_STORAGE)) {
      const val = await SecureStore.getItemAsync(storageKey);
      if (val) keys[provider as ModelProvider] = val;
    }
    setApiKeys(keys);
  };

  const saveKey = async (provider: ModelProvider, key: string) => {
    if (key.trim()) {
      await SecureStore.setItemAsync(API_KEY_STORAGE[provider], key.trim());
    } else {
      await SecureStore.deleteItemAsync(API_KEY_STORAGE[provider]);
    }
    setApiKeys((prev) => ({ ...prev, [provider]: key }));
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
                onValueChange={setByok}
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
                    onPress={() => setSelectedProvider(p.key)}
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

        {/* App Info */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About</Text>
          <View style={styles.card}>
            <Text style={styles.cardDesc}>Angel AI v2.0.0</Text>
          </View>
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
  saveKeyButton: {
    alignSelf: 'flex-end',
    marginTop: spacing.sm,
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
});
