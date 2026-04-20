import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import { SessionCard } from '../components/SessionCard';
import { colors, spacing, fontSize, fontFamily } from '../theme';
import type { SessionsListResponse } from '../types';

export function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const [refreshing, setRefreshing] = useState(false);

  const {
    data: sessionsResponse,
    isLoading,
    refetch,
  } = useApi<SessionsListResponse>('sessions?limit=50');

  const sessions = sessionsResponse?.sessions;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>History</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {isLoading && !sessions ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xxl }} />
        ) : Array.isArray(sessions) && sessions.length > 0 ? (
          sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onPress={() => navigation.navigate('Debrief', { sessionId: session.id })}
              onDelete={async () => {
                try {
                  await api.delete(`sessions/${session.id}`);
                  refetch();
                } catch {
                  Alert.alert('Error', 'Failed to delete session.');
                }
              }}
            />
          ))
        ) : (
          <View style={styles.emptyState}>
            <Ionicons name="time-outline" size={40} color={colors.textTertiary} />
            <Text style={styles.emptyText}>No conversations yet</Text>
            <Text style={styles.emptySubtext}>Your session history will appear here</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md },
  title: { color: colors.text, fontSize: 30, fontFamily: fontFamily.serif, fontWeight: '500', letterSpacing: -0.4 },
  content: { paddingBottom: spacing.xxl },
  emptyState: { alignItems: 'center', paddingVertical: spacing.xxl * 2, gap: spacing.sm },
  emptyText: { color: colors.textSecondary, fontSize: fontSize.lg, fontWeight: '600' },
  emptySubtext: { color: colors.textTertiary, fontSize: fontSize.sm },
});
