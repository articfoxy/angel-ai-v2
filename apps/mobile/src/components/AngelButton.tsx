import React, { useEffect } from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
} from 'react-native-reanimated';
import { colors, spacing, fontSize } from '../theme';

interface AngelButtonProps {
  onPress: () => void;
  isActive: boolean;
}

export function AngelButton({ onPress, isActive }: AngelButtonProps) {
  const pulseScale = useSharedValue(1);
  const pulseOpacity = useSharedValue(0.6);

  useEffect(() => {
    if (isActive) {
      pulseScale.value = withRepeat(
        withTiming(1.3, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
      pulseOpacity.value = withRepeat(
        withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
    } else {
      pulseScale.value = withTiming(1, { duration: 300 });
      pulseOpacity.value = withTiming(0.6, { duration: 300 });
    }
  }, [isActive]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
    opacity: pulseOpacity.value,
  }));

  return (
    <View style={styles.container}>
      {isActive && (
        <Animated.View style={[styles.pulseRing, pulseStyle]}>
          <LinearGradient
            colors={['#6366f1', '#8b5cf6']}
            style={styles.pulseGradient}
          />
        </Animated.View>
      )}
      <TouchableOpacity onPress={onPress} activeOpacity={0.8}>
        <LinearGradient
          colors={isActive ? ['#22c55e', '#16a34a'] : ['#6366f1', '#8b5cf6']}
          style={styles.button}
        >
          <Text style={styles.icon}>✦</Text>
        </LinearGradient>
      </TouchableOpacity>
      <Text style={styles.label}>
        {isActive ? 'Tap to Stop' : 'Come Alive'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    overflow: 'hidden',
  },
  pulseGradient: {
    width: '100%',
    height: '100%',
    borderRadius: 80,
  },
  button: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6366f1',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 10,
  },
  icon: {
    fontSize: 52,
    color: colors.text,
  },
  label: {
    marginTop: spacing.md,
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
});
