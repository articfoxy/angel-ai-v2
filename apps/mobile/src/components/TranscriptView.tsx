import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { TranscriptSegment, WhisperCardData } from '../types';
import { colors, spacing, fontSize, radius } from '../theme';

const SPEAKER_COLORS: Record<string, string> = {
  Owner: '#7c7fff',
  'Person A': '#34d399',
  'Person B': '#fbbf24',
  'Person C': '#f87171',
  'Person D': '#38bdf8',
  'Person E': '#f472b6',
};

/** Whisper type styling — matches WhisperCard.tsx */
const WHISPER_TYPE_CONFIG: Record<
  string,
  { icon: keyof typeof Ionicons.glyphMap; color: string; bg: string; label: string }
> = {
  definition: { icon: 'book-outline', color: '#a78bfa', bg: 'rgba(167, 139, 250, 0.12)', label: 'Definition' },
  response: { icon: 'chatbubble-outline', color: '#7c7fff', bg: 'rgba(124, 127, 255, 0.12)', label: 'Angel' },
  memory_saved: { icon: 'checkmark-circle-outline', color: '#34d399', bg: 'rgba(52, 211, 153, 0.12)', label: 'Saved' },
  search: { icon: 'search-outline', color: '#f472b6', bg: 'rgba(244, 114, 182, 0.12)', label: 'Search' },
  insight: { icon: 'bulb-outline', color: '#7c7fff', bg: 'rgba(124, 127, 255, 0.12)', label: 'Insight' },
  action: { icon: 'arrow-forward-circle-outline', color: '#34d399', bg: 'rgba(52, 211, 153, 0.12)', label: 'Action' },
  warning: { icon: 'warning-outline', color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.12)', label: 'Heads Up' },
  memory: { icon: 'bookmark-outline', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.12)', label: 'Remembered' },
  default: { icon: 'sparkles-outline', color: '#7c7fff', bg: 'rgba(124, 127, 255, 0.12)', label: 'Angel' },
};

interface SpeakerGroup {
  speaker: string;
  finalText: string;
  interimText: string;
  key: string;
  timestamp: number; // ms since epoch of last segment in this group
}

/** A unified timeline item — either a transcript group or an inline whisper */
type TimelineItem =
  | { kind: 'transcript'; group: SpeakerGroup }
  | { kind: 'whisper'; card: WhisperCardData };

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
  whisperCards?: WhisperCardData[];
}

function groupSegmentsBySpeaker(
  segments: TranscriptSegment[],
  speakerNames: Record<string, string>
): SpeakerGroup[] {
  const groups: SpeakerGroup[] = [];

  for (const segment of segments) {
    const speakerKey = segment.speaker || 'unknown';
    const label = speakerNames[speakerKey] || speakerKey;
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.speaker === label) {
      if (segment.isFinal) {
        const trimmed = segment.text.trim();
        if (trimmed) {
          lastGroup.finalText = lastGroup.finalText
            ? `${lastGroup.finalText} ${trimmed}`
            : trimmed;
        }
        lastGroup.interimText = '';
      } else {
        lastGroup.interimText = segment.text.trim();
      }
      lastGroup.timestamp = segment.timestamp;
    } else {
      const group: SpeakerGroup = {
        speaker: label,
        finalText: '',
        interimText: '',
        key: `group-${groups.length}-${speakerKey}`,
        timestamp: segment.timestamp,
      };
      if (segment.isFinal) {
        group.finalText = segment.text.trim();
      } else {
        group.interimText = segment.text.trim();
      }
      groups.push(group);
    }
  }

  return groups;
}

/** Merge transcript groups and whisper cards into a single chronological timeline */
function buildTimeline(groups: SpeakerGroup[], whisperCards: WhisperCardData[]): TimelineItem[] {
  // Sort whispers oldest-first for correct chronological insertion
  const sortedWhispers = [...whisperCards].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });

  // Two-pointer merge: both groups and sorted whispers are in chronological order
  const items: TimelineItem[] = [];
  let gi = 0;
  let wi = 0;

  while (gi < groups.length || wi < sortedWhispers.length) {
    const groupTime = gi < groups.length ? groups[gi].timestamp : Infinity;
    const whisperTime = wi < sortedWhispers.length
      ? (sortedWhispers[wi].createdAt ? new Date(sortedWhispers[wi].createdAt!).getTime() : Infinity)
      : Infinity;

    if (groupTime <= whisperTime) {
      items.push({ kind: 'transcript', group: groups[gi] });
      gi++;
    } else {
      items.push({ kind: 'whisper', card: sortedWhispers[wi] });
      wi++;
    }
  }

  return items;
}

