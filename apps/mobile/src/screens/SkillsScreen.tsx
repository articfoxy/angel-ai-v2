import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import { colors, spacing, fontSize, fontFamily } from '../theme';
import type { Skill } from '../types';

type SkillTab = 'my' | 'marketplace';

export function SkillsScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<SkillTab>('my');
  const [showCreate, setShowCreate] = useState(false);
  const [createPrompt, setCreatePrompt] = useState('');
  const [creating, setCreating] = useState(false);

  const { data: mySkills, isLoading: myLoading, refetch: refetchMy } =
    useApi<Skill[]>('skills/mine');
  const { data: publicSkills, isLoading: publicLoading, refetch: refetchPublic } =
    useApi<Skill[]>('skills/public');

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchMy(), refetchPublic()]);
    setRefreshing(false);
  }, [refetchMy, refetchPublic]);

  const handleCreateSkill = async () => {
    if (!createPrompt.trim()) return;
    setCreating(true);
    try {
      await api.post('skills', { description: createPrompt.trim() });
      setCreatePrompt('');
      setShowCreate(false);
      refetchMy();
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create skill');
    } finally {
      setCreating(false);
    }
  };

  const handleImportSkill = async (skillId: string) => {
    try {
      await api.post(`skills/${skillId}/import`);
      refetchMy();
      Alert.alert('Imported', 'Skill added to your collection');
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to import skill');
    }
  };

  const handleDeleteSkill = (skillId: string) => {
    Alert.alert('Delete Skill', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api.delete(`skills/${skillId}`);
          refetchMy();
        },
      },
    ]);
  };

  const renderSkillCard = (skill: Skill, showImport = false) => (
    <View key={skill.id} style={styles.skillCard}>
      <View style={styles.skillHeader}>
        <Ionicons name="flash" size={18} color={colors.primary} />
        <Text style={styles.skillName}>{skill.name}</Text>
        {showImport ? (
          <TouchableOpacity
            style={styles.importButton}
            onPress={() => handleImportSkill(skill.id)}
          >
            <Ionicons name="add-circle" size={20} color={colors.success} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={() => handleDeleteSkill(skill.id)}>
            <Ionicons name="trash-outline" size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>
      {skill.trigger && (
        <Text style={styles.skillTrigger}>"{skill.trigger}"</Text>
      )}
      <Text style={styles.skillPrompt} numberOfLines={3}>
        {skill.systemPrompt}
      </Text>
      <View style={styles.skillMeta}>
        <Text style={styles.skillVisibility}>{skill.visibility}</Text>
        {skill.downloads > 0 && (
          <Text style={styles.skillDownloads}>{skill.downloads} imports</Text>
        )}
      </View>
    </View>
  );

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Skills</Text>
        <Text style={styles.subtitle}>Teach Angel new abilities</Text>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'my' && styles.tabActive]}
          onPress={() => setActiveTab('my')}
        >
          <Text style={[styles.tabLabel, activeTab === 'my' && styles.tabLabelActive]}>
            My Skills
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'marketplace' && styles.tabActive]}
          onPress={() => setActiveTab('marketplace')}
        >
          <Text style={[styles.tabLabel, activeTab === 'marketplace' && styles.tabLabelActive]}>
            Marketplace
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {activeTab === 'my' && (
          <>
            {/* Create Skill */}
            {showCreate ? (
              <View style={styles.createCard}>
                <Text style={styles.createLabel}>Describe what you want Angel to do:</Text>
                <TextInput
                  style={styles.createInput}
                  value={createPrompt}
                  onChangeText={setCreatePrompt}
                  placeholder="e.g., Summarize sales calls and extract customer objections..."
                  placeholderTextColor={colors.textTertiary}
                  multiline
                  autoFocus
                />
                <View style={styles.createActions}>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => { setShowCreate(false); setCreatePrompt(''); }}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleCreateSkill} disabled={creating}>
                    <LinearGradient
                      colors={['#6366f1', '#8b5cf6']}
                      style={[styles.createButton, creating && { opacity: 0.6 }]}
                    >
                      {creating ? (
                        <ActivityIndicator color={colors.text} size="small" />
                      ) : (
                        <Text style={styles.createButtonText}>Create</Text>
                      )}
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity style={styles.addCard} onPress={() => setShowCreate(true)}>
                <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                <Text style={styles.addText}>Create New Skill</Text>
              </TouchableOpacity>
            )}

            {myLoading ? (
              <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
            ) : Array.isArray(mySkills) && mySkills.length > 0 ? (
              mySkills.map((skill) => renderSkillCard(skill))
            ) : (
              <View style={styles.emptyState}>
                <Ionicons name="flash-outline" size={32} color={colors.textTertiary} />
                <Text style={styles.emptyText}>No skills yet</Text>
                <Text style={styles.emptySubtext}>Create a skill or import from the marketplace</Text>
              </View>
            )}
          </>
        )}

        {activeTab === 'marketplace' && (
          publicLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : Array.isArray(publicSkills) && publicSkills.length > 0 ? (
            publicSkills.map((skill) => renderSkillCard(skill, true))
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="flash-outline" size={48} color={colors.primary + '60'} />
              <Text style={styles.emptyText}>Marketplace coming soon</Text>
              <Text style={styles.emptySubtext}>
                Create your own skills in the meantime!
              </Text>
              <TouchableOpacity
                style={styles.emptyAction}
                onPress={() => { setActiveTab('my'); setShowCreate(true); }}
              >
                <Ionicons name="add-circle-outline" size={18} color={colors.primary} />
                <Text style={styles.emptyActionText}>Create a Skill</Text>
              </TouchableOpacity>
            </View>
          )
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  title: { color: colors.text, fontSize: 30, fontFamily: fontFamily.serif, fontWeight: '500', letterSpacing: -0.4 },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: spacing.xs },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.surfaceHover, borderWidth: 1, borderColor: colors.primary + '40' },
  tabLabel: { color: colors.textTertiary, fontSize: fontSize.md, fontWeight: '600' },
  tabLabelActive: { color: colors.primary },
  content: { paddingBottom: spacing.xl },
  addCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary + '30',
    borderStyle: 'dashed',
  },
  addText: { color: colors.primary, fontSize: fontSize.md, fontWeight: '600' },
  createCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  createLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', marginBottom: spacing.sm },
  createInput: {
    color: colors.text,
    fontSize: fontSize.md,
    backgroundColor: colors.surfaceHover,
    borderRadius: 8,
    padding: spacing.sm,
    minHeight: 80,
    textAlignVertical: 'top',
    marginBottom: spacing.sm,
  },
  createActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  cancelButton: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md },
  cancelText: { color: colors.textTertiary, fontSize: fontSize.md },
  createButton: { borderRadius: 8, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg },
  createButtonText: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  skillCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  skillHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  skillName: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', flex: 1 },
  importButton: {},
  skillTrigger: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  skillPrompt: { color: colors.textSecondary, fontSize: fontSize.sm, lineHeight: 18, marginBottom: spacing.sm },
  skillMeta: { flexDirection: 'row', gap: spacing.sm },
  skillVisibility: {
    color: colors.textTertiary,
    fontSize: fontSize.xs,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  skillDownloads: { color: colors.textTertiary, fontSize: fontSize.xs },
  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xl * 2,
    gap: spacing.sm,
  },
  emptyText: { color: colors.textSecondary, fontSize: fontSize.lg, fontWeight: '600' },
  emptySubtext: {
    color: colors.textTertiary,
    fontSize: fontSize.md,
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
  },
  emptyAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.md,
    backgroundColor: colors.primary + '15',
    borderRadius: 10,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary + '30',
  },
  emptyActionText: { color: colors.primary, fontSize: fontSize.md, fontWeight: '600' },
});
