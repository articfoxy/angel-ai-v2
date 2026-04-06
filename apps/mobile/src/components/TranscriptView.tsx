import React, { useRef, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Alert, Clipboard } from 'react-native';
import type { TranscriptSegment } from '../types';
import { colors, spacing, fontSize } from '../theme';

const SPEAKER_COLORS: Record<string, string> = {
  Owner: '#6366f1',
  'Person A': '#22c55e',
  'Person B': '#f59e0b',
  'Person C': '#ef4444',
  'Person D': '#06b6d4',
  'Person E': '#ec4899',
};

interface SpeakerGroup {
  speaker: string;
  /** Concatenated final text for this speaker turn */
  finalText: string;
  /** Interim (not yet finalized) text appended live */
  interimText: string;
  /** Unique key for React rendering */
  key: string;
}

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

/**
 * Groups consecutive transcript segments by speaker and merges their text
 * into coherent paragraphs. When the same speaker has multiple consecutive
 * segments, they are joined into a single block instead of showing each
 * fragment separately. Interim (live) text is shown at the end of the
 * current speaker's turn.
 */
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
      // Same speaker — merge into existing group
      if (segment.isFinal) {
        // Append finalized text with proper spacing
        const trimmed = segment.text.trim();
        if (trimmed) {
          lastGroup.finalText = lastGroup.finalText
            ? `${lastGroup.finalText} ${trimmed}`
            : trimmed;
        }
        // Clear interim since we got a final version
        lastGroup.interimText = '';
      } else {
        // Update interim text (replaces previous interim for this group)
        lastGroup.interimText = segment.text.trim();
      }
    } else {
      // Different speaker — start a new group
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
    // Small delay to ensure layout is complete before scrolling
    const timer = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 50);
    return () => clearTimeout(timer);
  }, [groups.length, segments.length]);

  const getSpeakerColor = (label: string) => {
    return SPEAKER_COLORS[label] || colors.primary;
  };

  if (segments.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Listening...</Text>
        <Text style={styles.emptySubtext}>Start talking and the transcript will appear here</Text>
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
        const fullText = group.finalText + (group.interimText ? (group.finalText ? ' ' : '') + group.interimText : '');

        return (
          <View key={group.key} style={styles.group}>
            {/* Speaker header */}
            <View style={styles.speakerRow}>
              <View style={[styles.speakerDot, { backgroundColor: color }]} />
              <Text style={[styles.speakerName, { color }]}>
                {group.speaker}
              </Text>
            </View>

            {/* Merged transcript text */}
            <TouchableOpacity
              activeOpacity={0.7}
              onLongPress={() => {
                Clipboard.setString(fullText);
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
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl * 2,
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: fontSize.lg,
    fontWeight: '600',
  },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  group: {
    marginBottom: spacing.md,
  },
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  speakerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  speakerName: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  textContainer: {
    marginLeft: 8 + spacing.xs, // Align with text after dot
  },
  text: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 22,
  },
  textInterim: {
    color: colors.textTertiary,
    fontStyle: 'italic',
  },
});
