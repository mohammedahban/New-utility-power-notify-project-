import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, TextInput, Alert, Modal, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';
import { AR } from '../../constants/arabic';

const T = {
  bg: '#0f172a', surface: '#1e293b', elevated: '#0f172a',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

interface Conflict {
  id: number; report_id: number;
  growatt_state: string; reported_state: string;
  created_at: string; reviewed_by: string | null;
  reviewed_at: string | null; notes: string | null;
  reporter_username?: string | null;
  time_option?: string | null;
  estimated_transition_at?: string | null;
}

function ReviewModal({ visible, conflict, onClose, onSubmit, submitting }: {
  visible: boolean; conflict: Conflict | null; onClose: () => void;
  onSubmit: (conflictId: number, notes: string) => void; submitting: boolean;
}) {
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (conflict) setNotes(conflict.notes ?? '');
  }, [conflict]);

  if (!conflict) return null;

  const isOn = (s: string) => s === 'UTILITY_ON';
  const growattColor = isOn(conflict.growatt_state) ? T.success : T.danger;
  const reportedColor = isOn(conflict.reported_state) ? T.success : T.danger;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={rmStyles.overlay}>
        <View style={rmStyles.sheet}>
          <View style={rmStyles.handle} />
          <Text style={rmStyles.title}>{AR.reviewConflictTitle} #{conflict.id}</Text>

          <View style={rmStyles.statesRow}>
            <View style={[rmStyles.stateBox, { borderColor: reportedColor + '55' }]}>
              <Text style={rmStyles.stateBoxLabel}>{AR.communityReport}</Text>
              <Text style={[rmStyles.stateBoxValue, { color: reportedColor }]}>
                {isOn(conflict.reported_state) ? '⚡ ' + AR.gridOn : '🔴 ' + AR.gridOff}
              </Text>
            </View>
            <Text style={rmStyles.vs}>≠</Text>
            <View style={[rmStyles.stateBox, { borderColor: growattColor + '55' }]}>
              <Text style={rmStyles.stateBoxLabel}>{AR.growattSensor}</Text>
              <Text style={[rmStyles.stateBoxValue, { color: growattColor }]}>
                {isOn(conflict.growatt_state) ? '⚡ ' + AR.gridOn : '🔴 ' + AR.gridOff}
              </Text>
            </View>
          </View>

          <Text style={rmStyles.label}>{AR.adminNotes}</Text>
          <TextInput
            style={rmStyles.input}
            value={notes}
            onChangeText={setNotes}
            placeholder={AR.addNotes}
            placeholderTextColor={T.textMuted}
            multiline
            numberOfLines={3}
            textAlign="right"
          />

          <TouchableOpacity
            style={[rmStyles.submitBtn, submitting && { opacity: 0.6 }]}
            onPress={() => onSubmit(conflict.id, notes)}
            disabled={submitting}
            activeOpacity={0.85}
          >
            {submitting ? <ActivityIndicator color="#fff" size="small" /> : <Text style={rmStyles.submitText}>{AR.markAsReviewed}</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={rmStyles.cancelBtn} onPress={onClose}>
            <Text style={rmStyles.cancelText}>{AR.cancel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const rmStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: T.border, borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: T.textPrimary, fontSize: 18, fontWeight: '800', marginBottom: 20, textAlign: 'right' },
  statesRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 20 },
  stateBox: { flex: 1, backgroundColor: T.elevated, borderRadius: 12, padding: 14, borderWidth: 1 },
  stateBoxLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.2, marginBottom: 6, textAlign: 'right' },
  stateBoxValue: { fontSize: 15, fontWeight: '800', textAlign: 'right' },
  vs: { color: T.warning, fontSize: 22, fontWeight: '900' },
  label: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8, textAlign: 'right' },
  input: { backgroundColor: T.elevated, borderRadius: 12, padding: 14, color: T.textPrimary, fontSize: 14, borderWidth: 1, borderColor: T.border, marginBottom: 20, minHeight: 80, textAlignVertical: 'top' },
  submitBtn: { backgroundColor: '#1d4ed8', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: T.textMuted, fontSize: 14 },
});

const TIME_LABELS_AR: Record<string, string> = {
  now: AR.timeNow,
  '5min': AR.time5min,
  '10min': AR.time10min,
  '15min': AR.time15min,
  '20min': AR.time20min,
};