export function TranscriptView({ segments, speakerNames, whisperCards }: TranscriptViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  const groups = useMemo(
    () => groupSegmentsBySpeaker(segments, speakerNames),
    [segments, speakerNames]
  );

  const timeline = useMemo(
    () => buildTimeline(groups, whisperCards || []),
    [groups, whisperCards]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 16);
    return () => clearTimeout(timer);
  }, [timeline.length]);

  const getSpeakerColor = (label: string) => {
    return SPEAKER_COLORS[label] || colors.primary;
  };

  if (segments.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <View style={styles.emptyIconWrap}>
          <Ionicons name="mic-outline" size={28} color={colors.textTertiary} />
        </View>
        <Text style={styles.emptyText}>Waiting for speech...</Text>
        <Text style={styles.emptySubtext}>
          Start talking and the live transcript{'\n'}will appear here
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {timeline.map((item) => {
        if (item.kind === 'whisper') {
          const config = WHISPER_TYPE_CONFIG[item.card.type] || WHISPER_TYPE_CONFIG.default;
          return (
            <TouchableOpacity
              key={`whisper-${item.card.id}`}
              style={[styles.inlineWhisper, { borderLeftColor: config.color }]}
              activeOpacity={0.8}
              onLongPress={async () => {
                const text = item.card.detail
                  ? `${item.card.content}\n${item.card.detail}`
                  : item.card.content;
                await Clipboard.setStringAsync(text);
                Alert.alert('Copied', 'Text copied to clipboard');
              }}
            >
              <View style={styles.whisperHeader}>
                <View style={[styles.whisperBadge, { backgroundColor: config.bg }]}>
                  <Ionicons name={config.icon} size={11} color={config.color} />
                  <Text style={[styles.whisperLabel, { color: config.color }]}>
                    {config.label}
                  </Text>
                </View>
              </View>
              <Text style={styles.whisperContent}>{item.card.content}</Text>
              {item.card.detail && (
                <Text style={styles.whisperDetail}>{item.card.detail}</Text>
              )}
            </TouchableOpacity>
          );
        }

        const { group } = item;
        const color = getSpeakerColor(group.speaker);
        const fullText =
          group.finalText +
          (group.interimText
            ? (group.finalText ? ' ' : '') + group.interimText
            : '');

        return (
          <View key={group.key} style={styles.group}>
            {/* Speaker pill */}
            <View style={styles.speakerRow}>
              <View style={[styles.speakerPill, { backgroundColor: color + '18' }]}>
                <View style={[styles.speakerDot, { backgroundColor: color }]} />
                <Text style={[styles.speakerName, { color }]}>
                  {group.speaker}
                </Text>
              </View>
            </View>

            {/* Transcript text */}
            <TouchableOpacity
              activeOpacity={0.7}
              onLongPress={async () => {
                await Clipboard.setStringAsync(fullText);
                Alert.alert('Copied', 'Text copied to clipboard');
              }}
              style={styles.textContainer}
            >
              {group.finalText ? (
                <Text style={styles.text}>
                  {group.finalText}
                  {group.interimText ? (
                    <Text style={styles.textInterim}> {group.interimText}</Text>
                  ) : null}
                </Text>
              ) : (
                <Text style={[styles.text, styles.textInterim]}>
                  {group.interimText}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xxl,
    gap: spacing.sm,
  },
  emptyIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  group: {
    marginBottom: spacing.lg,
  },
  speakerRow: {
    flexDirection: 'row',
    marginBottom: spacing.xs + 2,
  },
  speakerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 3,
    borderRadius: radius.full,
    gap: 5,
  },
  speakerDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  speakerName: {
    fontSize: fontSize.sm,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  textContainer: {
    paddingLeft: spacing.sm,
  },
  text: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 24,
    letterSpacing: 0.1,
  },
  textInterim: {
    color: colors.textTertiary,
    fontStyle: 'italic',
  },
  // Inline whisper styles
  inlineWhisper: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.sm,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.lg,
    marginLeft: spacing.xs,
  },
  whisperHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  whisperBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    gap: 3,
  },
  whisperLabel: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  whisperContent: {
    color: colors.text,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  whisperDetail: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    marginTop: 2,
    lineHeight: 17,
  },
});
