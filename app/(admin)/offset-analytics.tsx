/**
 * Offset Analytics Center — Admin Analytics Module 2
 * Read-only aggregation. Never modifies offset calculation logic.
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, Platform, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system';
import { supabase } from '../../lib/supabase';

const T = {
  bg: '#0f172a', surface: '#1e293b', elevated: '#0f172a',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

interface OffsetUser {
  user_id: string;
  offset_minutes: number;
  updated_at: string;
  username?: string | null;
}

interface BucketEntry {
  bucket: number;
  count: number;
  pct: number;
}

function toBucket(min: number): number {
  return Math.round(min / 30) * 30;
}

function fmtOffset(min: number): string {
  if (min === 0) return '0';
  const sign = min > 0 ? '+' : '';
  return `${sign}${min}د`;
}

function clusterLabel(bucket: number): string {
  if (bucket < -45) return 'مبكر';
  if (bucket > 45) return 'متأخر';
  return 'محايد';
}

function clusterColor(bucket: number): string {
  if (bucket < -45) return '#38bdf8';
  if (bucket > 45) return '#a78bfa';
  return '#22c55e';
}

// ── Export helper ────────────────────────────────────────────────────────────
async function exportOffsetCSV(distribution: BucketEntry[]) {
  try {
    const header = 'bucket_minutes,count,pct\n';
    const rows = distribution.map(e => `${e.bucket},${e.count},${e.pct}`).join('\n');
    const csv = header + rows;

    if (Platform.OS === 'web') {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `offset_distribution_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      return;
    }

    const filename = `offset_distribution_${new Date().toISOString().slice(0, 10)}.csv`;
    const fileUri = (FileSystem.cacheDirectory ?? '') + filename;
    await FileSystem.writeAsStringAsync(fileUri, csv, { encoding: FileSystem.EncodingType.UTF8 });

    const canShare = await Sharing.isAvailableAsync();
    if (canShare) {
      await Sharing.shareAsync(fileUri, {
        mimeType: 'text/csv',
        dialogTitle: 'تصدير توزيع الفوارق الزمنية',
        UTI: 'public.comma-separated-values-text',
      });
    } else {
      Alert.alert('التصدير غير متاح', 'المشاركة غير مدعومة على هذا الجهاز.');
    }
  } catch (err) {
    console.error('[offset-export] error:', err);
    Alert.alert('خطأ في التصدير', 'فشل تصدير البيانات. يرجى المحاولة مجدداً.');
  }
}

// ── Sub-components ───────────────────────────────────────────────────────────

function DistributionBar({ entry, maxCount }: { entry: BucketEntry; maxCount: number }) {
  const color = clusterColor(entry.bucket);
  const widthPct = maxCount > 0 ? (entry.count / maxCount) * 100 : 0;
  const isMostCommon = entry.count === maxCount;
  return (
    <View style={dbStyles.row}>
      <View style={[dbStyles.countBadge, isMostCommon && { backgroundColor: color + '22', borderColor: color + '55' }]}>
        <Text style={[dbStyles.count, isMostCommon && { color }]}>{entry.count}</Text>
      </View>
      <View style={dbStyles.barWrap}>
        <View style={[dbStyles.bar, { width: `${widthPct}%` as any, backgroundColor: color + (isMostCommon ? 'dd' : '55') }]} />
      </View>
      <View style={[dbStyles.bucketLabel, { backgroundColor: color + '18' }]}>
        <Text style={[dbStyles.bucketText, { color }]}>{fmtOffset(entry.bucket)}</Text>
      </View>
    </View>
  );
}
const dbStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 7 },
  bucketLabel: { minWidth: 48, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignItems: 'center' },
  bucketText: { fontSize: 12, fontWeight: '700' },
  barWrap: { flex: 1, height: 16, backgroundColor: '#0f172a', borderRadius: 8, overflow: 'hidden' },
  bar: { height: 16, borderRadius: 8 },
  countBadge: { minWidth: 28, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: 'transparent', alignItems: 'center' },
  count: { color: '#64748b', fontSize: 11, fontWeight: '700' },
});

function ClusterCard({ label, users, color }: { label: string; users: OffsetUser[]; color: string }) {
  if (users.length === 0) return null;
  const avgOffset = Math.round(users.reduce((s, u) => s + u.offset_minutes, 0) / users.length);
  return (
    <View style={[ccStyles.card, { borderColor: color + '44' }]}>
      <View style={ccStyles.header}>
        <View style={[ccStyles.badge, { backgroundColor: color + '20', borderColor: color + '55' }]}>
          <Text style={[ccStyles.badgeText, { color }]}>{users.length} مستخدم</Text>
        </View>
        <Text style={[ccStyles.title, { color }]}>{label}</Text>
      </View>
      <View style={ccStyles.statsRow}>
        <View style={ccStyles.stat}>
          <Text style={[ccStyles.statVal, { color }]}>{fmtOffset(avgOffset)}</Text>
          <Text style={ccStyles.statLabel}>متوسط الفارق</Text>
        </View>
        <View style={ccStyles.stat}>
          <Text style={ccStyles.statVal}>{users.length}</Text>
          <Text style={ccStyles.statLabel}>عدد المستخدمين</Text>
        </View>
      </View>
    </View>
  );
}
const ccStyles = StyleSheet.create({
  card: { flex: 1, backgroundColor: '#1e293b', borderRadius: 14, padding: 14, borderWidth: 1 },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 13, fontWeight: '800' },
  badge: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  statsRow: { flexDirection: 'row-reverse', gap: 8 },
  stat: { flex: 1, alignItems: 'center' },
  statVal: { color: '#f1f5f9', fontSize: 16, fontWeight: '900', marginBottom: 2 },
  statLabel: { color: '#64748b', fontSize: 8, fontWeight: '700', letterSpacing: 1 },
});

function StabilityCard({ users }: { users: OffsetUser[] }) {
  const now = Date.now();
  const stable   = users.filter(u => now - new Date(u.updated_at).getTime() > 7 * 86400000);
  const moderate = users.filter(u => { const a = now - new Date(u.updated_at).getTime(); return a >= 2 * 86400000 && a <= 7 * 86400000; });
  const unstable = users.filter(u => now - new Date(u.updated_at).getTime() < 2 * 86400000);
  const total = users.length || 1;
  return (
    <View style={stabStyles.card}>
      <Text style={stabStyles.title}>ثبات الفارق الزمني</Text>
      <Text style={stabStyles.sub}>يقيس عدد أيام ثبات الفارق</Text>
      <View style={stabStyles.row}>
        {[
          { label: 'مستقر',  count: stable.length,   color: T.success, desc: '> 7 أيام'  },
          { label: 'متوسط',  count: moderate.length, color: T.warning, desc: '2–7 أيام'  },
          { label: 'متغيّر', count: unstable.length, color: T.danger,  desc: '< يومان'  },
        ].map(s => (
          <View key={s.label} style={stabStyles.cell}>
            <Text style={[stabStyles.val, { color: s.color }]}>{s.count}</Text>
            <Text style={stabStyles.label}>{s.label}</Text>
            <Text style={stabStyles.desc}>{s.desc}</Text>
            <View style={stabStyles.track}>
              <View style={[stabStyles.fill, { width: `${Math.round((s.count / total) * 100)}%` as any, backgroundColor: s.color }]} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}
const stabStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#334155' },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 4 },
  sub: { color: '#475569', fontSize: 11, textAlign: 'right', marginBottom: 16 },
  row: { flexDirection: 'row-reverse', gap: 8 },
  cell: { flex: 1, alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 10, padding: 10 },
  val: { fontSize: 22, fontWeight: '900', marginBottom: 4 },
  label: { color: '#94a3b8', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  desc: { color: '#475569', fontSize: 9, marginBottom: 8 },
  track: { width: '100%', height: 4, backgroundColor: '#1e293b', borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});

function SmartRecommendations({ distribution, users }: { distribution: BucketEntry[]; users: OffsetUser[] }) {
  const recs: string[] = [];
  const sorted = [...distribution].sort((a, b) => b.count - a.count);
  const top = sorted[0];
  if (top && top.count >= 5) {
    recs.push(`يوجد تجمّع كبير من ${top.count} مستخدم حول فارق ${fmtOffset(top.bucket)} — يُنصح بإنشاء كتلة حيّ خاصة.`);
  }
  const highOffset = users.filter(u => Math.abs(u.offset_minutes) > 90);
  if (highOffset.length >= 3) {
    recs.push(`${highOffset.length} مستخدم لديهم فارق يتجاوز 90 دقيقة — قد يحتاجون إعادة معايرة أو مراجعة نماذج APPPE.`);
  }
  const neutral = users.filter(u => Math.abs(u.offset_minutes) <= 15);
  if (neutral.length > users.length * 0.5) {
    recs.push(`أكثر من نصف المستخدمين في النطاق المحايد — أنماط APPPE الحالية تتوافق جيداً مع الأغلبية.`);
  }
  if (recs.length === 0) recs.push('التوزيع الزمني متوازن. لا توجد توصيات فورية.');
  return (
    <View style={recStyles.card}>
      <Text style={recStyles.title}>💡 توصيات ذكية</Text>
      {recs.map((r, i) => (
        <View key={i} style={recStyles.row}>
          <Text style={recStyles.dot}>→</Text>
          <Text style={recStyles.text}>{r}</Text>
        </View>
      ))}
    </View>
  );
}
const recStyles = StyleSheet.create({
  card: { backgroundColor: '#001a2e', borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#38bdf844' },
  title: { color: '#38bdf8', fontSize: 11, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 12 },
  row: { flexDirection: 'row-reverse', gap: 8, marginBottom: 8 },
  dot: { color: '#38bdf8', fontSize: 13, fontWeight: '700' },
  text: { color: '#94a3b8', fontSize: 13, flex: 1, lineHeight: 19, textAlign: 'right' },
});

// ── Screen ───────────────────────────────────────────────────────────────────

export default function OffsetAnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const [users, setUsers]         = useState<OffsetUser[]>([]);
  const [loading, setLoading]     = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [computedAt, setComputedAt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: offsets, error } = await supabase
        .from('user_offsets')
        .select('user_id, offset_minutes, updated_at')
        .order('offset_minutes');
      if (error) { console.error('[offset-analytics] error:', error.message); setLoading(false); return; }

      const rows = (offsets ?? []) as OffsetUser[];
      const uids = rows.map(r => r.user_id);
      if (uids.length > 0) {
        const { data: profiles } = await supabase.from('user_profiles').select('id, username').in('id', uids);
        const nameMap: Record<string, string | null> = {};
        for (const p of profiles ?? []) nameMap[p.id] = p.username;
        setUsers(rows.map(r => ({ ...r, username: nameMap[r.user_id] ?? null })));
      } else {
        setUsers(rows);
      }
      setComputedAt(new Date().toISOString());
    } catch (err) { console.error('[offset-analytics] error:', err); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  // Build distribution (memoized so export callback is stable)
  const distribution = useMemo<BucketEntry[]>(() => {
    const bucketMap: Record<number, number> = {};
    for (const u of users) {
      const b = toBucket(u.offset_minutes);
      bucketMap[b] = (bucketMap[b] ?? 0) + 1;
    }
    const allBuckets = Object.keys(bucketMap).map(Number).sort((a, b) => a - b);
    return allBuckets.map(b => ({
      bucket: b,
      count: bucketMap[b],
      pct: Math.round((bucketMap[b] / Math.max(users.length, 1)) * 100),
    }));
  }, [users]);

  const maxCount    = Math.max(...distribution.map(d => d.count), 1);
  const mostCommon  = distribution.reduce<BucketEntry | null>((a, b) => !a || b.count > a.count ? b : a, null);
  const earlyUsers  = users.filter(u => u.offset_minutes < -45);
  const neutralUsers = users.filter(u => Math.abs(u.offset_minutes) <= 45);
  const lateUsers   = users.filter(u => u.offset_minutes > 45);

  const handleExport = useCallback(async () => {
    setExporting(true);
    await exportOffsetCSV(distribution);
    setExporting(false);
  }, [distribution]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
    >
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.accent} />
          <Text style={styles.loadingText}>جارٍ تحليل بيانات الفوارق…</Text>
        </View>
      ) : users.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyTitle}>لا توجد بيانات فوارق بعد</Text>
          <Text style={styles.emptySub}>تظهر هنا فوارق المستخدمين بعد معايرة توقيتاتهم.</Text>
        </View>
      ) : (
        <>
          {/* Export CSV */}
          <TouchableOpacity
            style={styles.exportBtn}
            onPress={handleExport}
            disabled={exporting}
            activeOpacity={0.8}
          >
            {exporting
              ? <ActivityIndicator size="small" color={T.accent} />
              : <Text style={styles.exportBtnText}>📤  تصدير CSV  ·  {distribution.length} صف</Text>
            }
          </TouchableOpacity>

          {/* Summary pills */}
          <View style={styles.pillsRow}>
            <View style={styles.pill}>
              <Text style={styles.pillVal}>{users.length}</Text>
              <Text style={styles.pillLabel}>مستخدم نشط</Text>
            </View>
            <View style={styles.pill}>
              <Text style={[styles.pillVal, { color: T.accent }]}>
                {mostCommon ? fmtOffset(mostCommon.bucket) : '—'}
              </Text>
              <Text style={styles.pillLabel}>الفارق الأشيع</Text>
            </View>
            <View style={styles.pill}>
              <Text style={styles.pillVal}>
                {users.length > 0
                  ? fmtOffset(Math.round(users.reduce((s, u) => s + u.offset_minutes, 0) / users.length))
                  : '0'}
              </Text>
              <Text style={styles.pillLabel}>متوسط الفوارق</Text>
            </View>
          </View>

          {/* Distribution chart */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardSub}>{users.length} مستخدم</Text>
              <Text style={styles.cardTitle}>توزيع الفارق الزمني</Text>
            </View>
            {distribution.map(entry => (
              <DistributionBar key={entry.bucket} entry={entry} maxCount={maxCount} />
            ))}
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#a78bfa' }]} />
                <Text style={styles.legendText}>متأخر &gt;45د</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: T.success }]} />
                <Text style={styles.legendText}>محايد ±45د</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: T.accent }]} />
                <Text style={styles.legendText}>مبكر &lt;-45د</Text>
              </View>
            </View>
          </View>

          {/* Most common offset */}
          {mostCommon && (
            <View style={styles.highlightCard}>
              <View>
                <Text style={styles.highlightVal}>{fmtOffset(mostCommon.bucket)}</Text>
                <Text style={styles.highlightSub}>الفارق الأكثر شيوعاً</Text>
              </View>
              <View style={{ alignItems: 'flex-start', gap: 6 }}>
                <Text style={styles.highlightCount}>{mostCommon.count} مستخدم</Text>
                <View style={[styles.clusterChip, {
                  backgroundColor: clusterColor(mostCommon.bucket) + '22',
                  borderColor:     clusterColor(mostCommon.bucket) + '55',
                }]}>
                  <Text style={[styles.clusterChipText, { color: clusterColor(mostCommon.bucket) }]}>
                    {clusterLabel(mostCommon.bucket)}
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* Clusters */}
          <View style={styles.clustersRow}>
            <ClusterCard label="مبكرون"  users={earlyUsers}   color={T.accent}  />
            <ClusterCard label="محايدون" users={neutralUsers} color={T.success} />
            <ClusterCard label="متأخرون" users={lateUsers}    color="#a78bfa"   />
          </View>

          <StabilityCard users={users} />
          <SmartRecommendations distribution={distribution} users={users} />

          {/* User list */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>قائمة المستخدمين ({users.length})</Text>
            {users.slice(0, 40).map((u, i) => {
              const color   = clusterColor(u.offset_minutes);
              const daysAgo = Math.floor((Date.now() - new Date(u.updated_at).getTime()) / 86400000);
              return (
                <View key={u.user_id} style={[styles.userRow, i > 0 && { borderTopWidth: 1, borderTopColor: T.elevated }]}>
                  <View style={[styles.offsetChip, { backgroundColor: color + '18', borderColor: color + '44' }]}>
                    <Text style={[styles.offsetChipText, { color }]}>{fmtOffset(u.offset_minutes)}</Text>
                  </View>
                  <View style={styles.userInfo}>
                    <Text style={styles.userName}>{u.username ?? u.user_id.slice(0, 8)}</Text>
                    <Text style={styles.userMeta}>آخر تحديث منذ {daysAgo === 0 ? 'اليوم' : `${daysAgo} يوم`}</Text>
                  </View>
                </View>
              );
            })}
          </View>

          {computedAt && (
            <Text style={styles.computedAt}>
              حُسب في {new Date(computedAt).toLocaleString('ar-SA', {
                timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short',
              })} (اليمن)
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  exportBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#001a2e', borderRadius: 14, paddingVertical: 13, paddingHorizontal: 18,
    marginBottom: 14, borderWidth: 1.5, borderColor: T.accent + '55', gap: 8, minHeight: 48,
  },
  exportBtnText: { color: T.accent, fontSize: 14, fontWeight: '700' },
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  cardHeader: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  cardTitle: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, textAlign: 'right' },
  cardSub: { color: '#475569', fontSize: 11 },
  pillsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  pill: { flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  pillVal: { color: T.textPrimary, fontSize: 18, fontWeight: '900', marginBottom: 3 },
  pillLabel: { color: '#64748b', fontSize: 8, fontWeight: '700', letterSpacing: 0.8, textAlign: 'center' },
  legendRow: { flexDirection: 'row-reverse', gap: 14, marginTop: 12, justifyContent: 'center' },
  legendItem: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: '#64748b', fontSize: 10 },
  highlightCard: {
    backgroundColor: '#001a2e', borderRadius: 16, padding: 16, marginBottom: 14,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    borderWidth: 1, borderColor: T.accent + '44',
  },
  highlightVal: { color: T.accent, fontSize: 32, fontWeight: '900', textAlign: 'right' },
  highlightSub: { color: '#64748b', fontSize: 11, textAlign: 'right' },
  highlightCount: { color: '#94a3b8', fontSize: 16, fontWeight: '700' },
  clusterChip: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  clusterChipText: { fontSize: 11, fontWeight: '700' },
  clustersRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  userRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, paddingVertical: 9 },
  offsetChip: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, minWidth: 52, alignItems: 'center' },
  offsetChipText: { fontSize: 13, fontWeight: '800' },
  userInfo: { flex: 1 },
  userName: { color: '#f1f5f9', fontSize: 13, fontWeight: '600', textAlign: 'right' },
  userMeta: { color: '#475569', fontSize: 10, textAlign: 'right' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  loadingText: { color: '#64748b', marginTop: 12, fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: '#94a3b8', fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: '#64748b', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  computedAt: { color: '#334155', fontSize: 10, textAlign: 'center', marginTop: 4 },
});