function ConflictCard({ conflict, onReview }: { conflict: Conflict; onReview: () => void }) {
  const isReviewed = !!conflict.reviewed_at;
  const isOn = (s: string) => s === 'UTILITY_ON';
  const growattColor = isOn(conflict.growatt_state) ? T.success : T.danger;
  const reportedColor = isOn(conflict.reported_state) ? T.success : T.danger;

  const occurredAt = conflict.estimated_transition_at
    ? new Date(conflict.estimated_transition_at).toLocaleString('ar-SA', { timeZone: 'Asia/Aden', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : new Date(conflict.created_at).toLocaleString('ar-SA', { timeZone: 'Asia/Aden', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  return (
    <View style={[ccStyles.card, isReviewed && { opacity: 0.55 }]}>
      {!isReviewed && <View style={ccStyles.unreviewedDot} />}

      <View style={ccStyles.header}>
        <View style={[ccStyles.statusBadge, isReviewed ? ccStyles.reviewedBadge : ccStyles.pendingBadge]}>
          <Text style={[ccStyles.statusText, isReviewed ? { color: T.success } : { color: T.warning }]}>
            {isReviewed ? AR.reviewed : AR.pending}
          </Text>
        </View>
        <Text style={ccStyles.id}>{AR.conflictHash}{conflict.id}</Text>
      </View>

      <View style={ccStyles.statesRow}>
        <View style={ccStyles.metaItem}>
          <Text style={ccStyles.stateLabel}>{AR.timeLabel}</Text>
          <Text style={ccStyles.metaVal}>{conflict.time_option ? TIME_LABELS_AR[conflict.time_option] ?? conflict.time_option : '—'}</Text>
        </View>
        <View style={ccStyles.metaItem}>
          <Text style={ccStyles.stateLabel}>{AR.reporterLabel}</Text>
          <Text style={ccStyles.metaVal}>{conflict.reporter_username ?? '—'}</Text>
        </View>
        <Text style={ccStyles.vsText}>≠</Text>
        <View style={ccStyles.stateItem}>
          <Text style={ccStyles.stateLabel}>{AR.reportedLabel}</Text>
          <Text style={[ccStyles.stateVal, { color: reportedColor }]}>{isOn(conflict.reported_state) ? '⚡ شغّال' : '🔴 طافي'}</Text>
        </View>
        <View style={ccStyles.stateItem}>
          <Text style={ccStyles.stateLabel}>{AR.growattLabel}</Text>
          <Text style={[ccStyles.stateVal, { color: growattColor }]}>{isOn(conflict.growatt_state) ? '⚡ شغّال' : '🔴 طافي'}</Text>
        </View>
      </View>

      <Text style={ccStyles.timestamp}>{AR.reportedAt} {occurredAt} (اليمن)</Text>

      {conflict.notes ? (
        <View style={ccStyles.notesBox}>
          <Text style={ccStyles.notesText}>{conflict.notes}</Text>
          <Text style={ccStyles.notesLabel}>{AR.adminNotes}: </Text>
        </View>
      ) : null}

      {!isReviewed && (
        <TouchableOpacity style={ccStyles.reviewBtn} onPress={onReview} activeOpacity={0.85}>
          <Text style={ccStyles.reviewBtnText}>{AR.reviewConflict}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const ccStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: T.border },
  unreviewedDot: { position: 'absolute', top: 14, left: 14, width: 8, height: 8, borderRadius: 4, backgroundColor: T.warning },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  id: { color: T.textSecondary, fontSize: 13, fontWeight: '700' },
  statusBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1 },
  reviewedBadge: { backgroundColor: '#052e16', borderColor: T.success + '55' },
  pendingBadge: { backgroundColor: '#1a0e00', borderColor: T.warning + '55' },
  statusText: { fontSize: 11, fontWeight: '700' },
  statesRow: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: T.elevated, borderRadius: 10, padding: 10, gap: 4, marginBottom: 10 },
  stateItem: { flex: 1, alignItems: 'center' },
  stateLabel: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  stateVal: { fontSize: 14, fontWeight: '800' },
  vsText: { color: T.warning, fontSize: 18, fontWeight: '900', paddingHorizontal: 4 },
  metaItem: { flex: 1, alignItems: 'center' },
  metaVal: { color: T.textSecondary, fontSize: 12, fontWeight: '600' },
  timestamp: { color: T.textMuted, fontSize: 11, marginBottom: 8, textAlign: 'right' },
  notesBox: { backgroundColor: T.elevated, borderRadius: 8, padding: 10, marginBottom: 10, flexDirection: 'row-reverse', flexWrap: 'wrap' },
  notesLabel: { color: T.textMuted, fontSize: 11, fontWeight: '700' },
  notesText: { color: T.textSecondary, fontSize: 11, flex: 1, textAlign: 'right' },
  reviewBtn: { backgroundColor: '#1c2a3a', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: T.accent + '44' },
  reviewBtnText: { color: T.accent, fontWeight: '700', fontSize: 13 },
});

export default function ConflictsScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'pending' | 'reviewed'>('pending');
  const [selectedConflict, setSelectedConflict] = useState<Conflict | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchConflicts = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.from('community_conflicts').select('*').order('created_at', { ascending: false }).limit(60);
      if (error) { console.error('[conflicts] fetch error:', error.message); setLoading(false); return; }

      const rows = (data ?? []) as Conflict[];
      const reportIds = [...new Set(rows.map(r => r.report_id))];
      if (reportIds.length > 0) {
        const { data: reports } = await supabase.from('utility_reports').select('id, reporter_id, time_option, estimated_transition_at').in('id', reportIds);
        const reporterIds = [...new Set((reports ?? []).map((r: any) => r.reporter_id))];
        let usernameMap: Record<string, string | null> = {};
        if (reporterIds.length > 0) {
          const { data: profiles } = await supabase.from('user_profiles').select('id, username').in('id', reporterIds);
          for (const p of profiles ?? []) usernameMap[p.id] = p.username;
        }
        const reportMap: Record<number, any> = {};
        for (const r of reports ?? []) reportMap[r.id] = r;
        const enriched = rows.map(c => {
          const rep = reportMap[c.report_id];
          return { ...c, reporter_username: rep ? (usernameMap[rep.reporter_id] ?? null) : null, time_option: rep?.time_option ?? null, estimated_transition_at: rep?.estimated_transition_at ?? null };
        });
        setConflicts(enriched);
      } else {
        setConflicts(rows);
      }
    } catch (err) { console.error('[conflicts] error:', err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchConflicts(); }, [fetchConflicts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchConflicts();
    setRefreshing(false);
  }, [fetchConflicts]);

  const handleMarkReviewed = useCallback(async (conflictId: number, notes: string) => {
    setSubmitting(true);
    const { error } = await supabase.from('community_conflicts').update({ reviewed_by: profile?.id ?? null, reviewed_at: new Date().toISOString(), notes: notes.trim() || null }).eq('id', conflictId);
    if (error) {
      Alert.alert(AR.error, error.message);
    } else {
      setSelectedConflict(null);
      await fetchConflicts();
    }
    setSubmitting(false);
  }, [profile, fetchConflicts]);

  const filtered = conflicts.filter(c => {
    if (filter === 'pending') return !c.reviewed_at;
    if (filter === 'reviewed') return !!c.reviewed_at;
    return true;
  });

  const pendingCount = conflicts.filter(c => !c.reviewed_at).length;

  return (
    <View style={styles.root}>
      <View style={styles.statsBar}>
        <View style={styles.statCell}>
          <Text style={[styles.statVal, { color: T.success }]}>{conflicts.length - pendingCount}</Text>
          <Text style={styles.statLabel}>{AR.reviewedFilter}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={[styles.statVal, { color: pendingCount > 0 ? T.warning : T.textMuted }]}>{pendingCount}</Text>
          <Text style={styles.statLabel}>{AR.pending}</Text>
        </View>
        <View style={styles.statDivider} />
        <View style={styles.statCell}>
          <Text style={styles.statVal}>{conflicts.length}</Text>
          <Text style={styles.statLabel}>{AR.total}</Text>
        </View>
      </View>

      <View style={styles.filterRow}>
        {(['reviewed', 'all', 'pending'] as const).map(f => (
          <TouchableOpacity key={f} style={[styles.filterBtn, filter === f && styles.filterBtnActive]} onPress={() => setFilter(f)} activeOpacity={0.8}>
            <Text style={[styles.filterText, filter === f && { color: T.accent }]}>
              {f === 'pending' ? `${AR.pendingFilter}${pendingCount > 0 ? ` (${pendingCount})` : ''}`
                : f === 'reviewed' ? AR.reviewedFilter : AR.allFilter}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && conflicts.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.accent} />
          <Text style={styles.loadingText}>{AR.loadingConflicts}</Text>
        </View>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 24 }]}
          data={filtered}
          keyExtractor={c => String(c.id)}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
          renderItem={({ item }) => <ConflictCard conflict={item} onReview={() => setSelectedConflict(item)} />}
          ListEmptyComponent={() => (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>✅</Text>
              <Text style={styles.emptyTitle}>
                {filter === 'pending' ? AR.noPendingConflicts : AR.noConflictsFound}
              </Text>
              <Text style={styles.emptySub}>
                {filter === 'pending' ? AR.allInAgreement : AR.dataConsistent}
              </Text>
            </View>
          )}
        />
      )}

      <ReviewModal
        visible={!!selectedConflict}
        conflict={selectedConflict}
        onClose={() => setSelectedConflict(null)}
        onSubmit={handleMarkReviewed}
        submitting={submitting}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  statsBar: { flexDirection: 'row-reverse', backgroundColor: T.surface, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.border, alignItems: 'center' },
  statCell: { flex: 1, alignItems: 'center' },
  statVal: { color: T.textPrimary, fontSize: 20, fontWeight: '900', marginBottom: 2 },
  statLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  statDivider: { width: 1, height: 32, backgroundColor: T.border },
  filterRow: { flexDirection: 'row-reverse', backgroundColor: T.surface, borderBottomWidth: 1, borderBottomColor: T.border },
  filterBtn: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  filterBtnActive: { borderBottomColor: T.accent },
  filterText: { color: T.textMuted, fontSize: 12, fontWeight: '600' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: T.textMuted, marginTop: 12, fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: T.textSecondary, fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
