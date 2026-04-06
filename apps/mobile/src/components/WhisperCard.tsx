import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { WhisperCardData } from '../types';
import { colors, spacing, fontSize, radius, shadows } from '../theme';

interface WhisperCardProps {
  card: WhisperCardData;
}

const TYPE_CONFIG: Record<
  string,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; label: string }
> = {
  insight: { icon: 'bulb-outline', color: '#7c7fff', bg: colors.primaryMuted, label: 'Insight' },
  action: { icon: 'arrow-forward-circle-outline', color: '#34d399', bg: colors.successMuted, label: 'Action' },
  warning: { icon: 'warning-outline', color: '#fbbf24', bg: colors.warningMuted, label: 'Heads Up' },
  memory: { icon: 'bookmark-outline', color: '#38bdf8', bg: colors.infoMuted, label: 'Remembered' },
  default: { icon: 'sparkles-outline', color: '#7c7fff', bg: colors.primaryMuted, label: 'AI' },
};

export function WhisperCard({ card }: WhisperCardProps) {
  const config = TYPE_CONFIG[card.type] || TYPE_CONFIG.default;

  const handleCopy = async () => {
    const copyText = card.detail ? `${card.content}\n${card.detail}` : card.content;
    await Clipboard.setStringAsync(copyText);
    Alert.alert('Copied', 'Text copied to clipboard');
  };

  return (
    <TouchableOpacity
      style={styles.container}
      onLongPress={handleCopy}
      activeOpacity={0.85}
    >
      {/* Left accent bar */}
      <View style={[styles.accent, { backgroundColor: config.color }]} />

      <View style={styles.body}>
        {/* Header row */}
        <View style={styles.header}>
          <View style={[styles.typeBadge, { backgroundColor: config.bg }]}>
            <Ionicons name={config.icon} size={13} color={config.color} />
            <Text style={[styles.typeLabel, { color: config.color }]}>
              {config.label}
            </Text>
          </View>
        </View>

        {/* Content */}
        <Text style={styles.content}>{card.content}</Text>
        {card.detail && (
          <Text style={styles.detail}>{card.detail}</Text>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    ...shadows.sm,
  },
  accent: {
    width: 3,
  },
  body: {
    flex: 1,
    padding: spacing.md,
    paddingLeft: spacing.md - 3,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
    gap: 4,
  },
  typeLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  content: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  detail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    lineHeight: 19,
  },
});
