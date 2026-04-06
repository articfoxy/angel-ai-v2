import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import type { WhisperCardData } from '../types';
import { colors, spacing, fontSize } from '../theme';

interface WhisperCardProps {
  card: WhisperCardData;
}

const TYPE_CONFIG: Record<string, { icon: keyof typeof Ionicons.glyphMap; gradient: [string, string] }> = {
  insight: { icon: 'bulb', gradient: ['#6366f1', '#8b5cf6'] },
  action: { icon: 'checkmark-circle', gradient: ['#22c55e', '#16a34a'] },
  warning: { icon: 'alert-circle', gradient: ['#f59e0b', '#d97706'] },
  memory: { icon: 'server', gradient: ['#06b6d4', '#0891b2'] },
  default: { icon: 'sparkles', gradient: ['#6366f1', '#8b5cf6'] },
};

export function WhisperCard({ card }: WhisperCardProps) {
  const config = TYPE_CONFIG[card.type] || TYPE_CONFIG.default;

  return (
    <View style={styles.container}>
      <LinearGradient
        colors={config.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.iconBadge}
      >
        <Ionicons name={config.icon} size={14} color={colors.text} />
      </LinearGradient>
      <View style={styles.content}>
        <Text style={styles.type}>{card.type.toUpperCase()}</Text>
        <Text style={styles.text}>{card.content}</Text>
        {card.detail && (
          <Text style={styles.detail}>{card.detail}</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 3,
  },
  iconBadge: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  content: { flex: 1 },
  type: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  text: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
  detail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    lineHeight: 16,
  },
});
