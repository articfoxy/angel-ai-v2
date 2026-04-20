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
import { colors, spacing, fontSize, fontFamily, radius } from '../theme';
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
    <LinearGradient colors={[colors.bg, '#1A1208', colors.bg]} style={styles.gradientBg}>
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <StatusBar style="light" />
        <View style={styles.content}>
          <View style={styles.header}>
            <LinearGradient colors={[colors.primary, '#B85A3D']} style={styles.logoContainer}>
              <Text style={styles.logoIcon}>✦</Text>
            </LinearGradient>
            <Text style={styles.title}>Angel</Text>
            <Text style={styles.subtitle}>
              {isRegister ? 'A companion you can keep.' : 'Welcome back.'}
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

            <TouchableOpacity onPress={handleSubmit} disabled={isLoading} activeOpacity={0.85}>
              <LinearGradient
                colors={[colors.primary, '#C46749']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={[styles.button, isLoading && styles.buttonDisabled]}
              >
                {isLoading ? (
                  <ActivityIndicator color="#1b130d" />
                ) : (
                  <Text style={styles.buttonText}>
                    {isRegister ? 'Create account' : 'Sign in'}
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
  header: { alignItems: 'center', marginBottom: spacing.xl + 8 },
  logoContainer: {
    width: 76, height: 76, borderRadius: radius.xl,
    alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg,
  },
  logoIcon: { fontSize: 34, color: '#1b130d' },
  // Serif hero + calm subtitle — sets the tone before anything else loads.
  title: {
    fontSize: 46,
    fontFamily: fontFamily.serif,
    fontWeight: '500',
    color: colors.text,
    letterSpacing: -0.8,
    marginBottom: spacing.xs + 2,
  },
  subtitle: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    fontFamily: fontFamily.serif,
    fontStyle: 'italic',
    letterSpacing: -0.1,
  },
  form: { gap: spacing.md },
  appleButton: { height: 52, width: '100%' },
  divider: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.borderSubtle },
  dividerText: { color: colors.textTertiary, fontSize: fontSize.xs, fontWeight: '500', letterSpacing: 0.3, textTransform: 'lowercase' },
  inputContainer: { gap: spacing.xs + 2 },
  inputLabel: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md + 2,
    color: colors.text, fontSize: fontSize.md + 1, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  error: { color: colors.danger, fontSize: fontSize.sm, textAlign: 'center' },
  button: {
    borderRadius: radius.md, padding: spacing.md, alignItems: 'center',
    justifyContent: 'center', height: 54, marginTop: spacing.sm + 2,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#1b130d', fontSize: fontSize.md + 1, fontWeight: '700', letterSpacing: 0.2 },
  toggleButton: { alignItems: 'center', paddingVertical: spacing.md },
  toggleText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: '500', letterSpacing: 0.1 },
});
