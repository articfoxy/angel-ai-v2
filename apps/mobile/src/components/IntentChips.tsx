/**
 * IntentChips — horizontal row of active behavioral intents.
 *
 * Replaces the hard mode selector. Each chip shows what Angel is currently
 * tracking (e.g. "Translating Chinese · 24m left"), tap to dismiss.
 *
 * Intents arrive via the socket 'intents:update' event. Tapping calls
 * 'intents:dismiss' over the socket, which updates server state and
 * re-broadcasts the stack.
 */
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { colors, spacing, fontSize, radius } from '../theme';

export interface ActiveIntent {
  id?: string;
  kind: string;
  reason?: string;
  langs?: string[];
  expiresInMinutes?: number;
  expiresOn?: string;
  participantContext?: string;
  priority?: number;
  source: 'user_command' | 'auto_inferred' | 'calendar' | 'planner';
  startedAt: string;
}

interface Props {
  intents: ActiveIntent[];
  onDismiss: (id: string) => void;
}

const KIND_LABELS: Record<string, { label: string; icon: string; color?: string }> = {
  translate:       { label: 'Translating',     icon: 'language-outline' },
  jargon_explain:  { label: 'Decoding jargon', icon: 'book-outline' },
  meeting_mode:    { label: 'Meeting mode',    icon: 'people-outline' },
  meeting_prep:    { label: 'Prepping',        icon: 'briefcase-outline' },
  deep_work:       { label: 'Deep work',       icon: 'glasses-outline' },
  code_focus:      { label: 'Code focus',      icon: 'code-slash-outline' },
  fact_check:      { label: 'Fact-checking',   icon: 'shield-checkmark-outline' },
  coaching:        { label: 'Coaching',        icon: 'fitness-outline' },
  quiet:           { label: 'Quiet mode',      icon: 'moon-outline' },
  verbose:         { label: 'Verbose',         icon: 'volume-high-outline' },
};

function formatRemaining(intent: ActiveIntent): string | null {
  if (intent.expiresInMinutes) {
    const startMs = new Date(intent.startedAt).getTime();
    const endMs = startMs + intent.expiresInMinutes * 60_000;
    const msLeft = endMs - Date.now();
    if (msLeft <= 0) return null;
    const minsLeft = Math.round(msLeft / 60_000);
    if (minsLeft < 60) return `${minsLeft}m left`;
    const hrs = Math.floor(minsLeft / 60);
    const rem = minsLeft % 60;
    return rem ? `${hrs}h ${rem}m left` : `${hrs}h left`;
  }
  if (intent.expiresOn === 'meeting_ends') return 'until meeting ends';
  if (intent.expiresOn === 'today') return 'today';
  if (intent.expiresOn === 'user_says_stop') return 'until you stop';
  return null;
}

function chipLabel(intent: ActiveIntent): string {
  const base = KIND_LABELS[intent.kind]?.label ?? intent.kind;
  if (intent.kind === 'translate' && intent.langs?.length) {
    const targets = intent.langs.filter((l) => l.toLowerCase() !== 'english');
    if (targets.length > 0) return `${base} ${targets.join('+')}`;
  }
  if (intent.participantContext && intent.participantContext.length < 24) {
    return `${base}: ${intent.participantContext}`;
  }
  return base;
}

export const IntentChips: React.FC<Props> = ({ intents, onDismiss }) => {
  const visible = useMemo(
    () => intents.filter((i) => !!i && !!i.kind).slice(0, 8),
    [intents],
  );
  if (visible.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {visible.map((intent) => {
        const meta = KIND_LABELS[intent.kind] ?? { label: intent.kind, icon: 'sparkles-outline' };
        const remaining = formatRemaining(intent);
        const isPassive = intent.source === 'auto_inferred';
        return (
          <TouchableOpacity
            key={intent.id || `${intent.kind}-${intent.startedAt}`}
            style={[styles.chip, isPassive && styles.chipPassive]}
            activeOpacity={0.75}
            onPress={() => {
              if (!intent.id) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onDismiss(intent.id);
            }}
          >
            <Ionicons
              name={meta.icon as any}
              size={14}
              color={isPassive ? colors.textSecondary : colors.primary}
            />
            <Text
              style={[styles.label, isPassive && styles.labelPassive]}
              numberOfLines={1}
            >
              {chipLabel(intent)}
            </Text>
            {remaining && (
              <Text style={styles.remaining} numberOfLines={1}>· {remaining}</Text>
            )}
            <Ionicons name="close" size={12} color={colors.textSecondary} style={styles.close} />
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: {
    maxHeight: 44,
  },
  row: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs,
    gap: spacing.xs + 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: spacing.sm + 2,
    paddingRight: spacing.xs + 2,
    paddingVertical: 6,
    borderRadius: radius.full,
    backgroundColor: colors.primaryMuted,
    borderWidth: 1,
    borderColor: 'rgba(124, 127, 255, 0.35)',
    maxWidth: 240,
  },
  chipPassive: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
  },
  label: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    letterSpacing: -0.1,
    flexShrink: 1,
  },
  labelPassive: {
    color: colors.text,
    fontWeight: '600',
  },
  remaining: {
    color: colors.textSecondary,
    fontSize: fontSize.xs,
    fontWeight: '500',
    flexShrink: 0,
  },
  close: {
    marginLeft: 2,
    opacity: 0.6,
  },
});
