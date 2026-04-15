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
import { useApi } from '../hooks/useApi';
import { api } from '../services/api';
import { colors, spacing, fontSize } from '../theme';
import type { CoreMemory, Entity, Memory, Reflection } from '../types';

type MemoryTab = 'core' | 'entities' | 'memories' | 'reflections';

export function MemoryScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<MemoryTab>('core');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const { data: coreMemory, isLoading: coreLoading, refetch: refetchCore } =
    useApi<CoreMemory>('memory/core');
  const { data: entities, isLoading: entitiesLoading, refetch: refetchEntities } =
    useApi<Entity[]>('memory/entities');
  const { data: memories, isLoading: memoriesLoading, refetch: refetchMemories } =
    useApi<Memory[]>('memory/memories?limit=50');
  const { data: reflections, isLoading: reflectionsLoading, refetch: refetchReflections } =
    useApi<Reflection[]>('memory/reflections');

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchCore(), refetchEntities(), refetchMemories(), refetchReflections()]);
    setRefreshing(false);
  }, [refetchCore, refetchEntities, refetchMemories, refetchReflections]);

  const handleSaveCoreField = async (field: string, value: string) => {
    await api.patch('memory/core', { [field]: value });
    refetchCore();
    setEditingField(null);
  };

  const renderCoreMemoryBlock = (label: string, field: string, value: string, icon: keyof typeof Ionicons.glyphMap) => {
    const isEditing = editingField === field;
    return (
      <View key={field} style={styles.coreBlock}>
        <View style={styles.coreBlockHeader}>
          <Ionicons name={icon} size={16} color={colors.primary} />
          <Text style={styles.coreBlockLabel}>{label}</Text>
          <TouchableOpacity
            onPress={() => {
              if (isEditing) {
                handleSaveCoreField(field, editValue);
              } else {
                setEditingField(field);
                setEditValue(value);
              }
            }}
          >
            <Ionicons
              name={isEditing ? 'checkmark' : 'create-outline'}
              size={18}
              color={isEditing ? colors.success : colors.textTertiary}
            />
          </TouchableOpacity>
        </View>
        {isEditing ? (
          <TextInput
            style={styles.coreInput}
            value={editValue}
            onChangeText={setEditValue}
            multiline
            autoFocus
            placeholderTextColor={colors.textTertiary}
            placeholder={`What does Angel know about your ${label.toLowerCase()}?`}
          />
        ) : (
          <Text style={styles.coreBlockText}>
            {value || `No ${label.toLowerCase()} recorded yet`}
          </Text>
        )}
      </View>
    );
  };

  const TABS: { key: MemoryTab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'core', label: 'Core', icon: 'heart' },
    { key: 'entities', label: 'Entities', icon: 'people' },
    { key: 'memories', label: 'Facts', icon: 'document-text' },
    { key: 'reflections', label: 'Insights', icon: 'sparkles' },
  ];

  const query = searchQuery.trim().toLowerCase();

  const filteredEntities = Array.isArray(entities)
    ? entities.filter((e) => !query || e.name.toLowerCase().includes(query) || e.aliases.some((a: string) => a.toLowerCase().includes(query)))
    : [];

  const filteredMemories = Array.isArray(memories)
    ? memories.filter((m) => !query || m.content.toLowerCase().includes(query) || (m.category && m.category.toLowerCase().includes(query)))
    : [];

  const filteredReflections = Array.isArray(reflections)
    ? reflections.filter((r) => !query || r.content.toLowerCase().includes(query))
    : [];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Memory</Text>
        <Text style={styles.subtitle}>What Angel knows about your world</Text>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <Ionicons name="search" size={16} color={colors.textTertiary} />
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search memories..."
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
          </TouchableOpacity>
        )}
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Ionicons
              name={tab.icon}
              size={16}
              color={activeTab === tab.key ? colors.primary : colors.textTertiary}
            />
            <Text style={[styles.tabLabel, activeTab === tab.key && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
      >
        {activeTab === 'core' && (
          coreLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : (
            <View style={styles.coreSection}>
              {renderCoreMemoryBlock('User Profile', 'userProfile', coreMemory?.userProfile || '', 'person')}
              {renderCoreMemoryBlock('Preferences', 'preferences', coreMemory?.preferences || '', 'options')}
              {renderCoreMemoryBlock('Key People', 'keyPeople', coreMemory?.keyPeople || '', 'people')}
              {renderCoreMemoryBlock('Active Goals', 'activeGoals', coreMemory?.activeGoals || '', 'flag')}
            </View>
          )
        )}

        {activeTab === 'entities' && (
          entitiesLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : filteredEntities.length > 0 ? (
            filteredEntities.map((entity) => (
              <View key={entity.id} style={styles.entityCard}>
                <View style={styles.entityHeader}>
                  <Ionicons
                    name={entity.type === 'person' ? 'person' : entity.type === 'org' ? 'business' : 'pricetag'}
                    size={16}
                    color={colors.primary}
                  />
                  <Text style={styles.entityName}>{entity.name}</Text>
                  <Text style={styles.entityType}>{entity.type}</Text>
                </View>
                {entity.aliases.length > 0 && (
                  <Text style={styles.entityAliases}>
                    Also known as: {entity.aliases.join(', ')}
                  </Text>
                )}
              </View>
            ))
          ) : query ? (
            <View style={styles.emptyState}>
              <Ionicons name="search-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No results</Text>
              <Text style={styles.emptySubtext}>No entities match "{searchQuery}"</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="people-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No entities yet</Text>
              <Text style={styles.emptySubtext}>Angel will learn about people and topics from your conversations</Text>
            </View>
          )
        )}

        {activeTab === 'memories' && (
          memoriesLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : filteredMemories.length > 0 ? (
            filteredMemories.map((memory) => (
              <View key={memory.id} style={styles.memoryCard}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
                  <Text style={[styles.memoryContent, { flex: 1 }]}>{memory.content}</Text>
                  <TouchableOpacity
                    onPress={() => {
                      Alert.alert('Delete Memory', 'Remove this memory?', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete', style: 'destructive',
                          onPress: async () => {
                            try { await api.delete(`memory/memories/${memory.id}`); refetchMemories(); } catch {}
                          },
                        },
                      ]);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="trash-outline" size={16} color={colors.textTertiary} />
                  </TouchableOpacity>
                </View>
                <View style={styles.memoryMeta}>
                  {memory.category && (
                    <View style={styles.memoryBadge}>
                      <Text style={styles.memoryBadgeText}>{memory.category}</Text>
                    </View>
                  )}
                  <Text style={styles.memoryImportance}>
                    Importance: {memory.importance}/10
                  </Text>
                </View>
              </View>
            ))
          ) : query ? (
            <View style={styles.emptyState}>
              <Ionicons name="search-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No results</Text>
              <Text style={styles.emptySubtext}>No memories match "{searchQuery}"</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="document-text-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No memories yet</Text>
              <Text style={styles.emptySubtext}>Facts will be extracted from your conversations</Text>
            </View>
          )
        )}

        {activeTab === 'reflections' && (
          reflectionsLoading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: spacing.xl }} />
          ) : filteredReflections.length > 0 ? (
            filteredReflections.map((reflection) => (
              <View key={reflection.id} style={styles.reflectionCard}>
                <Ionicons name="sparkles" size={16} color={colors.warning} />
                <View style={styles.reflectionContent}>
                  <Text style={styles.reflectionText}>{reflection.content}</Text>
                  <Text style={styles.reflectionMeta}>
                    Based on {reflection.sourceMemories?.length || 0} memories
                  </Text>
                </View>
              </View>
            ))
          ) : query ? (
            <View style={styles.emptyState}>
              <Ionicons name="search-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No results</Text>
              <Text style={styles.emptySubtext}>No insights match "{searchQuery}"</Text>
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name="sparkles-outline" size={32} color={colors.textTertiary} />
              <Text style={styles.emptyText}>No insights yet</Text>
              <Text style={styles.emptySubtext}>Angel will generate insights after several conversations</Text>
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
  title: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '700' },
  subtitle: { color: colors.textSecondary, fontSize: fontSize.md, marginTop: spacing.xs },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.xs,
  },
  searchInput: {
    flex: 1,
    color: colors.text,
    fontSize: fontSize.md,
    paddingVertical: spacing.xs,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  tabActive: {
    backgroundColor: colors.surfaceHover,
    borderWidth: 1,
    borderColor: colors.primary + '40',
  },
  tabLabel: { color: colors.textTertiary, fontSize: fontSize.xs, fontWeight: '600' },
  tabLabelActive: { color: colors.primary },
  content: { paddingBottom: spacing.xl },
  coreSection: { paddingHorizontal: spacing.md, gap: spacing.sm },
  coreBlock: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  coreBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  coreBlockLabel: { color: colors.text, fontSize: fontSize.md, fontWeight: '600', flex: 1 },
  coreBlockText: { color: colors.textSecondary, fontSize: fontSize.md, lineHeight: 22 },
  coreInput: {
    color: colors.text,
    fontSize: fontSize.md,
    lineHeight: 22,
    backgroundColor: colors.surfaceHover,
    borderRadius: 8,
    padding: spacing.sm,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  entityCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  entityHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  entityName: { color: colors.text, fontSize: fontSize.lg, fontWeight: '600', flex: 1 },
  entityType: {
    color: colors.primary,
    fontSize: fontSize.xs,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  entityAliases: { color: colors.textTertiary, fontSize: fontSize.sm, marginTop: spacing.xs },
  memoryCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  memoryContent: { color: colors.text, fontSize: fontSize.md, lineHeight: 20, marginBottom: spacing.sm },
  memoryMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  memoryBadge: {
    backgroundColor: colors.primary + '20',
    borderRadius: 6,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  memoryBadgeText: { color: colors.primary, fontSize: fontSize.xs, fontWeight: '600' },
  memoryImportance: { color: colors.textTertiary, fontSize: fontSize.xs },
  reflectionCard: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  reflectionContent: { flex: 1 },
  reflectionText: { color: colors.text, fontSize: fontSize.md, lineHeight: 20 },
  reflectionMeta: { color: colors.textTertiary, fontSize: fontSize.xs, marginTop: spacing.xs },
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
});
