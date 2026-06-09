/**
 * Prediction Accuracy Center — Admin Analytics Module 1
 * Read-only. Never modifies prediction logic.
 */
import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';

const T = {
  bg: '#0f172a', surface: '#1e293b', elevated: '#0f172a',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
  purple: '#a78bfa',
};

type Range = '1' | '7' | '30' | 'all';

interface AccuracyLog {
  id: number;
  predicted_event_time: string;
  actual_event_time: string;
  predicted_state: string;
  actual_state: string;
  error_minutes: number;
  accuracy_score: number;
  confidence_score: number | null;
  prediction_generated_at: string | null;
  slot_id: string | null;
  created_at: string;
}

interface Stats {
  overall: number;
  avgError: number;
  onAccuracy: number;
  offAccuracy: number;
  count: number;
  trend: 'improving' | 'stable' | 'declining';
  trendDelta: number;
}

function computeStats(logs: AccuracyLog[]): Stats {
  if (logs.length === 0) return { overall: 0, avgError: 0, onAccuracy: 0, offAccuracy: 0, count: 0, trend: 'stable', trendDelta: 0 };
  const avg = (arr: number[]) => arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const scores = logs.map(l => l.accuracy_score);
  const errors = logs.map(l => l.error_minutes);
  const onLogs = logs.filter(l => l.predicted_state === 'UTILITY_ON');
  const offLogs = logs.filter(l => l.predicted_state === 'UTILITY_OFF');

  // Trend: compare first half vs second half accuracy
  const half = Math.max(1, Math.floor(logs.length / 2));
  const firstHalf = logs.slice(0, half).map(l => l.accuracy_score);
  const secondHalf = logs.slice(half).map(l => l.accuracy_score);
  const delta = avg(secondHalf) - avg(firstHalf);
  const trend = delta > 3 ? 'improving' : delta < -3 ? 'declining' : 'stable';

  return {
    overall: Math.round(avg(scores)),
    avgError: Math.round(avg(errors)),
    onAccuracy: Math.round(avg(onLogs.map(l => l.accuracy_score))),
    offAccuracy: Math.round(avg(offLogs.map(l => l.accuracy_score))),
    count: logs.length,
    trend,
    trendDelta: Math.abs(Math.round(delta)),
  };
}

