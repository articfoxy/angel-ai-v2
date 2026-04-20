/**
 * MemoryScreen — Angel Memory OS v2 browser.
 *
 * Five tabs matching the memory layers:
 *   Core      — editable named blocks (persona, user_profile, etc)
 *   Facts     — bi-temporal semantic facts w/ confidence + forget
 *   Episodes  — bounded interaction summaries
 *   Habits    — learned procedures (approve / deprecate)
 *   Thoughts  — reflections
 *
 * Plus: privacy-mode toggle at the top.
 */
import React, { useState, useCallback, useEffect } from 'react';
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
import { api } from '../services/api';
import { colors, spacing, fontSize, radius } from '../theme';

type Tab = 'core' | 'facts' | 'episodes' | 'habits' | 'thoughts' | 'commitments' | 'goals';

interface CoreBlock { id: string; label: string; value: string; version: number; readOnly: boolean; tokenCount: number; updatedAt: string }
interface Fact { id: string; content: string; subjectName: string; predicate: string; confidence: number; importance: number; status: string; freshnessAt: string; createdAt: string; tags: string[]; accessCount: number }
interface Episode { id: string; title: string; summary: string; timeStart: string; timeEnd: string; importance: number; confidence: number; status: string }
interface Procedure { id: string; triggerSignature: string; policyText: string; category: string; confidence: number; status: string; successCount: number; failureCount: number; createdAt: string }
interface Reflection { id: string; summary: string; themes: string[]; importance: number; confidence: number; timeWindowStart: string; timeWindowEnd: string; triggerKind: string; createdAt: string }
interface Commitment { id: string; fromName: string; toName: string; description: string; dueDate: string | null; status: string; importance: number; confidence: number; createdAt: string; completedAt: string | null; contradictsIds: string[] }
interface Goal { id: string; title: string; description: string | null; targetDate: string | null; progress: number; status: string; importance: number; mentionCount: number; lastMentionedAt: string | null; createdAt: string }

type PrivacyMode = 'off' | 'standard' | 'private_meeting';

