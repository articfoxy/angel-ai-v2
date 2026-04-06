import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as AppleAuthentication from 'expo-apple-authentication';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, spacing, fontSize } from '../theme';
import { useAuth } from '../hooks/useAuth';

export function LoginScreen() {
  const { login, register, loginWithApple } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAuthAvailable, setAppleAuthAvailable] = useState(false);

  useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAppleAuthAvailable);
  }, []);

  const handleSubmit = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter email and password');
      return;
    }
    if (isRegister && !name.trim()) {
      setError('Please enter your name');
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      if (isRegister) {
        await register(email.trim(), password, name.trim());
      } else {
        await login(email.trim(), password);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      Alert.alert('Error', message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAppleLogin = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!credential.identityToken) throw new Error('No identity token received from Apple');
      await loginWithApple(credential.identityToken, credential.fullName);
    } catch (err: any) {
      if (err.code === 'ERR_REQUEST_CANCELED') return;
      const message = err instanceof Error ? err.message : 'Apple sign-in failed';
      setError(message);
      Alert.alert('Error', message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <LinearGradient colors={['#050507', '#0d0d14', '#050507']} style={styles.gradientBg}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <StatusBar style="light" />
        <View style={styles.content}>
          <View style={styles.header}>
            <LinearGradient colors={['#6366f1', '#8b5cf6']} style={styles.logoContainer}>
              <Text style={styles.logoIcon}>✦</Text>
            </LinearGradient>
            <Text style={styles.title}>Angel AI</Text>
            <Text style={styles.subtitle}>
              {isRegister ? 'Create your account' : 'Welcome back'}
            </Text>
          </View>

          <View style={styles.form}>
            {appleAuthAvailable && (
              <AppleAuthentication.AppleAuthenticationButton
                buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
                cornerRadius={12}
                style={styles.appleButton}
                onPress={handleAppleLogin}
              />
            )}

            {appleAuthAvailable && (
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>or continue with email</Text>
                <View style={styles.dividerLine} />
              </View>
            )}

            {isRegister && (
              <View style={styles.inputContainer}>
                <Text style={styles.inputLabel}>Name</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Your name"
                  placeholderTextColor={colors.textTertiary}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="words"
                  autoComplete="name"
                />
              </View>
            )}

            <View style={styles.inputContainer}>
              <Text style={styles.inputLabel}>Email</Text>
              <TextInput
                style={styles.input}
                placeholder="you@example.com"
                placeholderTextColor={colors.textTertiary}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
              />
            </View>

            <View style={styles.inputContainer}>
              <Text style={styles.inputLabel}>Password</Text>
              <TextInput
                style={styles.input}
                placeholder="••••••••"
                placeholderTextColor={colors.textTertiary}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
              />
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            <TouchableOpacity onPress={handleSubmit} disabled={isLoading} activeOpacity={0.8}>
              <LinearGradient
                colors={['#6366f1', '#8b5cf6']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.button, isLoading && styles.buttonDisabled]}
              >
                {isLoading ? (
                  <ActivityIndicator color={colors.text} />
                ) : (
                  <Text style={styles.buttonText}>
                    {isRegister ? 'Create Account' : 'Sign In'}
                  </Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.toggleButton}
              onPress={() => { setIsRegister(!isRegister); setError(null); }}
            >
              <Text style={styles.toggleText}>
                {isRegister ? 'Already have an account? Sign In' : "Don't have an account? Create one"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
      </TouchableWithoutFeedback>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradientBg: { flex: 1 },
  container: { flex: 1 },
  content: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  header: { alignItems: 'center', marginBottom: spacing.xl },
  logoContainer: {
    width: 72, height: 72, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.md,
  },
  logoIcon: { fontSize: 36, color: colors.text },
  title: { fontSize: fontSize.xxl, fontWeight: '700', color: colors.text, marginBottom: spacing.xs },
  subtitle: { fontSize: fontSize.lg, color: colors.textSecondary },
  form: { gap: spacing.md },
  appleButton: { height: 52, width: '100%' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dividerText: { color: colors.textTertiary, fontSize: fontSize.sm, fontWeight: '500' },
  inputContainer: { gap: spacing.xs },
  inputLabel: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: '600' },
  input: {
    backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md,
    color: colors.text, fontSize: fontSize.lg, borderWidth: 1, borderColor: colors.border,
  },
  error: { color: colors.danger, fontSize: fontSize.sm, textAlign: 'center' },
  button: {
    borderRadius: 12, padding: spacing.md, alignItems: 'center',
    justifyContent: 'center', height: 52, marginTop: spacing.sm,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.text, fontSize: fontSize.lg, fontWeight: '700' },
  toggleButton: { alignItems: 'center', paddingVertical: spacing.md },
  toggleText: { color: colors.primary, fontSize: fontSize.md, fontWeight: '500' },
});
