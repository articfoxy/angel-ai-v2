import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import type { TranscriptSegment } from '../types';
import { colors, spacing, fontSize, radius } from '../theme';

const SPEAKER_COLORS: Record<string, string> = {
  Owner: '#7c7fff',
  'Person A': '#34d399',
  'Person B': '#fbbf24',
  'Person C': '#f87171',
  'Person D': '#38bdf8',
  'Person E': '#f472b6',
};

interface SpeakerGroup {
  speaker: string;
  finalText: string;
  interimText: string;
  key: string;
}

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
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
    } else {
      const group: SpeakerGroup = {
        speaker: label,
        finalText: '',
        interimText: '',
        key: `group-${groups.length}-${speakerKey}`,
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

export function TranscriptView({ segments, speakerNames }: TranscriptViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  const groups = useMemo(
    () => groupSegmentsBySpeaker(segments, speakerNames),
    [segments, speakerNames]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 16);
    return () => clearTimeout(timer);
  }, [groups.length, segments.length]);

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
      {groups.map((group) => {
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
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
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
});
