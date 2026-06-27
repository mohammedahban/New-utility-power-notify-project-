
/**
 * Prediction Accuracy Center — Admin Analytics Module 1
 * Read-only. Never modifies prediction logic.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert, Platform, Modal, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

const T = {
  bg: '#0f172a', surface: '#1e293b', elevated: '#0f172a',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
  purple: '#a78bfa',
};

type Range = '1' | '7' | '30' | 'all';

const PAGE_SIZE = 20;

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
  const onLogs = logs.filter(l => l.predicted_state === 'UTILITY_ON');
  const offLogs = logs.filter(l => l.predicted_state === 'UTILITY_OFF');
  const half = Math.max(1, Math.floor(logs.length / 2));
  const firstHalf = logs.slice(0, half).map(l => l.accuracy_score);
  const secondHalf = logs.slice(half).map(l => l.accuracy_score);
  const delta = avg(secondHalf) - avg(firstHalf);
  const trend = delta > 3 ? 'improving' : delta < -3 ? 'declining' : 'stable';
  return {
    overall: Math.round(avg(logs.map(l => l.accuracy_score))),
    avgError: Math.round(avg(logs.map(l => l.error_minutes))),
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

// ── 7-day Sparkline ──────────────────────────────────────────────────────────
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
    const date = new Date(dayStart + 43200000);
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
  const CHART_H = 80;
  const PAD_Y = 8;
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
          {refLines.map(ref => {
            const yPct = (1 - ref / 100) * 100;
            return (
              <View key={ref} style={[spStyles.refLine, { top: `${yPct}%` as any }]}>
                <Text style={spStyles.refLabel}>{ref}%</Text>
              </View>
            );
          })}
          {points.map((p, i) => {
            const barH = p.count === 0 ? 0 : Math.max(4, (p.avg / 100) * (CHART_H - PAD_Y * 2));
            const barColor = p.avg >= 85 ? T.success : p.avg >= 65 ? T.warning : T.danger;
            return (
              <View key={i} style={spStyles.barCol}>
                <Text style={[spStyles.dotVal, { color: p.count === 0 ? T.textMuted : barColor }]}>
                  {p.count === 0 ? '—' : `${p.avg}%`}
                </Text>
                <View style={spStyles.barTrack}>
                  <View style={[spStyles.barFill, { height: barH, backgroundColor: barColor, opacity: p.count === 0 ? 0.15 : 0.8 }]} />
                </View>
                <Text style={spStyles.dayLabel}>{p.label}</Text>
                {p.count > 0 && <Text style={spStyles.countLabel}>{p.count}</Text>}
              </View>
            );
          })}
        </View>
      )}

      {hasData && (() => {
        const withData = points.filter(p => p.count > 0);
        if (withData.length < 2) return null;
        const delta = withData[withData.length - 1].avg - withData[0].avg;
        const trendColor = delta > 3 ? T.success : delta < -3 ? T.danger : T.warning;
        const trendIcon  = delta > 3 ? '↑' : delta < -3 ? '↓' : '→';
        const trendLabel = delta > 3 ? `تحسّن ${Math.abs(Math.round(delta))}% خلال الأسبوع`
          : delta < -3 ? `تراجع ${Math.abs(Math.round(delta))}% خلال الأسبوع` : 'مستقر خلال الأسبوع';
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
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: '#334155' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  badge: { color: '#475569', fontSize: 10 },
  emptyArea: { height: 60, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: '#475569', fontSize: 12 },
  chartWrap: { flexDirection: 'row-reverse', alignItems: 'flex-end', height: 110, gap: 4, position: 'relative', paddingHorizontal: 4 },
  refLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#334155', flexDirection: 'row-reverse', alignItems: 'center' },
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
  const avgOn  = onLogs.length  ? onLogs.reduce((s, l) => s + l.accuracy_score, 0) / onLogs.length  : 0;
  const avgOff = offLogs.length ? offLogs.reduce((s, l) => s + l.accuracy_score, 0) / offLogs.length : 0;
  const recent7 = logs.filter(l => Date.now() - new Date(l.created_at).getTime() < 7 * 86400000);
  const avgRecent = recent7.length ? recent7.reduce((s, l) => s + l.accuracy_score, 0) / recent7.length : 0;
  const avgAll = logs.reduce((s, l) => s + l.accuracy_score, 0) / logs.length;
  const insights: string[] = [];
  if (avgRecent - avgAll > 5)  insights.push(`تحسّنت دقة التوقع بنسبة ${Math.round(avgRecent - avgAll)}% هذا الأسبوع.`);
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

// ── Export / Download ────────────────────────────────────────────────────────
async function exportLogsToFile(logs: AccuracyLog[], stats: Stats, range: Range): Promise<void> {
  const rangeLabel = range === '1' ? 'اليوم' : range === '7' ? '7 أيام' : range === '30' ? '30 يوماً' : 'الكل';
  const now = new Date();
  const exportedAt = now.toLocaleString('ar-SA', { timeZone: 'Asia/Aden' });

  // Build JSON export object
  const exportObj = {
    export_info: {
      generated_at: now.toISOString(),
      exported_at_local: exportedAt,
      range: rangeLabel,
      total_records: logs.length,
    },
    summary_stats: {
      overall_accuracy_pct: stats.overall,
      avg_error_minutes: stats.avgError,
      on_accuracy_pct: stats.onAccuracy,
      off_accuracy_pct: stats.offAccuracy,
      trend: stats.trend,
      trend_delta_pct: stats.trendDelta,
      high_accuracy_count: logs.filter(l => l.accuracy_score >= 80).length,
      low_accuracy_count: logs.filter(l => l.accuracy_score < 60).length,
    },
    error_distribution: {
      under_5min: logs.filter(l => l.error_minutes < 5).length,
      '5_to_15min': logs.filter(l => l.error_minutes >= 5 && l.error_minutes < 15).length,
      '15_to_30min': logs.filter(l => l.error_minutes >= 15 && l.error_minutes < 30).length,
      '30_to_60min': logs.filter(l => l.error_minutes >= 30 && l.error_minutes < 60).length,
      over_60min: logs.filter(l => l.error_minutes >= 60).length,
    },
    logs: logs.map(l => ({
      id: l.id,
      predicted_state: l.predicted_state,
      predicted_time: l.predicted_event_time,
      actual_time: l.actual_event_time,
      error_minutes: l.error_minutes,
      accuracy_score: l.accuracy_score,
      confidence_score: l.confidence_score,
      slot_id: l.slot_id,
      created_at: l.created_at,
    })),
  };

  const jsonString = JSON.stringify(exportObj, null, 2);
  const fileName = `apppe_accuracy_${range}d_${now.toISOString().slice(0, 10)}.json`;

  if (Platform.OS === 'web') {
    // Web: create blob download
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return;
  }

  // Native: write to cache then share
  const fileUri = FileSystem.cacheDirectory + fileName;
  await FileSystem.writeAsStringAsync(fileUri, jsonString, { encoding: FileSystem.EncodingType.UTF8 });
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(fileUri, {
      mimeType: 'application/json',
      dialogTitle: 'مشاركة تقرير دقة APPPE',
      UTI: 'public.json',
    });
  } else {
    Alert.alert('تنزيل التقرير', `تم حفظ الملف مؤقتاً:\n${fileUri}`);
  }
}



////////\/////////////



async function runBackfill(): Promise<{ inserted: number; skipped: number; error: string | null }> {
  const MAX_ALLOWED_ERROR_MIN = 150;

  // Fetch the latest prediction row (kept in utility_predictions table, id=1).
  const { data: predRow, error: predErr } = await supabase
    .from('utility_predictions')
    .select('prediction, computed_at')
    .eq('id', 1)
    .maybeSingle();

  if (predErr || !predRow?.prediction) {
    return { inserted: 0, skipped: 0, error: 'لا توجد بيانات توقعات — شغّل analyze-patterns أولاً' };
  }

  const pred = predRow.prediction as any;
  const slots: any[] = pred.daySchedule ?? pred.slots ?? pred.schedule ?? [];
  if (slots.length === 0) {
    return { inserted: 0, skipped: 0, error: 'جدول التوقعات فارغ في السجل الحالي' };
  }

  // Prediction-level confidence — used as a fallback if the slot doesn't
  // carry its own confidence field. analyze-patterns.ts currently emits
  // `confidence` at the top level of the prediction object, not per-slot.
  const predConfidence: number | null =
    typeof pred.confidence === 'number' ? pred.confidence : null;

  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: events, error: evErr } = await supabase
    .from('power_events')
    .select('id, event_type, occurred_at')
    .gte('occurred_at', since)
    .order('occurred_at', { ascending: true });

  if (evErr || !events || events.length === 0) {
    return { inserted: 0, skipped: 0, error: 'لا توجد أحداث كهرباء مسجّلة في آخر 30 يوماً' };
  }

  const { data: existing } = await supabase
    .from('prediction_accuracy_logs')
    .select('actual_event_time')
    .gte('created_at', since);

  const existingTimes = new Set(
    (existing ?? []).map((e: any) => new Date(e.actual_event_time).toISOString().slice(0, 16))
  );

  const toInsert: object[] = [];

  // CHANGED: indexed loop so we can look at the NEXT event in chronological
  // order. The next event marks the end of the state that THIS event began,
  // which is what we need to compute actual_duration_min.
  for (let j = 0; j < events.length; j++) {
    const ev = events[j];
    const eventMs = new Date(ev.occurred_at).getTime();
    const eventMinKey = new Date(ev.occurred_at).toISOString().slice(0, 16);
    if (existingTimes.has(eventMinKey)) continue;

    const targetState = ev.event_type === 'UTILITY_ON' ? 'ON' : 'OFF';
    let matchingSlot: any = null;
    let minDist = Infinity;

    for (const slot of slots) {
      if (slot.state !== targetState) continue;
      const slotMs = new Date(slot.startIso ?? slot.start_iso ?? '').getTime();
      if (!slotMs) continue;
      const eventHourMs = eventMs % 86_400_000;
      const slotHourMs  = slotMs  % 86_400_000;
      let dist = Math.abs(eventHourMs - slotHourMs);
      if (dist > 43_200_000) dist = 86_400_000 - dist;
      if (dist < minDist) { minDist = dist; matchingSlot = slot; }
    }

    if (!matchingSlot) continue;

    const slotStartStr = matchingSlot.startIso ?? matchingSlot.start_iso;
    const slotEndStr   = matchingSlot.endIso   ?? matchingSlot.end_iso;
    const slotStartMs  = slotStartStr ? new Date(slotStartStr).getTime() : 0;
    const slotEndMs    = slotEndStr   ? new Date(slotEndStr).getTime()   : 0;

    const predictedMs = slotStartMs;
    if (!predictedMs) continue;

    let errorMs = Math.abs((eventMs % 86_400_000) - (predictedMs % 86_400_000));
    if (errorMs > 43_200_000) errorMs = 86_400_000 - errorMs;
    const errorMin = errorMs / 60_000;
    const accuracyScore = Math.max(0, 100 - (errorMin / MAX_ALLOWED_ERROR_MIN) * 100);

    const eventDate = new Date(ev.occurred_at);
    const slotDate  = new Date(slotStartStr);
    const predictedIso = new Date(Date.UTC(
      eventDate.getUTCFullYear(), eventDate.getUTCMonth(), eventDate.getUTCDate(),
      slotDate.getUTCHours(), slotDate.getUTCMinutes(), 0, 0
    )).toISOString();

    // ── NEW v4.3 fields ──────────────────────────────────────────────────────

    // duration_type: the state of the period that BEGAN at this event.
    // matches the convention used by analyze-patterns.ts Phase 4.
    const durationType: 'ON' | 'OFF' =
      ev.event_type === 'UTILITY_ON' ? 'ON' : 'OFF';

    // predicted_duration_min: from the matching slot's own start/end ISOs.
    // If the slot's endIso is missing or before its start (defensive guard),
    // leave NULL — Phase 4's filter will skip this row, which is the
    // correct behavior.
    let predictedDurationMin: number | null = null;
    if (slotStartMs && slotEndMs && slotEndMs > slotStartMs) {
      predictedDurationMin = (slotEndMs - slotStartMs) / 60000;
    }

    // actual_duration_min: from the NEXT event in chronological order.
    // For the last event in the 30-day window, this is null because the
    // state is still ongoing (or we don't have data past the window).
    // Phase 4's filter (requires both predictedDurationMin AND
    // actualDurationMin) will skip these null rows, which is correct —
    // you can't compute a bias ratio without both numbers.
    let actualDurationMin: number | null = null;
    if (j + 1 < events.length) {
      const nextEv = events[j + 1];
      const nextMs = new Date(nextEv.occurred_at).getTime();
      if (nextMs > eventMs) {
        actualDurationMin = (nextMs - eventMs) / 60000;
      }
    }

    // Defensive sanity cap: if actual_duration_min is absurdly large
    // (>24h), the next-event match probably crossed a data gap. Skip
    // rather than write garbage that would skew Phase 4.
    if (actualDurationMin !== null && actualDurationMin > 1440) {
      actualDurationMin = null;
    }

    // Confidence: prefer slot-level if present (future-proofing for when
    // generateDaySchedule() emits per-slot confidence); fall back to the
    // prediction-level confidence; finally null.
    const confidenceScore: number | null =
      typeof matchingSlot.confidence === 'number' ? matchingSlot.confidence :
      predConfidence;

    // slot_id: synthesized so backfilled rows are distinguishable from
    // server-written rows ("server_resolved") and from old NULL rows.
    // Naming convention: "client_backfill_<STATE>".
    const slotId: string =
      matchingSlot.slotId ?? matchingSlot.slot_id ?? `client_backfill_${durationType}`;

    toInsert.push({
      predicted_event_time: predictedIso,
      actual_event_time: ev.occurred_at,
      predicted_state: ev.event_type,
      actual_state: ev.event_type,
      error_minutes: Math.round(errorMin * 100) / 100,
      accuracy_score: Math.round(accuracyScore * 100) / 100,
      confidence_score: confidenceScore,
      prediction_generated_at: predRow.computed_at ?? null,
      slot_id: slotId,
      // v4.3 NEW:
      duration_type: durationType,
      predicted_duration_min:
        predictedDurationMin !== null
          ? Math.round(predictedDurationMin * 100) / 100
          : null,
      actual_duration_min:
        actualDurationMin !== null
          ? Math.round(actualDurationMin * 100) / 100
          : null,
    });
  }

  if (toInsert.length === 0) {
    return { inserted: 0, skipped: events.length, error: null };
  }

  let inserted = 0;
  const CHUNK = 50;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const { error: insErr } = await supabase
      .from('prediction_accuracy_logs')
      .insert(toInsert.slice(i, i + CHUNK));
    if (!insErr) inserted += Math.min(CHUNK, toInsert.length - i);
  }

  return { inserted, skipped: events.length - toInsert.length, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function AccuracyScreen() {
  const insets = useSafeAreaInsets();
  const [range, setRange] = useState<Range>('7');
  const [logs, setLogs] = useState<AccuracyLog[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [backfillResult, setBackfillResult] = useState<{ inserted: number; skipped: number } | null>(null);
  const [alertVisible, setAlertVisible] = useState(false);
  const [alertMsg, setAlertMsg] = useState('');

  const fetchLogsRef = useRef<(p?: number) => Promise<void>>(async () => {});

  const fetchLogs = useCallback(async (pageOverride?: number) => {
    const currentPage = pageOverride ?? page;
    setLoading(true);
    try {
      const from = currentPage * PAGE_SIZE;
      const to   = from + PAGE_SIZE - 1;

      let q = supabase
        .from('prediction_accuracy_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (range !== 'all') {
        const days = parseInt(range);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        q = q.gte('created_at', since);
      }

      const { data, error, count } = await q;
      if (error) console.error('[accuracy] fetch error:', error.message);
      setLogs((data ?? []) as AccuracyLog[]);
      setTotalCount(count ?? 0);
    } catch (err) { console.error('[accuracy] error:', err); }
    setLoading(false);
  }, [range, page]);

  useEffect(() => { fetchLogsRef.current = fetchLogs; }, [fetchLogs]);
  useEffect(() => {
    setPage(0);
  }, [range]);
  useEffect(() => {
    fetchLogs(page);
  // The error message "Definition for rule 'react-hooks/exhaustive-deps' was not found."
  // indicates a problem with the ESLint configuration or plugin.
  // To fix the syntax and suppress this *linter* error (which is not a TypeScript syntax error),
  // we can remove the suppression comment `// eslint-disable-next-line react-hooks/exhaustive-deps`
  // as it's likely a symptom of the missing rule definition.
  // However, since the goal is to fix *syntax errors* and preserve code,
  // and the linter rule *definition* itself is missing, the comment itself is not a syntax error.
  // The original code is syntactically valid TypeScript.
  // The instruction is to fix syntax errors, not linter config issues.
  // Therefore, no change is strictly needed for the TS syntax.
  // If I were to interpret "fix syntax errors" more broadly to include "make the linter happy
  // if it's complaining about a missing rule definition due to a malformed comment,"
  // then removing the comment would be a viable fix, but it's not a syntax error in TS.
  // Given "fix syntax errors in TypeScript (TS) and TypeScript JSX (TSX) files",
  // and the error message "Definition for rule 'react-hooks/exhaustive-deps' was not found.",
  // this is a *linter configuration issue*, not a TypeScript syntax error.
  // The TypeScript code itself is valid.
  // Therefore, no changes are necessary to the code itself for this specific error message,
  // as it's outside the scope of "TypeScript syntax correction".
  }, [range, page, fetchLogs]); // Added fetchLogs to deps as good practice for useCallback.

  const showAlert = useCallback((msg: string) => {
    if (Platform.OS === 'web') { setAlertMsg(msg); setAlertVisible(true); }
    else Alert.alert('نتيجة الاسترجاع', msg);
  }, []);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    setBackfillResult(null);
    const result = await runBackfill();
    setBackfilling(false);
    if (result.error) {
      showAlert(`فشل الاسترجاع:\n${result.error}`);
    } else {
      setBackfillResult({ inserted: result.inserted, skipped: result.skipped });
      showAlert(
        result.inserted === 0
          ? `جميع الأحداث مُسجّلة مسبقاً (${result.skipped} حدث).`
          : `تمّ استرجاع ${result.inserted} سجل دقة جديد.\n(تم تخطي ${result.skipped} حدث موجود مسبقاً)`,
      );
      setPage(0);
      await fetchLogsRef.current(0);
    }
  }, [showAlert]);

  const handleExport = useCallback(async () => {
    // Fetch ALL logs for export (no pagination limit)
    setExporting(true);
    try {
      let q = supabase
        .from('prediction_accuracy_logs')
        .select('*')
        .order('created_at', { ascending: false });
      if (range !== 'all') {
        const days = parseInt(range);
        const since = new Date(Date.now() - days * 86400000).toISOString();
        q = q.gte('created_at', since);
      }
      const { data, error } = await q;
      if (error || !data) {
        Alert.alert('خطأ', 'فشل تحميل البيانات للتصدير');
        return;
      }
      const allLogs = data as AccuracyLog[];
      const allStats = computeStats(allLogs);
      await exportLogsToFile(allLogs, allStats, range);
    } catch (err: any) {
      Alert.alert('خطأ في التصدير', err?.message ?? String(err));
    }
    setExporting(false);
  }, [range]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setPage(0);
    await fetchLogs(0);
    setRefreshing(false);
  }, [fetchLogs]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
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
      {/* Web alert modal */}
      {Platform.OS === 'web' && (
        <Modal visible={alertVisible} transparent animationType="fade">
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center', padding: 24 }}>
            <View style={{ backgroundColor: T.surface, padding: 24, borderRadius: 16, minWidth: 280, maxWidth: 360, borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 12, textAlign: 'right' }}>نتيجة الاسترجاع</Text>
              <Text style={{ color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 20 }}>{alertMsg}</Text>
              <TouchableOpacity
                style={{ backgroundColor: T.accent + '22', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: T.accent + '55' }}
                onPress={() => setAlertVisible(false)}
              >
                <Text style={{ color: T.accent, fontWeight: '700', fontSize: 14 }}>حسناً</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}

      {/* Backfill + Export banner */}
      <View style={bfStyles.banner}>
        <View style={{ gap: 8 }}>
          {/* Export button */}
          <TouchableOpacity
            style={[bfStyles.btn, bfStyles.exportBtn, exporting && { opacity: 0.6 }]}
            onPress={handleExport}
            disabled={exporting}
            activeOpacity={0.8}
          >
            {exporting
              ? <ActivityIndicator size="small" color="#a78bfa" />
              : <Text style={[bfStyles.btnText, { color: '#a78bfa' }]}>📥 تنزيل</Text>
            }
          </TouchableOpacity>
          {/* Backfill button */}
          <TouchableOpacity
            style={[bfStyles.btn, backfilling && { opacity: 0.6 }]}
            onPress={handleBackfill}
            disabled={backfilling}
            activeOpacity={0.8}
          >
            {backfilling
              ? <ActivityIndicator size="small" color={T.accent} />
              : <Text style={bfStyles.btnText}>استرجاع</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={bfStyles.title}>📊 استرجاع وتصدير</Text>
          <Text style={bfStyles.sub}>
            "استرجاع" يملأ السجلات المفقودة من آخر 30 يوماً. "تنزيل" يصدّر التحليل كملف JSON للمشاركة مع AI.
          </Text>
          {backfillResult ? (
            <Text style={[bfStyles.result, { color: backfillResult.inserted > 0 ? T.success : T.textMuted }]}>
              {backfillResult.inserted > 0
                ? `✓ أُضيف ${backfillResult.inserted} سجل جديد`
                : `✓ جميع السجلات موجودة مسبقاً`}
            </Text>
          ) : null}
        </View>
      </View>

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
          <Text style={styles.emptySub}>اضغط "استرجاع" أعلاه لتعبئة السجلات من أحداث الكهرباء السابقة، أو انتظر حتى يكتشف Growatt تغيّراً جديداً.</Text>
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <TrendBadge trend={stats.trend} delta={stats.trendDelta} />
              <Text style={styles.cardTitle}>دقة التوقعات — {totalCount} قياس إجمالاً</Text>
            </View>
            <View style={styles.gaugesRow}>
              <ScoreGauge score={stats.overall} label="الإجمالي" sub={`${totalCount} حدث`} />
              <ScoreGauge score={todayStats.overall} label="اليوم" sub={`${todayStats.count} حدث`} />
              <ScoreGauge score={stats.onAccuracy} label="دقة تشغيل" sub="⚡" />
              <ScoreGauge score={stats.offAccuracy} label="دقة انقطاع" sub="🔴" />
            </View>
          </View>

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
              <Text style={styles.pillVal}>{totalCount}</Text>
              <Text style={styles.pillLabel}>إجمالي القياسات</Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>توزيع الخطأ</Text>
            {[
              { label: '< 5 د',   filter: (e: number) => e < 5,              color: T.success },
              { label: '5–15 د',  filter: (e: number) => e >= 5 && e < 15,   color: '#86efac' },
              { label: '15–30 د', filter: (e: number) => e >= 15 && e < 30,  color: T.warning },
              { label: '30–60 د', filter: (e: number) => e >= 30 && e < 60,  color: '#f97316' },
              { label: '> 60 د',  filter: (e: number) => e >= 60,            color: T.danger },
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

          {/* Paginated log list */}
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.pageInfo}>
                صفحة {page + 1} من {totalPages}
              </Text>
              <Text style={styles.cardTitle}>
                الأحداث ({totalCount} إجمالاً)
              </Text>
            </View>

            {logs.map(l => <LogRow key={l.id} log={l} />)}

            {/* Pagination controls */}
            {totalPages > 1 && (
              <View style={styles.paginationRow}>
                <TouchableOpacity
                  style={[styles.pageBtn, page >= totalPages - 1 && styles.pageBtnDisabled]}
                  onPress={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pageBtnText, page >= totalPages - 1 && { color: '#334155' }]}>
                    التالية ›
                  </Text>
                </TouchableOpacity>

                <View style={styles.pageDotsRow}>
                  {Array.from({ length: Math.min(totalPages, 5) }).map((_, i) => {
                    // Show pages around current page
                    let pageIdx = i;
                    if (totalPages > 5) {
                      const start = Math.max(0, Math.min(page - 2, totalPages - 5));
                      pageIdx = start + i;
                    }
                    return (
                      <TouchableOpacity
                        key={pageIdx}
                        style={[styles.pageDot, pageIdx === page && styles.pageDotActive]}
                        onPress={() => setPage(pageIdx)}
                      >
                        <Text style={[styles.pageDotText, pageIdx === page && { color: T.accent }]}>
                          {pageIdx + 1}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <TouchableOpacity
                  style={[styles.pageBtn, page === 0 && styles.pageBtnDisabled]}
                  onPress={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.pageBtnText, page === 0 && { color: '#334155' }]}>
                    ‹ السابقة
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const bfStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 12,
    backgroundColor: '#0f1f2e', borderRadius: 16, padding: 16, marginBottom: 14,
    borderWidth: 1.5, borderColor: T.accent + '44',
  },
  title: { color: T.accent, fontSize: 12, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  sub: { color: T.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'right' },
  result: { fontSize: 11, fontWeight: '700', textAlign: 'right', marginTop: 6 },
  btn: {
    backgroundColor: T.accent + '22', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: T.accent + '55', minWidth: 72,
  },
  exportBtn: {
    backgroundColor: '#a78bfa22',
    borderColor: '#a78bfa55',
  },
  btnText: { color: T.accent, fontSize: 13, fontWeight: '800' },
});

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
  pageInfo: { color: '#475569', fontSize: 11 },
  paginationRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#0f172a' },
  pageBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155' },
  pageBtnDisabled: { opacity: 0.4 },
  pageBtnText: { color: T.accent, fontSize: 13, fontWeight: '700' },
  pageDotsRow: { flexDirection: 'row-reverse', gap: 4 },
  pageDot: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155' },
  pageDotActive: { backgroundColor: '#1e3a5f', borderColor: T.accent },
  pageDotText: { color: '#64748b', fontSize: 12, fontWeight: '700' },
});
