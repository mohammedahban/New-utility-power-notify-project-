/**
 * Admin Users Analytics Page
 * Displays daily snapshots computed by compute-analytics edge function.
 * Snapshots are generated at 06:00 Yemen time — manual trigger also available.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { FunctionsHttpError } from '@supabase/supabase-js';

const T = {
  bg: '#0f172a', surface: '#1e293b', elevated: '#0f172a',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

interface Snapshot {
  snapshot_date: string;
  total_users: number;
  new_users_24h: number;
  active_users_24h: number;
  active_users_7d: number;
  active_users_30d: number;
  sessions_24h: number;
  sessions_7d: number;
  sessions_30d: number;
  total_seconds_24h: number;
  total_seconds_7d: number;
  total_seconds_30d: number;
  avg_session_seconds: number;
  computed_at: string;
}

function fmtDuration(secs: number): string {
  if (secs <= 0) return '0د';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return `${h}س`;
  return `${h}س ${m}د`;
}

function MetricCard({
  icon, title, value, sub, color, accent,
}: {
  icon: string; title: string; value: string;
  sub?: string; color?: string; accent?: string;
}) {
  return (
    <View style={[mcStyles.card, accent ? { borderTopWidth: 2, borderTopColor: accent } : {}]}>
      <Text style={mcStyles.icon}>{icon}</Text>
      <Text style={[mcStyles.value, color ? { color } : {}]}>{value}</Text>
      <Text style={mcStyles.title}>{title}</Text>
      {sub ? <Text style={mcStyles.sub}>{sub}</Text> : null}
    </View>
  );
}

const mcStyles = StyleSheet.create({
  card: {
    flex: 1, backgroundColor: T.surface, borderRadius: 14, padding: 14,
    alignItems: 'center', borderWidth: 1, borderColor: T.border, gap: 4,
  },
  icon: { fontSize: 22, marginBottom: 2 },
  value: { color: T.textPrimary, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  title: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.8, textAlign: 'center' },
  sub: { color: '#334155', fontSize: 9, textAlign: 'center' },
});

function PeriodTable({
  label,
  activeUsers, sessions, totalSeconds,
}: {
  label: string;
  activeUsers: number; sessions: number; totalSeconds: number;
}) {
  const avgPerUser = activeUsers > 0 ? Math.round(totalSeconds / activeUsers) : 0;
  return (
    <View style={ptStyles.block}>
      <Text style={ptStyles.period}>{label}</Text>
      {[
        { l: 'مستخدمون نشطون', v: String(activeUsers), c: T.accent },
        { l: 'عدد الجلسات',    v: String(sessions),    c: T.textSecondary },
        { l: 'إجمالي وقت الاستخدام', v: fmtDuration(totalSeconds), c: T.warning },
        { l: 'متوسط وقت/مستخدم', v: fmtDuration(avgPerUser), c: '#a78bfa' },
      ].map(row => (
        <View key={row.l} style={ptStyles.row}>
          <Text style={[ptStyles.val, { color: row.c }]}>{row.v}</Text>
          <Text style={ptStyles.lbl}>{row.l}</Text>
        </View>
      ))}
    </View>
  );
}

const ptStyles = StyleSheet.create({
  block: { flex: 1, backgroundColor: T.elevated, borderRadius: 12, padding: 12, gap: 8 },
  period: { color: T.textMuted, fontSize: 9, fontWeight: '800', letterSpacing: 1.2, textAlign: 'right', marginBottom: 4 },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#1e293b', paddingBottom: 6 },
  lbl: { color: T.textMuted, fontSize: 11 },
  val: { fontSize: 13, fontWeight: '800' },
});

function HistorySparkline({ snapshots }: { snapshots: Snapshot[] }) {
  if (snapshots.length === 0) return null;
  const maxActive = Math.max(...snapshots.map(s => s.active_users_24h), 1);
  return (
    <View style={hsStyles.card}>
      <Text style={hsStyles.title}>📅 المستخدمون النشطون — آخر {snapshots.length} أيام</Text>
      <View style={hsStyles.barsRow}>
        {snapshots.map((s, i) => {
          const h = Math.max(4, (s.active_users_24h / maxActive) * 52);
          const color = s.active_users_24h === 0 ? '#1e293b' : T.accent;
          const date = new Date(s.snapshot_date);
          const dayLabel = date.toLocaleDateString('ar-SA', {
            timeZone: 'Asia/Aden', weekday: 'short',
          });
          return (
            <View key={i} style={hsStyles.col}>
              <Text style={[hsStyles.val, { color }]}>
                {s.active_users_24h > 0 ? s.active_users_24h : '—'}
              </Text>
              <View style={hsStyles.track}>
                <View style={[hsStyles.fill, { height: h, backgroundColor: color }]} />
              </View>
              <Text style={hsStyles.day}>{dayLabel}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const hsStyles = StyleSheet.create({
  card: {
    backgroundColor: '#001a2e', borderRadius: 14, padding: 14,
    marginBottom: 14, borderWidth: 1, borderColor: T.accent + '33',
  },
  title: { color: T.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.8, textAlign: 'right', marginBottom: 14 },
  barsRow: { flexDirection: 'row-reverse', gap: 6, alignItems: 'flex-end', justifyContent: 'space-around' },
  col: { flex: 1, alignItems: 'center', gap: 4 },
  val: { fontSize: 10, fontWeight: '800', textAlign: 'center' },
  track: { width: '70%', height: 60, justifyContent: 'flex-end', backgroundColor: '#0f172a', borderRadius: 5, overflow: 'hidden' },
  fill: { width: '100%', borderRadius: 5 },
  day: { color: T.textMuted, fontSize: 9, textAlign: 'center' },
});

export default function UsersAnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [computing, setComputing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      // Latest snapshot
      const { data: latest } = await supabase
        .from('analytics_daily_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      setSnapshot(latest as Snapshot | null);

      // Last 7 days for sparkline
      const { data: hist } = await supabase
        .from('analytics_daily_snapshots')
        .select('*')
        .order('snapshot_date', { ascending: true })
        .limit(7);
      setHistory((hist ?? []) as Snapshot[]);
    } catch (err) {
      console.error('[users-analytics] fetch error:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchData();
    setRefreshing(false);
  }, [fetchData]);

  const handleCompute = useCallback(async () => {
    setComputing(true);
    try {
      const { data, error } = await supabase.functions.invoke('compute-analytics', { body: {} });
      if (error) {
        let msg = error.message;
        if (error instanceof FunctionsHttpError) {
          try { msg = await error.context?.text() ?? msg; } catch { /* */ }
        }
        Alert.alert('خطأ', msg);
      } else {
        await fetchData();
        Alert.alert('تم', 'تم احتساب اللقطة اليومية بنجاح ✓');
      }
    } catch (err: any) {
      Alert.alert('خطأ', err?.message ?? 'unknown');
    }
    setComputing(false);
  }, [fetchData]);

  const computedLabel = snapshot
    ? new Date(snapshot.computed_at).toLocaleString('ar-SA', {
        timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short',
      })
    : null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
    >
      {/* Header */}
      <View style={styles.headerRow}>
        <TouchableOpacity
          style={[styles.computeBtn, computing && { opacity: 0.6 }]}
          onPress={handleCompute}
          disabled={computing}
          activeOpacity={0.8}
        >
          {computing
            ? <ActivityIndicator size="small" color={T.accent} />
            : <Text style={styles.computeBtnText}>⚙️  احتساب الآن</Text>
          }
        </TouchableOpacity>
        <Text style={styles.headerTitle}>👥 إحصاءات المستخدمين</Text>
      </View>
      <Text style={styles.scheduleNote}>
        يُحتسب تلقائياً كل يوم عند الساعة 6:00 صباحاً (عدن) · يمكن التشغيل اليدوي أعلاه
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.accent} />
          <Text style={styles.loadingText}>جارٍ تحميل إحصاءات المستخدمين…</Text>
        </View>
      ) : !snapshot ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyTitle}>لا توجد لقطة بعد</Text>
          <Text style={styles.emptySub}>
            اضغط "احتساب الآن" لتوليد أول لقطة يومية، أو انتظر الجدولة التلقائية عند الساعة 6 صباحاً.
          </Text>
          <TouchableOpacity
            style={[styles.computeBtn, computing && { opacity: 0.6 }, { marginTop: 20 }]}
            onPress={handleCompute}
            disabled={computing}
            activeOpacity={0.8}
          >
            {computing
              ? <ActivityIndicator size="small" color={T.accent} />
              : <Text style={styles.computeBtnText}>⚙️  احتساب الآن</Text>
            }
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* Total users + new */}
          <View style={styles.topRow}>
            <MetricCard
              icon="👥" title="إجمالي المستخدمين"
              value={String(snapshot.total_users)}
              color={T.textPrimary} accent={T.accent}
            />
            <MetricCard
              icon="🆕" title="مستخدمون جدد (24س)"
              value={String(snapshot.new_users_24h)}
              color={snapshot.new_users_24h > 0 ? T.success : T.textMuted}
              accent={T.success}
            />
            <MetricCard
              icon="⏱" title="متوسط الجلسة"
              value={fmtDuration(snapshot.avg_session_seconds)}
              color="#a78bfa" accent="#a78bfa"
            />
          </View>

          {/* Period tables */}
          <Text style={styles.sectionLabel}>تفصيل حسب الفترة</Text>
          <View style={styles.periodsRow}>
            <PeriodTable
              label="آخر 24 ساعة"
              activeUsers={snapshot.active_users_24h}
              sessions={snapshot.sessions_24h}
              totalSeconds={snapshot.total_seconds_24h}
            />
            <PeriodTable
              label="آخر 7 أيام"
              activeUsers={snapshot.active_users_7d}
              sessions={snapshot.sessions_7d}
              totalSeconds={snapshot.total_seconds_7d}
            />
          </View>

          {/* 30-day */}
          <View style={styles.periodsRow}>
            <PeriodTable
              label="آخر 30 يوماً"
              activeUsers={snapshot.active_users_30d}
              sessions={snapshot.sessions_30d}
              totalSeconds={snapshot.total_seconds_30d}
            />
            <View style={{ flex: 1, backgroundColor: T.elevated, borderRadius: 12, padding: 12, gap: 8, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ fontSize: 32 }}>📅</Text>
              <Text style={{ color: T.textMuted, fontSize: 10, fontWeight: '700', textAlign: 'center', lineHeight: 16 }}>
                لقطة يوم{'\n'}
                {new Date(snapshot.snapshot_date).toLocaleDateString('ar-SA', {
                  timeZone: 'Asia/Aden', dateStyle: 'medium',
                })}
              </Text>
            </View>
          </View>

          {/* Sparkline history */}
          {history.length > 1 && <HistorySparkline snapshots={history} />}

          {/* Hours breakdown */}
          <View style={styles.hoursCard}>
            <Text style={styles.sectionLabel}>ساعات الاستخدام الإجمالية</Text>
            {[
              { label: 'آخر 24 ساعة', secs: snapshot.total_seconds_24h, color: T.accent },
              { label: 'آخر 7 أيام',  secs: snapshot.total_seconds_7d,  color: T.success },
              { label: 'آخر 30 يوماً', secs: snapshot.total_seconds_30d, color: '#a78bfa' },
            ].map(row => {
              const maxSecs = Math.max(snapshot.total_seconds_30d, 1);
              const pct = (row.secs / maxSecs) * 100;
              return (
                <View key={row.label} style={styles.hoursRow}>
                  <Text style={[styles.hoursVal, { color: row.color }]}>{fmtDuration(row.secs)}</Text>
                  <View style={styles.hoursBarWrap}>
                    <View style={[styles.hoursBarFill, { width: `${pct}%` as any, backgroundColor: row.color }]} />
                  </View>
                  <Text style={styles.hoursLabel}>{row.label}</Text>
                </View>
              );
            })}
          </View>

          {computedLabel && (
            <Text style={styles.computedAt}>حُسب في {computedLabel} (اليمن)</Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  headerTitle: { color: T.textPrimary, fontSize: 16, fontWeight: '800' },
  computeBtn: {
    backgroundColor: '#001a2e', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
    borderWidth: 1.5, borderColor: T.accent + '55', flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44,
  },
  computeBtnText: { color: T.accent, fontSize: 13, fontWeight: '700' },
  scheduleNote: { color: '#334155', fontSize: 10, textAlign: 'right', marginBottom: 16, lineHeight: 15 },
  center: { alignItems: 'center', paddingVertical: 64 },
  loadingText: { color: T.textMuted, marginTop: 12, fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: T.textSecondary, fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  topRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 16 },
  sectionLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 10, marginTop: 4 },
  periodsRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 10 },
  hoursCard: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.border, marginTop: 4 },
  hoursRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 12 },
  hoursLabel: { color: T.textMuted, fontSize: 11, minWidth: 80, textAlign: 'right' },
  hoursBarWrap: { flex: 1, height: 10, backgroundColor: T.elevated, borderRadius: 5, overflow: 'hidden' },
  hoursBarFill: { height: 10, borderRadius: 5 },
  hoursVal: { fontSize: 13, fontWeight: '800', minWidth: 44, textAlign: 'left' },
  computedAt: { color: '#334155', fontSize: 10, textAlign: 'center', marginTop: 4 },
});
