import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Session } from '../types';
import { colors, spacing, fontSize, radius } from '../theme';

interface SessionCardProps {
  session: Session;
  onPress: () => void;
  onDelete?: () => void;
}

export function SessionCard({ session, onPress, onDelete }: SessionCardProps) {
  const formatDuration = () => {
    if (!session.endedAt || !session.startedAt) return null;
    const ms = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
    if (ms <= 0) return null;
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

  const duration = formatDuration();

  const handleLongPress = () => {
    if (!onDelete) return;
    Alert.alert('Delete Session?', 'This will permanently remove this session and all its data.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  };

  const dateStr = new Date(session.startedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
  const timeStr = new Date(session.startedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      onLongPress={handleLongPress}
      activeOpacity={0.7}
    >
      <View style={styles.row}>
        {/* Left: date & time */}
        <View style={styles.left}>
          <Text style={styles.date}>{dateStr}</Text>
          <Text style={styles.time}>{timeStr}</Text>
        </View>

        {/* Center: summary & speakers */}
        <View style={styles.center}>
          {summaryText ? (
            <Text style={styles.summary} numberOfLines={2}>
              {summaryText}
            </Text>
          ) : (
            <Text style={styles.summaryPlaceholder}>Conversation</Text>
          )}

          {(speakerNames.length > 0 || duration) && (
            <View style={styles.meta}>
              {duration && (
                <View style={styles.metaChip}>
                  <Ionicons name="time-outline" size={11} color={colors.textTertiary} />
                  <Text style={styles.metaText}>{duration}</Text>
                </View>
              )}
              {speakerNames.length > 0 && (
                <View style={styles.metaChip}>
                  <Ionicons name="people-outline" size={11} color={colors.textTertiary} />
                  <Text style={styles.metaText}>
                    {speakerNames.slice(0, 2).join(', ')}
                    {speakerNames.length > 2 && ` +${speakerNames.length - 2}`}
                  </Text>
                </View>
              )}
            </View>
          )}
        </View>

        {/* Right: chevron */}
        <Ionicons name="chevron-forward" size={16} color={colors.textTertiary} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  left: {
    width: 52,
    marginRight: spacing.md,
  },
  date: {
    color: colors.text,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  time: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    marginTop: 1,
  },
  center: {
    flex: 1,
  },
  summary: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    lineHeight: 19,
  },
  summaryPlaceholder: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
  },
  meta: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaText: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
});