export function MemoryScreen() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>('core');
  const [refreshing, setRefreshing] = useState(false);

  const [blocks, setBlocks] = useState<CoreBlock[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [procedures, setProcedures] = useState<Procedure[]>([]);
  const [reflections, setReflections] = useState<Reflection[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [privacy, setPrivacy] = useState<PrivacyMode>('standard');

  const [editingBlock, setEditingBlock] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  const loadAll = useCallback(async () => {
    try {
      const [bRes, fRes, eRes, pRes, rRes, cRes, gRes, privRes] = await Promise.allSettled([
        api.get<CoreBlock[]>('memory/core'),
        api.get<Fact[]>('memory/facts?status=all'),
        api.get<Episode[]>('memory/episodes'),
        api.get<Procedure[]>('memory/procedures'),
        api.get<Reflection[]>('memory/reflections'),
        api.get<Commitment[]>('memory/commitments'),
        api.get<Goal[]>('memory/goals'),
        api.get<{ mode: PrivacyMode }>('memory/privacy'),
      ]);
      if (bRes.status === 'fulfilled') setBlocks(bRes.value || []);
      if (fRes.status === 'fulfilled') setFacts(fRes.value || []);
      if (eRes.status === 'fulfilled') setEpisodes(eRes.value || []);
      if (pRes.status === 'fulfilled') setProcedures(pRes.value || []);
      if (rRes.status === 'fulfilled') setReflections(rRes.value || []);
      if (cRes.status === 'fulfilled') setCommitments(cRes.value || []);
      if (gRes.status === 'fulfilled') setGoals(gRes.value || []);
      if (privRes.status === 'fulfilled') setPrivacy(((privRes.value as any)?.mode as PrivacyMode) ?? 'standard');
    } catch {}
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  }, [loadAll]);

  const saveBlock = async (label: string) => {
    try {
      await api.patch(`memory/core/${label}`, { value: editValue });
      setEditingBlock(null);
      await loadAll();
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Failed to save');
    }
  };

  const forgetFact = (factId: string, content: string) => {
    Alert.alert(
      'Forget this fact?',
      content.slice(0, 120),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: async () => {
          await api.delete(`memory/facts/${factId}`);
          await loadAll();
        }},
      ],
    );
  };

  const approveProcedure = async (id: string) => {
    await api.post(`memory/procedures/${id}/approve`, {});
    await loadAll();
  };
  const deprecateProcedure = async (id: string) => {
    await api.delete(`memory/procedures/${id}`);
    await loadAll();
  };

  const setPrivacyMode = async (mode: PrivacyMode) => {
    await api.post('memory/privacy', { mode });
    setPrivacy(mode);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Memory</Text>
        <View style={styles.privacyRow}>
          {(['off', 'standard', 'private_meeting'] as const).map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.privacyChip, privacy === m && styles.privacyChipActive]}
              onPress={() => setPrivacyMode(m)}
            >
              <Text style={[styles.privacyText, privacy === m && styles.privacyTextActive]}>
                {m === 'off' ? 'Off' : m === 'standard' ? 'Standard' : 'Private'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabsWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
          {(['core', 'commitments', 'goals', 'facts', 'episodes', 'habits', 'thoughts'] as Tab[]).map((t) => {
            const label =
              t === 'core' ? 'Core'
              : t === 'commitments' ? `Commitments (${commitments.filter((c) => c.status === 'open').length})`
              : t === 'goals' ? `Goals (${goals.filter((g) => g.status === 'active').length})`
              : t === 'facts' ? `Facts (${facts.length})`
              : t === 'episodes' ? `Episodes (${episodes.length})`
              : t === 'habits' ? `Habits (${procedures.length})`
              : `Reflections (${reflections.length})`;
            return (
              <TouchableOpacity
                key={t}
                style={[styles.tab, activeTab === t && styles.tabActive]}
                onPress={() => setActiveTab(t)}
              >
                <Text style={[styles.tabLabel, activeTab === t && styles.tabLabelActive]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />}
      >
        {/* ─── CORE ─── */}
        {activeTab === 'core' && (
          <View style={{ gap: spacing.md }}>
            {blocks.length === 0 && <Text style={styles.empty}>No core blocks yet.</Text>}
            {blocks.map((b) => (
              <View key={b.id} style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.blockLabel}>{b.label.replace(/_/g, ' ').toUpperCase()}</Text>
                    <Text style={styles.blockMeta}>v{b.version} · ~{b.tokenCount} tokens{b.readOnly ? ' · read-only' : ''}</Text>
                  </View>
                  {!b.readOnly && editingBlock !== b.label && (
                    <TouchableOpacity onPress={() => { setEditingBlock(b.label); setEditValue(b.value); }}>
                      <Ionicons name="pencil-outline" size={16} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                </View>
                {editingBlock === b.label ? (
                  <>
                    <TextInput
                      style={styles.editInput}
                      value={editValue}
                      onChangeText={setEditValue}
                      multiline
                      placeholder="(empty)"
                      placeholderTextColor={colors.textTertiary}
                    />
                    <View style={styles.editActions}>
                      <TouchableOpacity onPress={() => setEditingBlock(null)}>
                        <Text style={styles.editCancel}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => saveBlock(b.label)} style={styles.editSaveBtn}>
                        <Text style={styles.editSave}>Save</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : (
                  <Text style={styles.blockValue}>{b.value || <Text style={styles.empty}>(empty — tap edit to add)</Text>}</Text>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ─── FACTS ─── */}
        {activeTab === 'facts' && (
          <View style={{ gap: spacing.sm }}>
            {facts.length === 0 && <Text style={styles.empty}>No facts yet. Talk to Angel — they'll build up.</Text>}
            {facts.map((f) => (
              <View key={f.id} style={styles.factCard}>
                <View style={styles.factMeta}>
                  <View style={[styles.statusPill, f.status === 'active' ? styles.statusActive : styles.statusCandidate]}>
                    <Text style={styles.statusText}>{f.status}</Text>
                  </View>
                  <Text style={styles.factConfidence}>conf {(f.confidence * 100).toFixed(0)}%</Text>
                  <Text style={styles.factImportance}>imp {f.importance}</Text>
                  <Text style={styles.factAccess}>✨ {f.accessCount}</Text>
                  <View style={{ flex: 1 }} />
                  <TouchableOpacity onPress={() => forgetFact(f.id, f.content)}>
                    <Ionicons name="trash-outline" size={14} color={colors.danger} />
                  </TouchableOpacity>
                </View>
                <Text style={styles.factContent}>{f.content}</Text>
                <Text style={styles.factDetail}>{f.subjectName} · {f.predicate}</Text>
                {f.tags.length > 0 && (
                  <View style={styles.factTags}>
                    {f.tags.slice(0, 5).map((t) => (
                      <Text key={t} style={styles.tag}>#{t}</Text>
                    ))}
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* ─── EPISODES ─── */}
        {activeTab === 'episodes' && (
          <View style={{ gap: spacing.sm }}>
            {episodes.length === 0 && <Text style={styles.empty}>No episodes yet.</Text>}
            {episodes.map((e) => (
              <View key={e.id} style={styles.card}>
                <View style={styles.episodeHeader}>
                  <Text style={styles.episodeTitle} numberOfLines={1}>{e.title}</Text>
                  <Text style={styles.episodeDate}>{new Date(e.timeEnd).toLocaleDateString()}</Text>
                </View>
                <Text style={styles.factDetail}>imp {e.importance} · conf {(e.confidence * 100).toFixed(0)}%</Text>
                <Text style={styles.episodeSummary}>{e.summary}</Text>
              </View>
            ))}
          </View>
        )}

        {/* ─── HABITS (Procedures) ─── */}
        {activeTab === 'habits' && (
          <View style={{ gap: spacing.sm }}>
            {procedures.length === 0 && <Text style={styles.empty}>No learned habits yet.</Text>}
            {procedures.map((p) => (
              <View key={p.id} style={styles.card}>
                <View style={styles.factMeta}>
                  <View style={[styles.statusPill, p.status === 'active' ? styles.statusActive : p.status === 'candidate' ? styles.statusCandidate : styles.statusDeprecated]}>
                    <Text style={styles.statusText}>{p.status}</Text>
                  </View>
                  <Text style={styles.factConfidence}>conf {(p.confidence * 100).toFixed(0)}%</Text>
                  <Text style={styles.factAccess}>✅ {p.successCount} / ❌ {p.failureCount}</Text>
                </View>
                <Text style={styles.procedureTrigger}>when: {p.triggerSignature}</Text>
                <Text style={styles.procedurePolicy}>{p.policyText}</Text>
                <View style={styles.procActions}>
                  {p.status === 'candidate' && (
                    <TouchableOpacity onPress={() => approveProcedure(p.id)} style={styles.approveBtn}>
                      <Ionicons name="checkmark" size={14} color={colors.success} />
                      <Text style={styles.approveText}>Approve</Text>
                    </TouchableOpacity>
                  )}
                  {p.status !== 'deprecated' && (
                    <TouchableOpacity onPress={() => deprecateProcedure(p.id)} style={styles.deprecateBtn}>
                      <Ionicons name="close" size={14} color={colors.danger} />
                      <Text style={styles.deprecateText}>Deprecate</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ─── REFLECTIONS ─── */}
        {activeTab === 'thoughts' && (
          <View style={{ gap: spacing.sm }}>
            {reflections.length === 0 && <Text style={styles.empty}>No reflections yet. Angel thinks on session end + nightly.</Text>}
            {reflections.map((r) => (
              <View key={r.id} style={styles.card}>
                <View style={styles.factMeta}>
                  <View style={styles.reflectionTrigger}>
                    <Text style={styles.reflectionTriggerText}>{r.triggerKind}</Text>
                  </View>
                  <Text style={styles.factConfidence}>conf {(r.confidence * 100).toFixed(0)}%</Text>
                  <Text style={styles.factImportance}>imp {r.importance}</Text>
                </View>
                <Text style={styles.reflectionSummary}>{r.summary}</Text>
                {r.themes.length > 0 && (
                  <View style={styles.factTags}>
                    {r.themes.slice(0, 4).map((t) => (
                      <Text key={t} style={styles.themeTag}>{t.replace(/_/g, ' ')}</Text>
                    ))}
                  </View>
                )}
                <Text style={styles.factDetail}>
                  {new Date(r.timeWindowStart).toLocaleDateString()} → {new Date(r.timeWindowEnd).toLocaleDateString()}
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* ─── COMMITMENTS ─── */}
        {activeTab === 'commitments' && (
          <View style={{ gap: spacing.sm }}>
            {commitments.length === 0 && <Text style={styles.empty}>No commitments yet. Angel tracks them from transcripts.</Text>}
            {commitments.map((c) => {
              const overdue = c.dueDate && new Date(c.dueDate).getTime() < Date.now() && c.status === 'open';
              return (
                <View key={c.id} style={styles.card}>
                  <View style={styles.factMeta}>
                    <View style={[styles.statusPill, c.status === 'open' ? (overdue ? styles.statusDeprecated : styles.statusActive) : styles.statusCandidate]}>
                      <Text style={styles.statusText}>{overdue ? 'overdue' : c.status}</Text>
                    </View>
                    {c.dueDate && (
                      <Text style={styles.factDetail}>
                        due {new Date(c.dueDate).toLocaleDateString()}
                      </Text>
                    )}
                    <View style={{ flex: 1 }} />
                    {c.contradictsIds.length > 0 && (
                      <Ionicons name="warning-outline" size={14} color={colors.warning} />
                    )}
                  </View>
                  <Text style={styles.factContent}>{c.description}</Text>
                  <Text style={styles.factDetail}>{c.fromName} → {c.toName}</Text>
                  {c.status === 'open' && (
                    <View style={styles.procActions}>
                      <TouchableOpacity
                        style={styles.approveBtn}
                        onPress={async () => { await api.post(`memory/commitments/${c.id}/complete`, {}); await loadAll(); }}
                      >
                        <Ionicons name="checkmark" size={14} color={colors.success} />
                        <Text style={styles.approveText}>Done</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={styles.deprecateBtn}
                        onPress={async () => { await api.post(`memory/commitments/${c.id}/cancel`, {}); await loadAll(); }}
                      >
                        <Ionicons name="close" size={14} color={colors.danger} />
                        <Text style={styles.deprecateText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* ─── GOALS ─── */}
        {activeTab === 'goals' && (
          <View style={{ gap: spacing.sm }}>
            {goals.length === 0 && <Text style={styles.empty}>No goals yet. Angel tracks them passively from what you say.</Text>}
            {goals.map((g) => (
              <View key={g.id} style={styles.card}>
                <View style={styles.factMeta}>
                  <View style={[styles.statusPill, g.status === 'active' ? styles.statusActive : styles.statusCandidate]}>
                    <Text style={styles.statusText}>{g.status}</Text>
                  </View>
                  <Text style={styles.factConfidence}>progress {(g.progress * 100).toFixed(0)}%</Text>
                  <Text style={styles.factAccess}>×{g.mentionCount}</Text>
                </View>
                <Text style={styles.factContent}>{g.title}</Text>
                {g.description && <Text style={styles.factDetail}>{g.description}</Text>}
                {g.targetDate && (
                  <Text style={styles.factDetail}>target {new Date(g.targetDate).toLocaleDateString()}</Text>
                )}
                {g.lastMentionedAt && (
                  <Text style={styles.factDetail}>last mentioned {new Date(g.lastMentionedAt).toLocaleDateString()}</Text>
                )}
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
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: { color: colors.text, fontSize: fontSize.xxl, fontWeight: '700', letterSpacing: -0.5 },
  privacyRow: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: 8, padding: 2, gap: 2 },
  privacyChip: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: 6 },
  privacyChipActive: { backgroundColor: colors.bg },
  privacyText: { color: colors.textSecondary, fontSize: 11, fontWeight: '500' },
  privacyTextActive: { color: colors.text, fontWeight: '600' },
  tabsWrap: { paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  tabs: { paddingHorizontal: spacing.md, gap: 6 },
  tab: { paddingHorizontal: spacing.sm + 2, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surfaceRaised },
  tabActive: { backgroundColor: colors.primaryMuted },
  tabLabel: { color: colors.textSecondary, fontSize: 13, fontWeight: '500' },
  tabLabelActive: { color: colors.primary, fontWeight: '700' },
  content: { padding: spacing.md, paddingBottom: spacing.xxl },
  empty: { color: colors.textTertiary, fontSize: fontSize.sm, textAlign: 'center', paddingVertical: spacing.xl },
  card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.xs },
  blockLabel: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700', letterSpacing: 0.5 },
  blockMeta: { color: colors.textTertiary, fontSize: 10, marginTop: 1 },
  blockValue: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  editInput: { color: colors.text, fontSize: fontSize.sm, backgroundColor: colors.bg, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs, minHeight: 80, textAlignVertical: 'top' },
  editActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md, marginTop: spacing.sm, alignItems: 'center' },
  editCancel: { color: colors.textSecondary, fontSize: fontSize.sm },
  editSaveBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.md, paddingVertical: spacing.xs + 2, borderRadius: radius.sm },
  editSave: { color: '#fff', fontSize: fontSize.sm, fontWeight: '600' },
  // Fact cards
  factCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, borderWidth: 1, borderColor: colors.border },
  factMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  statusActive: { backgroundColor: 'rgba(52, 211, 153, 0.15)' },
  statusCandidate: { backgroundColor: 'rgba(251, 191, 36, 0.15)' },
  statusDeprecated: { backgroundColor: 'rgba(148, 163, 184, 0.15)' },
  statusText: { color: colors.textSecondary, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  factConfidence: { color: colors.textSecondary, fontSize: 10 },
  factImportance: { color: colors.textSecondary, fontSize: 10 },
  factAccess: { color: colors.textSecondary, fontSize: 10 },
  factContent: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  factDetail: { color: colors.textTertiary, fontSize: 11, marginTop: 4 },
  factTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
  tag: { color: colors.primary, fontSize: 10, backgroundColor: colors.primaryMuted, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  // Episodes
  episodeHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4, alignItems: 'center' },
  episodeTitle: { color: colors.text, fontSize: fontSize.sm, fontWeight: '700', flex: 1 },
  episodeDate: { color: colors.textTertiary, fontSize: 11 },
  episodeSummary: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20, marginTop: 6 },
  // Procedures
  procedureTrigger: { color: colors.textSecondary, fontSize: 11, fontStyle: 'italic', marginTop: 4 },
  procedurePolicy: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20, marginTop: 4 },
  procActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  approveBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: 'rgba(52, 211, 153, 0.12)' },
  approveText: { color: colors.success, fontSize: 12, fontWeight: '600' },
  deprecateBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.sm, backgroundColor: 'rgba(248, 113, 113, 0.12)' },
  deprecateText: { color: colors.danger, fontSize: 12, fontWeight: '600' },
  // Reflections
  reflectionTrigger: { backgroundColor: 'rgba(56, 189, 248, 0.15)', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  reflectionTriggerText: { color: '#38bdf8', fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  reflectionSummary: { color: colors.text, fontSize: fontSize.sm, lineHeight: 20 },
  themeTag: { color: colors.textSecondary, fontSize: 10, backgroundColor: colors.surfaceRaised, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
});
