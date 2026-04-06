import React, { useRef, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
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

interface TranscriptViewProps {
  segments: TranscriptSegment[];
  speakerNames: Record<string, string>;
}

export function TranscriptView({ segments, speakerNames }: TranscriptViewProps) {
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [segments.length]);

  const getSpeakerLabel = (speaker?: string) => {
    if (!speaker) return 'Unknown';
    return speakerNames[speaker] || speaker;
  };

  const getSpeakerColor = (speaker?: string) => {
    const label = getSpeakerLabel(speaker);
    return SPEAKER_COLORS[label] || colors.primary;
  };

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {segments.map((segment) => (
        <View key={segment.id} style={styles.segment}>
          <View style={[styles.speakerDot, { backgroundColor: getSpeakerColor(segment.speaker) }]} />
          <View style={styles.segmentContent}>
            <Text style={[styles.speakerName, { color: getSpeakerColor(segment.speaker) }]}>
              {getSpeakerLabel(segment.speaker)}
            </Text>
            <Text style={[styles.text, !segment.isFinal && styles.textInterim]}>
              {segment.text}
            </Text>
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: spacing.md, paddingBottom: spacing.xl },
  segment: {
    flexDirection: 'row',
    marginBottom: spacing.sm,
    alignItems: 'flex-start',
  },
  speakerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    marginRight: spacing.sm,
  },
  segmentContent: { flex: 1 },
  speakerName: {
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  text: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 20,
  },
  textInterim: {
    color: colors.textTertiary,
    fontStyle: 'italic',
  },
});