function ScoreGauge({ score, label, sub }: { score: number; label: string; sub?: string }) {
  const color = score >= 85 ? T.success : score >= 65 ? T.warning : T.danger;
  return (
    <View style={gaugeStyles.wrap}>
      <View style={[gaugeStyles.ring, { borderColor: color + '55' }]}>
        <Text style={[gaugeStyles.score, { color }]}>{score}%</Text>
      </View>
      <Text style={gaugeStyles.label}>{label}</Text>
      {sub ? <Text style={gaugeStyles.sub}>{sub}</Text> : null}
    </View>
  );
}
const gaugeStyles = StyleSheet.create({
  wrap: { alignItems: 'center', flex: 1 },
  ring: { width: 72, height: 72, borderRadius: 36, borderWidth: 3, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  score: { fontSize: 18, fontWeight: '900' },
  label: { color: '#94a3b8', fontSize: 10, fontWeight: '700', textAlign: 'center' },
  sub: { color: '#64748b', fontSize: 9, textAlign: 'center', marginTop: 2 },
});

function TrendBadge({ trend, delta }: { trend: Stats['trend']; delta: number }) {
  const cfg = {
    improving: { color: T.success, icon: '↑', label: `تحسّن +${delta}%` },
    stable: { color: T.warning, icon: '→', label: 'مستقر' },
    declining: { color: T.danger, icon: '↓', label: `تراجع -${delta}%` },
  }[trend];
  return (
    <View style={[tStyles.badge, { backgroundColor: cfg.color + '18', borderColor: cfg.color + '44' }]}>
      <Text style={[tStyles.text, { color: cfg.color }]}>{cfg.icon} {cfg.label}</Text>
    </View>
  );
}
const tStyles = StyleSheet.create({
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  text: { fontSize: 12, fontWeight: '700' },
});

// ── 7-day Sparkline ────────────────────────────────────────────────────────

interface DayPoint { label: string; avg: number; count: number; }

function buildDailyPoints(logs: AccuracyLog[]): DayPoint[] {
  const now = Date.now();
  const points: DayPoint[] = [];
  for (let d = 6; d >= 0; d--) {
    const dayStart = now - (d + 1) * 86400000;
    const dayEnd   = now - d * 86400000;
    const dayLogs  = logs.filter(l => {
      const t = new Date(l.created_at).getTime();
      return t >= dayStart && t < dayEnd;
    });
    const avg = dayLogs.length === 0
      ? 0
      : dayLogs.reduce((s, l) => s + l.accuracy_score, 0) / dayLogs.length;
    const date = new Date(dayStart + 43200000); // midday of that day
    const label = date.toLocaleDateString('ar-SA', {
      timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
    });
    points.push({ label, avg: Math.round(avg), count: dayLogs.length });
  }
  return points;
}

function AccuracySparkline({ logs }: { logs: AccuracyLog[] }) {
  const points = buildDailyPoints(logs);
  const hasData = points.some(p => p.count > 0);
  const CHART_W = 320;
  const CHART_H = 80;
  const PAD_X = 6;
  const PAD_Y = 8;
  const usableW = CHART_W - PAD_X * 2;
  const usableH = CHART_H - PAD_Y * 2;

  // Y: 0–100 accuracy range
  const toX = (i: number) => PAD_X + (i / (points.length - 1)) * usableW;
  const toY = (v: number) => PAD_Y + usableH - (v / 100) * usableH;

  // Build SVG polyline points string
  const linePoints = points
    .map((p, i) => `${toX(i).toFixed(1)},${toY(p.avg).toFixed(1)}`)
    .join(' ');

  // Fill area path
  const areaPath = points.length > 0
    ? `M${toX(0).toFixed(1)},${(PAD_Y + usableH).toFixed(1)} ` +
      points.map((p, i) => `L${toX(i).toFixed(1)},${toY(p.avg).toFixed(1)}`).join(' ') +
      ` L${toX(points.length - 1).toFixed(1)},${(PAD_Y + usableH).toFixed(1)} Z`
    : '';

  // Reference lines at 70 and 90
  const refLines = [70, 90];

  return (
    <View style={spStyles.card}>
      <View style={spStyles.headerRow}>
        <Text style={spStyles.badge}>{hasData ? `${points.filter(p => p.count > 0).length} يوم بيانات` : 'لا بيانات'}</Text>
        <Text style={spStyles.title}>اتجاه الدقة — آخر 7 أيام</Text>
      </View>

      {!hasData ? (
        <View style={spStyles.emptyArea}>
          <Text style={spStyles.emptyText}>ستظهر هنا بعد تراكم بيانات كافية</Text>
        </View>
      ) : (
        <View style={spStyles.chartWrap}>
          {/* Y-axis reference lines rendered as Views */}
          {refLines.map(ref => {
            const yPct = (1 - ref / 100) * 100;
            return (
              <View
                key={ref}
                style={[spStyles.refLine, { top: `${yPct}%` as any }]}
              >
                <Text style={spStyles.refLabel}>{ref}%</Text>
              </View>
            );
          })}

          {/* Bars + dots for each day */}
          {points.map((p, i) => {
            const barH = p.count === 0 ? 0 : Math.max(4, (p.avg / 100) * (CHART_H - PAD_Y * 2));
            const barColor = p.avg >= 85 ? T.success : p.avg >= 65 ? T.warning : T.danger;
            const barOpacity = p.count === 0 ? 0.15 : 0.8;
            return (
              <View key={i} style={spStyles.barCol}>
                <Text style={[spStyles.dotVal, { color: p.count === 0 ? T.textMuted : barColor }]}>
                  {p.count === 0 ? '—' : `${p.avg}%`}
                </Text>
                <View style={spStyles.barTrack}>
                  <View
                    style={[
                      spStyles.barFill,
                      { height: barH, backgroundColor: barColor, opacity: barOpacity },
                    ]}
                  />
                </View>
                <Text style={spStyles.dayLabel}>{p.label}</Text>
                {p.count > 0 && (
                  <Text style={spStyles.countLabel}>{p.count}</Text>
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Trend arrow */}
      {hasData && (() => {
        const withData = points.filter(p => p.count > 0);
        if (withData.length < 2) return null;
        const first = withData[0].avg;
        const last  = withData[withData.length - 1].avg;
        const delta = last - first;
        const trendColor = delta > 3 ? T.success : delta < -3 ? T.danger : T.warning;
        const trendIcon  = delta > 3 ? '↑' : delta < -3 ? '↓' : '→';
        const trendLabel = delta > 3
          ? `تحسّن ${Math.abs(Math.round(delta))}% خلال الأسبوع`
          : delta < -3
          ? `تراجع ${Math.abs(Math.round(delta))}% خلال الأسبوع`
          : 'مستقر خلال الأسبوع';
        return (
          <View style={[spStyles.trendRow, { backgroundColor: trendColor + '15' }]}>
            <Text style={[spStyles.trendText, { color: trendColor }]}>{trendIcon} {trendLabel}</Text>
          </View>
        );
      })()}
    </View>
  );
}

const spStyles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginBottom: 14,
    borderWidth: 1, borderColor: '#334155',
  },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  badge: { color: '#475569', fontSize: 10 },
  emptyArea: { height: 60, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#475569', fontSize: 12 },
  chartWrap: {
    flexDirection: 'row-reverse', alignItems: 'flex-end',
    height: 110, gap: 4, position: 'relative', paddingHorizontal: 4,
  },
  refLine: {
    position: 'absolute', left: 0, right: 0, height: 1,
    backgroundColor: '#334155', flexDirection: 'row-reverse', alignItems: 'center',
  },
  refLabel: { color: '#475569', fontSize: 8, position: 'absolute', right: 0, top: -8 },
  barCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 3 },
  barTrack: { width: '80%', maxWidth: 28, height: 80, justifyContent: 'flex-end', backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden' },
  barFill: { width: '100%', borderRadius: 4 },
  dotVal: { fontSize: 9, fontWeight: '800', textAlign: 'center' },
  dayLabel: { color: '#475569', fontSize: 8, textAlign: 'center', marginTop: 2 },
  countLabel: { color: '#334155', fontSize: 7, textAlign: 'center' },
  trendRow: { marginTop: 12, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, alignItems: 'center' },
  trendText: { fontSize: 12, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────

function InsightWidget({ logs }: { logs: AccuracyLog[] }) {
  if (logs.length < 3) return null;
  const onLogs = logs.filter(l => l.predicted_state === 'UTILITY_ON');
  const offLogs = logs.filter(l => l.predicted_state === 'UTILITY_OFF');
  const avgOn = onLogs.length ? onLogs.reduce((s, l) => s + l.accuracy_score, 0) / onLogs.length : 0;
  const avgOff = offLogs.length ? offLogs.reduce((s, l) => s + l.accuracy_score, 0) / offLogs.length : 0;
  const recent7 = logs.filter(l => Date.now() - new Date(l.created_at).getTime() < 7 * 86400000);
  const avgRecent = recent7.length ? recent7.reduce((s, l) => s + l.accuracy_score, 0) / recent7.length : 0;
  const avgAll = logs.reduce((s, l) => s + l.accuracy_score, 0) / logs.length;
  const insights: string[] = [];
  if (avgRecent - avgAll > 5) insights.push(`تحسّنت دقة التوقع بنسبة ${Math.round(avgRecent - avgAll)}% هذا الأسبوع.`);
  if (avgRecent - avgAll < -5) insights.push(`تراجعت دقة التوقع بنسبة ${Math.round(avgAll - avgRecent)}% مؤخراً — قد يكون هناك تغيير في نمط الشبكة.`);
  if (avgOn - avgOff > 10) insights.push(`أنماط الليل أكثر قدرة على التنبؤ من أنماط النهار.`);
  if (avgOff - avgOn > 10) insights.push(`أنماط التشغيل أكثر قدرة على التنبؤ من أنماط الانقطاع.`);
  if (logs.some(l => l.error_minutes > 60)) insights.push(`بعض الأحداث تجاوزت خطأ 60 دقيقة — يُنصح بمراجعة نماذج APPPE.`);
  if (insights.length === 0) insights.push(`دقة التوقع مستقرة ومتسقة عبر أنواع الأحداث المختلفة.`);

  return (
    <View style={insStyles.card}>
      <Text style={insStyles.title}>💡 تحليل ذكي</Text>
      {insights.map((ins, i) => (
        <View key={i} style={insStyles.row}>
          <Text style={insStyles.dot}>•</Text>
          <Text style={insStyles.text}>{ins}</Text>
        </View>
      ))}
    </View>
  );
}
const insStyles = StyleSheet.create({
  card: { backgroundColor: '#1a1035', borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#4c1d95' },
  title: { color: '#a78bfa', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', gap: 8, marginBottom: 6 },
  dot: { color: '#a78bfa', fontSize: 14 },
  text: { color: '#c4b5fd', fontSize: 13, flex: 1, lineHeight: 19, textAlign: 'right' },
});

function LogRow({ log }: { log: AccuracyLog }) {
  const isOn = log.predicted_state === 'UTILITY_ON';
  const color = isOn ? T.success : T.danger;
  const scoreColor = log.accuracy_score >= 85 ? T.success : log.accuracy_score >= 65 ? T.warning : T.danger;
  const occurredAt = new Date(log.actual_event_time).toLocaleString('ar-SA', {
    timeZone: 'Asia/Aden', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const predAt = new Date(log.predicted_event_time).toLocaleString('ar-SA', {
    timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit',
  });
  return (
    <View style={logStyles.row}>
      <View style={logStyles.scoreCol}>
        <Text style={[logStyles.scoreVal, { color: scoreColor }]}>{Math.round(log.accuracy_score)}%</Text>
        <Text style={logStyles.errorVal}>{Math.round(log.error_minutes)} د</Text>
      </View>
      <View style={logStyles.content}>
        <View style={logStyles.topRow}>
          <Text style={[logStyles.state, { color }]}>{isOn ? '⚡ شغّالت' : '🔴 طفت'}</Text>
          <Text style={logStyles.time}>{occurredAt}</Text>
        </View>
        <Text style={logStyles.sub}>توقّعنا: {predAt} · الخطأ: {Math.round(log.error_minutes)} دقيقة</Text>
      </View>
    </View>
  );
}
const logStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1e293b', alignItems: 'center' },
  scoreCol: { alignItems: 'center', minWidth: 48 },
  scoreVal: { fontSize: 15, fontWeight: '900' },
  errorVal: { color: '#475569', fontSize: 10, marginTop: 2 },
  content: { flex: 1 },
  topRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 3 },
  state: { fontSize: 14, fontWeight: '700' },
  time: { color: '#64748b', fontSize: 11 },
  sub: { color: '#475569', fontSize: 11, textAlign: 'right' },
});

export default function AccuracyScreen() {
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<Range>('7');
  const [logs, setLogs] = useState<AccuracyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      let q = supabase
        .from('prediction_accuracy_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (range !== 'all') {
        const days = parseInt(range);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        q = q.gte('created_at', since);
      }
      const { data, error } = await q;
      if (error) console.error('[accuracy] fetch error:', error.message);
      setLogs((data ?? []) as AccuracyLog[]);
    } catch (err) { console.error('[accuracy] error:', err); }
    setLoading(false);
  }, [range]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchLogs();
    setRefreshing(false);
  }, [fetchLogs]);

  const stats = computeStats(logs);
  const todayLogs = logs.filter(l => Date.now() - new Date(l.created_at).getTime() < 86400000);
  const todayStats = computeStats(todayLogs);

  const ranges: { key: Range; label: string }[] = [
    { key: '1', label: 'اليوم' },
    { key: '7', label: '7 أيام' },
    { key: '30', label: '30 يوماً' },
    { key: 'all', label: 'الكل' },
  ];

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
    >
      {/* Range filter */}
      <View style={styles.filterRow}>
        {ranges.map(r => (
          <TouchableOpacity
            key={r.key}
            style={[styles.filterBtn, range === r.key && styles.filterBtnActive]}
            onPress={() => setRange(r.key)}
            activeOpacity={0.8}
          >
            <Text style={[styles.filterText, range === r.key && { color: T.accent }]}>{r.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={T.accent} />
          <Text style={styles.loadingText}>جارٍ تحليل البيانات…</Text>
        </View>
      ) : logs.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={styles.emptyIcon}>📊</Text>
          <Text style={styles.emptyTitle}>لا توجد بيانات دقة بعد</Text>
          <Text style={styles.emptySub}>تُسجَّل بيانات الدقة تلقائياً في كل مرة يكتشف فيها Growatt تغيّراً حقيقياً في الكهرباء.</Text>
        </View>
      ) : (
        <>
          {/* Main accuracy gauges */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <TrendBadge trend={stats.trend} delta={stats.trendDelta} />
              <Text style={styles.cardTitle}>دقة التوقعات</Text>
            </View>
            <View style={styles.gaugesRow}>
              <ScoreGauge score={stats.overall} label="الإجمالي" sub={`${stats.count} حدث`} />
              <ScoreGauge score={todayStats.overall} label="اليوم" sub={`${todayStats.count} حدث`} />
              <ScoreGauge score={stats.onAccuracy} label="دقة تشغيل" sub="⚡" />
              <ScoreGauge score={stats.offAccuracy} label="دقة انقطاع" sub="🔴" />
            </View>
          </View>

          {/* Stats pills */}
          <View style={styles.pillsRow}>
            <View style={styles.pill}>
              <Text style={styles.pillVal}>{stats.avgError} د</Text>
              <Text style={styles.pillLabel}>متوسط الخطأ</Text>
            </View>
            <View style={styles.pill}>
              <Text style={[styles.pillVal, { color: T.success }]}>{logs.filter(l => l.accuracy_score >= 80).length}</Text>
              <Text style={styles.pillLabel}>دقة ≥ 80%</Text>
            </View>
            <View style={styles.pill}>
              <Text style={[styles.pillVal, { color: T.danger }]}>{logs.filter(l => l.accuracy_score < 60).length}</Text>
              <Text style={styles.pillLabel}>دقة &lt; 60%</Text>
            </View>
            <View style={styles.pill}>
              <Text style={styles.pillVal}>{stats.count}</Text>
              <Text style={styles.pillLabel}>إجمالي القياسات</Text>
            </View>
          </View>

          {/* Error distribution bar */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>توزيع الخطأ</Text>
            {[
              { label: '< 5 د', filter: (e: number) => e < 5, color: T.success },
              { label: '5–15 د', filter: (e: number) => e >= 5 && e < 15, color: '#86efac' },
              { label: '15–30 د', filter: (e: number) => e >= 15 && e < 30, color: T.warning },
              { label: '30–60 د', filter: (e: number) => e >= 30 && e < 60, color: '#f97316' },
              { label: '> 60 د', filter: (e: number) => e >= 60, color: T.danger },
            ].map(bucket => {
              const count = logs.filter(l => bucket.filter(l.error_minutes)).length;
              const pct = logs.length > 0 ? (count / logs.length) * 100 : 0;
              return (
                <View key={bucket.label} style={styles.barRow}>
                  <Text style={styles.barCount}>{count}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${pct}%` as any, backgroundColor: bucket.color }]} />
                  </View>
                  <Text style={styles.barLabel}>{bucket.label}</Text>
                </View>
              );
            })}
          </View>

          <AccuracySparkline logs={logs} />

          <InsightWidget logs={logs} />

          {/* Log entries */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>أحدث الأحداث ({logs.length})</Text>
            {logs.slice(0, 30).map(l => <LogRow key={l.id} log={l} />)}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  filterRow: { flexDirection: 'row-reverse', backgroundColor: T.surface, borderRadius: 14, padding: 4, marginBottom: 14, gap: 2 },
  filterBtn: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 10 },
  filterBtnActive: { backgroundColor: '#1e3a5f' },
  filterText: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  cardHeader: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  cardTitle: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, textAlign: 'right' },
  gaugesRow: { flexDirection: 'row-reverse', justifyContent: 'space-around', paddingVertical: 8 },
  pillsRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 14 },
  pill: { flex: 1, backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  pillVal: { color: T.textPrimary, fontSize: 17, fontWeight: '900', marginBottom: 3 },
  pillLabel: { color: '#64748b', fontSize: 8, fontWeight: '700', letterSpacing: 0.8, textAlign: 'center' },
  barRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 8 },
  barLabel: { color: '#64748b', fontSize: 11, width: 52, textAlign: 'right' },
  barTrack: { flex: 1, height: 12, backgroundColor: T.elevated, borderRadius: 6, overflow: 'hidden' },
  barFill: { height: 12, borderRadius: 6 },
  barCount: { color: '#94a3b8', fontSize: 11, width: 24, textAlign: 'left' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 80 },
  loadingText: { color: '#64748b', marginTop: 12, fontSize: 14 },
  emptyBox: { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 24 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { color: '#94a3b8', fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: '#64748b', fontSize: 13, textAlign: 'center', lineHeight: 20 },
});
