import React, { useEffect } from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  withSpring,
  Easing,
  interpolateColor,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, fontSize, radius } from '../theme';

interface AngelButtonProps {
  onPress: () => void;
  isActive: boolean;
}

export function AngelButton({ onPress, isActive }: AngelButtonProps) {
  // Outer ring pulse
  const ringScale = useSharedValue(1);
  const ringOpacity = useSharedValue(0);

  // Second ring (staggered)
  const ring2Scale = useSharedValue(1);
  const ring2Opacity = useSharedValue(0);

  // Button glow
  const glowIntensity = useSharedValue(0);

  useEffect(() => {
    if (isActive) {
      // Ring 1
      ringScale.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 0 }),
          withTiming(1.6, { duration: 2000, easing: Easing.out(Easing.ease) })
        ),
        -1
      );
      ringOpacity.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 0 }),
          withTiming(0, { duration: 2000, easing: Easing.in(Easing.ease) })
        ),
        -1
      );
      // Ring 2 (offset)
      setTimeout(() => {
        ring2Scale.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 0 }),
            withTiming(1.6, { duration: 2000, easing: Easing.out(Easing.ease) })
          ),
          -1
        );
        ring2Opacity.value = withRepeat(
          withSequence(
            withTiming(0.4, { duration: 0 }),
            withTiming(0, { duration: 2000, easing: Easing.in(Easing.ease) })
          ),
          -1
        );
      }, 800);

      glowIntensity.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 1200, easing: Easing.inOut(Easing.ease) })
        ),
        -1
      );
    } else {
      ringScale.value = withTiming(1, { duration: 400 });
      ringOpacity.value = withTiming(0, { duration: 400 });
      ring2Scale.value = withTiming(1, { duration: 400 });
      ring2Opacity.value = withTiming(0, { duration: 400 });
      glowIntensity.value = withTiming(0, { duration: 400 });
    }
  }, [isActive]);

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
    opacity: ringOpacity.value,
  }));

  const ring2Style = useAnimatedStyle(() => ({
    transform: [{ scale: ring2Scale.value }],
    opacity: ring2Opacity.value,
  }));

  const glowStyle = useAnimatedStyle(() => ({
    shadowOpacity: 0.15 + glowIntensity.value * 0.4,
    shadowRadius: 20 + glowIntensity.value * 20,
  }));

  const SIZE = 120;
  const RING_SIZE = SIZE + 40;

  return (
    <View style={styles.container}>
      {/* Pulse rings */}
      <Animated.View
        style={[
          styles.ring,
          { width: RING_SIZE, height: RING_SIZE, borderRadius: RING_SIZE / 2 },
          ringStyle,
        ]}
      />
      <Animated.View
        style={[
          styles.ring,
          { width: RING_SIZE, height: RING_SIZE, borderRadius: RING_SIZE / 2 },
          ring2Style,
        ]}
      />

      {/* Main button */}
      <Animated.View
        style={[
          {
            shadowColor: isActive ? colors.success : colors.primary,
            shadowOffset: { width: 0, height: 0 },
            elevation: 8,
          },
          glowStyle,
        ]}
      >
        <TouchableOpacity onPress={onPress} activeOpacity={0.85}>
          <LinearGradient
            colors={
              isActive
                ? ['#34d399', '#059669']
                : ['#7c7fff', '#6366f1']
            }
            start={{ x: 0.2, y: 0 }}
            end={{ x: 0.8, y: 1 }}
            style={[styles.button, { width: SIZE, height: SIZE, borderRadius: SIZE / 2 }]}
          >
            <Ionicons
              name={isActive ? 'radio' : 'mic'}
              size={36}
              color="#fff"
            />
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>

      {/* Label */}
      <Text style={[styles.label, isActive && styles.labelActive]}>
        {isActive ? 'Listening...' : 'Start Session'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 200,
  },
  ring: {
    position: 'absolute',
    borderWidth: 1.5,
    borderColor: colors.success,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: spacing.md,
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
  labelActive: {
    color: colors.success,
    fontWeight: '600',
  },
});
