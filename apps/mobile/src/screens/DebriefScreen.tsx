import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useApi } from '../hooks/useApi';
import { colors, spacing, fontSize } from '../theme';
import type { Session } from '../types';

export function DebriefScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const route = useRoute<any>();
  const sessionId = route.params?.sessionId;

  const { data: session } = useApi<Session>(`sessions/${sessionId}`);

  const summaryText = session?.summary
    ? typeof session.summary === 'string'
      ? session.summary
      : JSON.stringify(session.summary, null, 2)
    : 'No summary available';

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Ionicons name="close" size={28} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Session Debrief</Text>
        <View style={{ width: 28 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Summary</Text>
          <Text style={styles.cardText}>{summaryText}</Text>
        </View>

        {session?.speakers && Object.keys(session.speakers).length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Participants</Text>
            {Object.entries(session.speakers).map(([id, name]) => (
              <View key={id} style={styles.speakerRow}>
                <Ionicons name="person" size={16} color={colors.primary} />
                <Text style={styles.speakerName}>{name}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.xl, fontWeight: '700' },
  content: { paddingBottom: spacing.xl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardTitle: {
    color: colors.text,
    fontSize: fontSize.lg,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  cardText: { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 22 },
  speakerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  speakerName: { color: colors.text, fontSize: fontSize.md },
});
