import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '../types';
import { colors, spacing, fontSize } from '../theme';

interface SessionCardProps {
  session: Session;
  onPress: () => void;
  onDelete?: () => void;
}

export function SessionCard({ session, onPress, onDelete }: SessionCardProps) {
  const formatDuration = () => {
    if (!session.endedAt || !session.startedAt) return '--';
    const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
    if (ms <= 0) return '--';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ${mins % 60}m`;
  };

  const speakerNames = session.speakers
    ? Object.values(session.speakers).filter((n) => n !== 'Owner')
    : [];

  const summaryText = session.summary
    ? typeof session.summary === 'string'
      ? session.summary
      : JSON.stringify(session.summary)
    : null;

  const handleLongPress = () => {
    if (!onDelete) return;
    Alert.alert('Delete Session?', 'This will permanently remove this session.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      onLongPress={handleLongPress}
      activeOpacity={0.7}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Ionicons name="mic" size={16} color={colors.primary} />
          <Text style={styles.date}>
            {new Date(session.startedAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </Text>
        </View>
        <View style={styles.durationRow}>
          <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
          <Text style={styles.duration}>{formatDuration()}</Text>
        </View>
      </View>

      {speakerNames.length > 0 && (
        <View style={styles.speakers}>
          <Ionicons name="people" size={12} color={colors.textTertiary} />
          <Text style={styles.speakerText}>
            {speakerNames.slice(0, 3).join(', ')}
            {speakerNames.length > 3 && ` +${speakerNames.length - 3}`}
          </Text>
        </View>
      )}

      {summaryText && (
        <Text style={styles.summary} numberOfLines={2}>
          {summaryText}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  date: {
    color: colors.text,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  durationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  duration: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    fontWeight: '600',
  },
  speakers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  speakerText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },
  summary: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    lineHeight: 18,
  },
});
