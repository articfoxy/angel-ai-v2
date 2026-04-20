import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { WhisperCardData } from '../types';
import { colors, spacing, fontSize, radius, shadows, fontFamily } from '../theme';

interface WhisperCardProps {
  card: WhisperCardData;
}

// Harmonized accent palette. Angel speaks in a single voice — we use our
// primary orange for most of what Angel says, with semantic tints only for
// meaningful state (saved, heads-up, action, remembered).
const TYPE_CONFIG: Record<
  string,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; label: string }
> = {
  definition:   { icon: 'book-outline',              color: colors.primary,   bg: colors.primaryMuted, label: 'Definition' },
  response:     { icon: 'chatbubble-outline',        color: colors.primary,   bg: colors.primaryMuted, label: 'Angel' },
  memory_saved: { icon: 'checkmark-circle-outline',  color: colors.success,   bg: colors.successMuted, label: 'Saved' },
  search:       { icon: 'search-outline',            color: colors.info,      bg: colors.infoMuted,    label: 'Search' },
  insight:      { icon: 'bulb-outline',              color: colors.primary,   bg: colors.primaryMuted, label: 'Insight' },
  action:       { icon: 'arrow-forward-circle-outline', color: colors.success, bg: colors.successMuted, label: 'Action' },
  warning:      { icon: 'warning-outline',           color: colors.warning,   bg: colors.warningMuted, label: 'Heads up' },
  memory:       { icon: 'bookmark-outline',          color: colors.info,      bg: colors.infoMuted,    label: 'Remembered' },
  pre_brief:    { icon: 'person-circle-outline',     color: colors.primary,   bg: colors.primaryMuted, label: 'Brief' },
  mode_switch:  { icon: 'swap-horizontal-outline',   color: colors.textSecondary, bg: colors.surfaceRaised, label: 'Intent' },
  default:      { icon: 'sparkles-outline',          color: colors.primary,   bg: colors.primaryMuted, label: 'Angel' },
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
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm + 2,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    ...shadows.sm,
  },
  accent: {
    width: 3,
    opacity: 0.85,
  },
  body: {
    flex: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.sm + 2,
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 4,
    borderRadius: radius.full,
    gap: 5,
  },
  typeLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  // Serif for whisper content — reads like a line from a journal, not a chat bubble.
  content: {
    color: colors.text,
    fontSize: fontSize.md + 1,
    fontFamily: fontFamily.serif,
    lineHeight: (fontSize.md + 1) * 1.5,
    letterSpacing: -0.1,
  },
  detail: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontFamily: fontFamily.sans,
    marginTop: spacing.xs + 2,
    lineHeight: fontSize.sm * 1.5,
  },
});
