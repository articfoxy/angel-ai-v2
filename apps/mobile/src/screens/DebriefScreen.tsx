import React, { useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useApi } from '../hooks/useApi';
import { colors, spacing, fontSize, fontFamily } from '../theme';
import type { Session, Episode } from '../types';

interface StructuredSummary {
  summary?: string;
  decisions?: string[];
  actionItems?: string[];
  topics?: string[];
}

function parseSummary(raw: unknown): { text: string; structured: StructuredSummary | null } {
  if (!raw) return { text: '', structured: null };
  if (typeof raw === 'string') return { text: raw, structured: null };
  if (typeof raw === 'object') {
    const obj = raw as StructuredSummary;
    return {
      text: obj.summary || '',
      structured: obj,
    };
  }
  return { text: String(raw), structured: null };
}

function formatDuration(startedAt?: string, endedAt?: string | null): string | null {
  if (!startedAt || !endedAt) return null;
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms <= 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function DebriefScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<any>();
  const sessionId = route.params?.sessionId;

  const { data: session, isLoading, error } = useApi<Session>(`sessions/${sessionId}`);

  const { text: summaryText, structured } = useMemo(
    () => parseSummary(session?.summary),
    [session?.summary],
  );

  const duration = useMemo(
    () => formatDuration(session?.startedAt, session?.endedAt),
    [session?.startedAt, session?.endedAt],
  );

  const isProcessing = session?.status === 'processing';
  const isComplete = session?.status === 'ended' || session?.status === 'complete';

  const speakers: Record<string, string> = (session?.speakers as Record<string, string>) || {};

  const speakerName = (key: string): string => speakers[key] || key;

  // --- Loading state ---
  if (isLoading) {
    return (
      <View style={[styles.container, styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading session...</Text>
      </View>
    );
  }

  // --- Error state ---
  if (error) {
    return (
      <View style={[styles.container, styles.centered, { paddingTop: insets.top }]}>
        <Ionicons name="alert-circle" size={48} color={colors.danger} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backButton}>
          <Text style={styles.backButtonText}>Go Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="close" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Session Debrief</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* Status & Duration row */}
        <View style={styles.metaRow}>
          <View
            style={[
              styles.badge,
              { backgroundColor: isProcessing ? colors.warning + '22' : colors.success + '22' },
            ]}
          >
            {isProcessing && (
              <ActivityIndicator size="small" color={colors.warning} style={{ marginRight: 6 }} />
            )}
            <View
              style={[
                styles.badgeDot,
                { backgroundColor: isProcessing ? colors.warning : colors.success },
              ]}
            />
            <Text
              style={[
                styles.badgeText,
                { color: isProcessing ? colors.warning : colors.success },
              ]}
            >
              {isProcessing ? 'Processing' : isComplete ? 'Complete' : session?.status || 'Unknown'}
            </Text>
          </View>

          {duration && (
            <View style={styles.durationContainer}>
              <Ionicons name="time-outline" size={14} color={colors.textSecondary} />
              <Text style={styles.durationText}>{duration}</Text>
            </View>
          )}
        </View>

        {/* Processing banner */}
        {isProcessing && (
          <View style={styles.processingBanner}>
            <ActivityIndicator size="small" color={colors.warning} />
            <Text style={styles.processingText}>
              Your session is still being processed. Summary and insights will appear shortly.
            </Text>
          </View>
        )}

        {/* Summary card */}
        {summaryText ? (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="document-text-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Summary</Text>
            </View>
            <Text style={styles.cardText}>{summaryText}</Text>
          </View>
        ) : null}

        {/* Key Decisions */}
        {structured?.decisions && structured.decisions.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="checkmark-done-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Key Decisions</Text>
            </View>
            {structured.decisions.map((d, i) => (
              <View key={i} style={styles.bulletRow}>
                <Text style={styles.bullet}>{'\u2022'}</Text>
                <Text style={styles.bulletText}>{d}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Action Items */}
        {structured?.actionItems && structured.actionItems.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="list-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Action Items</Text>
            </View>
            {structured.actionItems.map((item, i) => (
              <View key={i} style={styles.checklistRow}>
                <Ionicons name="square-outline" size={16} color={colors.textSecondary} />
                <Text style={styles.checklistText}>{item}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Topics */}
        {structured?.topics && structured.topics.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="pricetags-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Topics Discussed</Text>
            </View>
            <View style={styles.tagsContainer}>
              {structured.topics.map((topic, i) => (
                <View key={i} style={styles.tag}>
                  <Text style={styles.tagText}>{topic}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Participants */}
        {Object.keys(speakers).length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="people-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Participants</Text>
            </View>
            {Object.entries(speakers).map(([id, name]) => (
              <View key={id} style={styles.speakerRow}>
                <View style={styles.speakerAvatar}>
                  <Ionicons name="person" size={14} color={colors.primary} />
                </View>
                <Text style={styles.speakerName}>{String(name)}</Text>
                <Text style={styles.speakerId}>{id}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Transcript */}
        {session?.episodes && session.episodes.length > 0 && (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Ionicons name="chatbubbles-outline" size={18} color={colors.primary} />
              <Text style={styles.cardTitle}>Transcript</Text>
              <Text style={styles.episodeCount}>{session.episodes.length} segments</Text>
            </View>
            <View style={styles.transcriptContainer}>
              {session.episodes.map((ep: Episode) => (
                <View key={ep.id} style={styles.transcriptRow}>
                  <View style={styles.transcriptMeta}>
                    <Text style={styles.transcriptSpeaker}>{speakerName(ep.speaker)}</Text>
                    <Text style={styles.transcriptTime}>{formatTimestamp(ep.startTime)}</Text>
                  </View>
                  <Text style={styles.transcriptContent}>{ep.content}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Spacer for bottom safe area */}
        <View style={{ height: insets.bottom + spacing.lg }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  centered: { justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: 26, fontFamily: fontFamily.serif, fontWeight: '500', letterSpacing: -0.3 },
  content: { paddingBottom: spacing.xl },

  // Loading / Error
  loadingText: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: spacing.md },
  errorText: {
    color: colors.danger,
    fontSize: fontSize.md,
    marginTop: spacing.md,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  backButton: {
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: 8,
  },
  backButtonText: { color: colors.text, fontSize: fontSize.md },

  // Meta row
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  badgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  badgeText: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  durationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  durationText: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
  },

  // Processing banner
  processingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warning + '15',
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.warning + '33',
    gap: spacing.sm,
  },
  processingText: {
    color: colors.warning,
    fontSize: fontSize.sm,
    flex: 1,
    lineHeight: 18,
  },

  // Cards
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    flex: 1,
  },
  cardText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
  },

  // Bullet list (decisions)
  bulletRow: {
    flexDirection: 'row',
    paddingVertical: 3,
    paddingRight: spacing.sm,
  },
  bullet: {
    color: colors.primary,
    fontSize: fontSize.md,
    marginRight: spacing.sm,
    lineHeight: 22,
  },
  bulletText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
    flex: 1,
  },

  // Checklist (action items)
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 4,
  },
  checklistText: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 22,
    flex: 1,
  },

  // Tags (topics)
  tagsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  tag: {
    backgroundColor: colors.primary + '22',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  tagText: {
    color: colors.primaryHover,
    fontSize: fontSize.sm,
    fontWeight: '500',
  },

  // Speakers
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  speakerAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.primary + '22',
    alignItems: 'center',
    justifyContent: 'center',
  },
  speakerName: { color: colors.text, fontSize: fontSize.md, flex: 1 },
  speakerId: { color: colors.textTertiary, fontSize: fontSize.xs },

  // Transcript
  episodeCount: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
  },
  transcriptContainer: {
    gap: spacing.sm,
  },
  transcriptRow: {
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  transcriptMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  transcriptSpeaker: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  transcriptTime: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
  },
  transcriptContent: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
});
