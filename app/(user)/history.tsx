
import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';

const T = {
  bg: '#0a0f1e', surface: '#0f172a', elevated: '#1e293b',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

// ─────────────────────────────────────────────────────────────────────────────
// POWER EVENTS HISTORY
// ─────────────────────────────────────────────────────────────────────────────
interface PowerEvent {
  id: number;
  event_type: 'UTILITY_ON' | 'UTILITY_OFF';
  occurred_at: string;
  durationLabel?: string;
}

function usePowerEventsHistory(limit = 25) {
  const [events, setEvents] = useState<PowerEvent[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('power_events')
      .select('id, event_type, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(limit + 1)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const withDuration: PowerEvent[] = data.slice(0, limit).map((ev: any, i: number) => {
          const endEv = data[i - 1];
          let durationLabel: string | undefined;
          if (endEv) {
            const endMs = new Date(endEv.occurred_at).getTime();
            const startMs = new Date(ev.occurred_at).getTime();
            const durMin = Math.round(Math.abs(endMs - startMs) / 60_000);
            const h = Math.floor(durMin / 60); const m = durMin % 60;
            if (h === 0) durationLabel = `${m} دقيقة`;
            else if (m === 0) durationLabel = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
            else durationLabel = `${h}س ${m}د`;
          }
          return { ...ev, durationLabel };
        });
        setEvents(withDuration);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [limit]);
  return { events, loading };
}

function fmtEventTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', weekday: 'short', month: 'short',
    day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function EventsHistorySection() {
  const { events, loading } = usePowerEventsHistory(25);
  return (
    <View style={ehStyles.container}>
      <Text style={ehStyles.sectionTitle}>📋 سجل الأحداث الفعلية</Text>
      <Text style={ehStyles.sectionSub}>الأحداث الحقيقية المسجَّلة من الحساس الرئيسي</Text>
      {loading ? (
        <ActivityIndicator color={T.accent} size="small" style={{ marginVertical: 16 }} />
      ) : events.length === 0 ? (
        <Text style={ehStyles.emptyText}>لا توجد أحداث مسجَّلة بعد</Text>
      ) : (
        events.map((ev, i) => {
          const isOn = ev.event_type === 'UTILITY_ON';
          const color = isOn ? T.success : T.danger;
          const icon = isOn ? '⚡' : '🔴';
          const label = isOn ? 'اشتغلت الكهرباء' : 'طفت الكهرباء';
          return (
            <View key={ev.id} style={[ehStyles.row, i < events.length - 1 && ehStyles.rowBorder]}>
              <View style={ehStyles.badgeCol}>
                {ev.durationLabel ? (
                  <View style={[ehStyles.durBadge, { borderColor: color + '44', backgroundColor: color + '10' }]}>
                    <Text style={[ehStyles.durBadgeText, { color }]}>{ev.durationLabel}</Text>
                    <Text style={ehStyles.durBadgeSub}>مدة</Text>
                  </View>
                ) : (
                  <View style={[ehStyles.durBadge, { borderColor: T.border, backgroundColor: T.elevated }]}>
                    <Text style={[ehStyles.durBadgeText, { color: T.textMuted }]}>—</Text>
                  </View>
                )}
              </View>
              <View style={ehStyles.details}>
                <Text style={[ehStyles.eventLabel, { color }]}>{icon} {label}</Text>
                <Text style={ehStyles.eventTime}>{fmtEventTime(ev.occurred_at)}</Text>
              </View>
              <View style={[ehStyles.colorBar, { backgroundColor: color }]} />
            </View>
          );
        })
      )}
    </View>
  );
}

const ehStyles = StyleSheet.create({
  container: {
    backgroundColor: T.surface, borderRadius: 20, padding: 18,
    marginBottom: 16, borderWidth: 1, borderColor: T.border,
  },
  sectionTitle: { color: T.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  sectionSub: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginBottom: 16, letterSpacing: 0.3 },
  emptyText: { color: T.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 16 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.elevated },
  colorBar: { width: 3, borderRadius: 2, alignSelf: 'stretch', minHeight: 36, flexShrink: 0 },
  details: { flex: 1 },
  eventLabel: { fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  eventTime: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  badgeCol: { alignItems: 'center', width: 64, flexShrink: 0 },
  durBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, alignItems: 'center', minWidth: 58 },
  durBadgeText: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  durBadgeSub: { color: T.textMuted, fontSize: 8, fontWeight: '600', marginTop: 2, letterSpacing: 1 },
});

// ─────────────────────────────────────────────────────────────────────────────
// UNCERTAIN ZONE OVERRUN HISTORY
// Reads resync_history and computes |confirmed_at − effective_transition_at|
// for each accepted ON report, treating this delta as the "deducted wait"
// per UNCERTAIN_ZONE cycle.
// ─────────────────────────────────────────────────────────────────────────────
interface OverrunEntry {
  id: number;
  confirmed_at: string;
  effective_transition_at: string;
  reporter_username: string | null;
  source: string;
  deductedMin: number;
  offsetState: string | null;
  offsetValue: number | string | null;
}

function useOverrunHistory(userId: string | undefined) {
  const [entries, setEntries] = useState<OverrunEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    let cancelled = false;
    supabase
      .from('resync_history')
      .select('id, confirmed_at, effective_transition_at, reporter_username, source, offset_state, offset_value, reverted_at')
      .eq('user_id', userId)
      .eq('reported_state', 'UTILITY_ON')
      .is('reverted_at', null)
      .order('confirmed_at', { ascending: false })
      .limit(30)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          // reverted_at column may not exist yet — retry without it
          if (error.message.includes('reverted_at') || error.message.includes('column')) {
            supabase
              .from('resync_history')
              .select('id, confirmed_at, effective_transition_at, reporter_username, source, offset_state, offset_value')
              .eq('user_id', userId)
              .eq('reported_state', 'UTILITY_ON')
              .order('confirmed_at', { ascending: false })
              .limit(30)
              .then(({ data: d2 }) => {
                if (cancelled) return;
                processRows(d2 ?? []);
              });
            return;
          }
          setLoading(false);
          return;
        }
        processRows(data ?? []);
      });

    function processRows(rows: any[]) {
      const result: OverrunEntry[] = rows.map(row => {
        const confirmedMs = new Date(row.confirmed_at).getTime();
        const effectiveMs = new Date(row.effective_transition_at).getTime();
        // deductedMin = how long the user waited after predicted ON before
        // the actual Growatt ON was confirmed (= the wait that was deducted
        // from the next ON cycle). It's the absolute difference in minutes.
        const deductedMin = Math.round(Math.abs(confirmedMs - effectiveMs) / 60_000);
        return {
          id: row.id,
          confirmed_at: row.confirmed_at,
          effective_transition_at: row.effective_transition_at,
          reporter_username: row.reporter_username ?? null,
          source: row.source ?? 'self_report',
          deductedMin,
          offsetState: row.offset_state ?? null,
          offsetValue: row.offset_value ?? null,
        };
      }).filter(e => e.deductedMin > 0); // skip entries with zero delta (neutral)
      setEntries(result);
      setLoading(false);
    }

    return () => { cancelled = true; };
  }, [userId]);

  return { entries, loading };
}

// ─────────────────────────────────────────────────────────────────────────────
// MINI BAR CHART
// Shows overrun duration per cycle, oldest → newest (left → right).
// Bars animate in on mount; color encodes severity.
// ─────────────────────────────────────────────────────────────────────────────
function MiniBarChart({ entries }: { entries: OverrunEntry[] }) {
  // Use last 10 entries, reversed so oldest is on the left
  const chartEntries = [...entries].slice(0, 10).reverse();
  const maxVal = Math.max(...chartEntries.map(e => e.deductedMin), 1);

  // One Animated.Value per bar
  const animRefs = useRef<Animated.Value[]>([]);
  if (animRefs.current.length !== chartEntries.length) {
    animRefs.current = chartEntries.map(() => new Animated.Value(0));
  }

  useEffect(() => {
    const anims = animRefs.current.map((av, i) =>
      Animated.timing(av, {
        toValue: chartEntries[i].deductedMin / maxVal,
        duration: 500 + i * 60,
        useNativeDriver: false,
      }),
    );
    Animated.stagger(40, anims).start();
  }, [chartEntries.map(e => e.id).join(','), maxVal]); // Added maxVal to dependency array

  const MAX_BAR_HEIGHT = 64;
  const BAR_WIDTH = 22;

  return (
    <View style={chartStyles.wrap}>
      {/* Y-axis label */}
      <Text style={chartStyles.yLabel}>وقت الانتظار (دقيقة)</Text>

      {/* Bars */}
      <View style={chartStyles.barsRow}>
        {chartEntries.map((entry, i) => {
          const severity =
            entry.deductedMin >= 60 ? 'high'
            : entry.deductedMin >= 20 ? 'medium'
            : 'low';
          const barColor =
            severity === 'high' ? T.danger
            : severity === 'medium' ? T.warning
            : T.success;

          const animH = animRefs.current[i]?.interpolate({
            inputRange: [0, 1],
            outputRange: [0, MAX_BAR_HEIGHT],
          }) ?? new Animated.Value(0);

          // Shorten date: "Jul 3" style
          const dateLabel = new Date(entry.confirmed_at).toLocaleDateString('en-US', {
            timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
          });

          return (
            <View key={entry.id} style={[chartStyles.barCol, { width: BAR_WIDTH + 8 }]}>
              {/* Value label above bar */}
              <Text style={[chartStyles.barVal, { color: barColor }]}>
                {entry.deductedMin}
              </Text>
              {/* Bar container — fixed height, bar grows from bottom */}
              <View style={[chartStyles.barTrack, { height: MAX_BAR_HEIGHT }]}>
                <Animated.View
                  style={[
                    chartStyles.barFill,
                    {
                      width: BAR_WIDTH,
                      height: animH,
                      backgroundColor: barColor,
                    },
                  ]}
                />
              </View>
              {/* Date label below bar */}
              <Text style={chartStyles.barDate} numberOfLines={1}>{dateLabel}</Text>
            </View>
          );
        })}
      </View>

      {/* Trend caption */}
      {chartEntries.length >= 3 && (() => {
        const firstHalf = chartEntries.slice(0, Math.floor(chartEntries.length / 2));
        const secondHalf = chartEntries.slice(Math.floor(chartEntries.length / 2));
        const avgFirst = firstHalf.reduce((s, e) => s + e.deductedMin, 0) / firstHalf.length;
        const avgSecond = secondHalf.reduce((s, e) => s + e.deductedMin, 0) / secondHalf.length;
        const diff = avgSecond - avgFirst;
        if (Math.abs(diff) < 5) return (
          <Text style={chartStyles.trendNeutral}>📊 الانتظار مستقر نسبياً عبر الدورات</Text>
        );
        if (diff > 0) return (
          <Text style={chartStyles.trendUp}>📈 الانتظار يتزايد — قد تحتاج لتعديل فارقك</Text>
        );
        return (
          <Text style={chartStyles.trendDown}>📉 الانتظار يتناقص — النمط يتحسّن</Text>
        );
      })()}
    </View>
  );
}

const chartStyles = StyleSheet.create({
  wrap: {
    backgroundColor: T.elevated, borderRadius: 14, padding: 14,
    marginBottom: 16, borderWidth: 1, borderColor: T.border,
  },
  yLabel: {
    color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 0.5,
    textAlign: 'right', marginBottom: 10,
  },
  barsRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 4,
    justifyContent: 'flex-start', flexWrap: 'wrap',
  },
  barCol: { alignItems: 'center', gap: 4 },
  barVal: { fontSize: 9, fontWeight: '800', textAlign: 'center' },
  barTrack: {
    justifyContent: 'flex-end', alignItems: 'center',
    backgroundColor: T.bg, borderRadius: 4, overflow: 'hidden',
  },
  barFill: { borderRadius: 4, opacity: 0.9 },
  barDate: {
    color: T.textMuted, fontSize: 8, textAlign: 'center',
    width: '100%', marginTop: 2,
  },
  trendUp: {
    color: T.danger, fontSize: 10, fontWeight: '700', textAlign: 'right',
    marginTop: 10,
  },
  trendDown: {
    color: T.success, fontSize: 10, fontWeight: '700', textAlign: 'right',
    marginTop: 10,
  },
  trendNeutral: {
    color: T.textMuted, fontSize: 10, fontWeight: '600', textAlign: 'right',
    marginTop: 10,
  },
});

function fmtShortTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function fmtDeducted(min: number): string {
  if (min < 60) return `${min} دقيقة`;
  const h = Math.floor(min / 60); const m = min % 60;
  const hLabel = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return m === 0 ? hLabel : `${hLabel} و ${m} دقيقة`;
}

function OverrunHistoryCard({ userId }: { userId: string | undefined }) {
  const { entries, loading } = useOverrunHistory(userId);

  // Compute summary stats
  const avgDeducted = entries.length > 0
    ? Math.round(entries.reduce((s, e) => s + e.deductedMin, 0) / entries.length)
    : 0;
  const maxDeducted = entries.length > 0
    ? Math.max(...entries.map(e => e.deductedMin))
    : 0;

  return (
    <View style={ovStyles.card}>
      {/* Header */}
      <View style={ovStyles.headerRow}>
        <View style={ovStyles.headerBadge}>
          <Text style={ovStyles.headerBadgeText}>⏱ سجل التجاوزات</Text>
        </View>
        <Text style={ovStyles.headerTitle}>سجل تجاوزات UNCERTAIN_ZONE</Text>
      </View>
      <Text style={ovStyles.headerSub}>
        وقت الانتظار المخصوم من كل دورة تشغيل — الفرق بين وقت التأكيد ووقت التحوّل المتوقع
      </Text>

      {/* Summary chips */}
      {entries.length > 0 && (
        <View style={ovStyles.summaryRow}>
          <View style={ovStyles.summaryChip}>
            <Text style={ovStyles.summaryChipLabel}>متوسط الانتظار</Text>
            <Text style={[ovStyles.summaryChipValue, { color: T.warning }]}>{fmtDeducted(avgDeducted)}</Text>
          </View>
          <View style={ovStyles.summaryChip}>
            <Text style={ovStyles.summaryChipLabel}>أطول انتظار</Text>
            <Text style={[ovStyles.summaryChipValue, { color: T.danger }]}>{fmtDeducted(maxDeducted)}</Text>
          </View>
          <View style={ovStyles.summaryChip}>
            <Text style={ovStyles.summaryChipLabel}>إجمالي الدورات</Text>
            <Text style={[ovStyles.summaryChipValue, { color: T.accent }]}>{entries.length}</Text>
          </View>
        </View>
      )}

      {/* Mini bar chart — rendered above the entries list */}
      {!loading && entries.length >= 2 && (
        <MiniBarChart entries={entries} />
      )}

      {loading ? (
        <ActivityIndicator color={T.accent} size="small" style={{ marginVertical: 16 }} />
      ) : entries.length === 0 ? (
        <View style={ovStyles.emptyBox}>
          <Text style={ovStyles.emptyIcon}>✅</Text>
          <Text style={ovStyles.emptyTitle}>لا تجاوزات مسجَّلة</Text>
          <Text style={ovStyles.emptySub}>
            لم تُسجَّل أي تجاوزات حتى الآن — إما أن فارقك محايد/إيجابي أو لم يحدث تأخير بعد
          </Text>
        </View>
      ) : (
        <View>
          {entries.map((entry, i) => {
            const severity =
              entry.deductedMin >= 60 ? 'high'
              : entry.deductedMin >= 20 ? 'medium'
              : 'low';
            const severityColor =
              severity === 'high' ? T.danger
              : severity === 'medium' ? T.warning
              : T.success;
            const severityLabel =
              severity === 'high' ? 'طويل' : severity === 'medium' ? 'متوسط' : 'قصير';
            const sourceLabel =
              entry.source === 'self_report' ? 'بلاغك' : 'مجتمعي';
            const offsetLabel = entry.offsetState === 'NEGATIVE'
              ? `فارق سلبي${typeof entry.offsetValue === 'number' ? ` (${entry.offsetValue}د)` : ''}`
              : entry.offsetState === 'POSITIVE'
                ? 'فارق إيجابي'
                : entry.offsetState ?? '';

            return (
              <View
                key={entry.id}
                style={[ovStyles.row, i < entries.length - 1 && ovStyles.rowBorder]}
              >
                {/* Left: deduction badge */}
                <View style={[ovStyles.deductBadge, { borderColor: severityColor + '55', backgroundColor: severityColor + '12' }]}>
                  <Text style={[ovStyles.deductMin, { color: severityColor }]}>
                    {entry.deductedMin}
                  </Text>
                  <Text style={[ovStyles.deductUnit, { color: severityColor + 'aa' }]}>دقيقة</Text>
                  <View style={[ovStyles.severityDot, { backgroundColor: severityColor }]} />
                  <Text style={[ovStyles.severityLabel, { color: severityColor }]}>{severityLabel}</Text>
                </View>

                {/* Right: details */}
                <View style={{ flex: 1 }}>
                  <View style={ovStyles.detailRow}>
                    <View style={[ovStyles.sourcePill, {
                      backgroundColor: entry.source === 'self_report' ? T.accent + '18' : T.success + '18',
                      borderColor: entry.source === 'self_report' ? T.accent + '44' : T.success + '44',
                    }]}>
                      <Text style={[ovStyles.sourcePillText, {
                        color: entry.source === 'self_report' ? T.accent : T.success,
                      }]}>{sourceLabel}</Text>
                    </View>
                    {offsetLabel ? (
                      <View style={ovStyles.offsetPill}>
                        <Text style={ovStyles.offsetPillText}>{offsetLabel}</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={ovStyles.effectiveTime}>
                    تحوّل متوقع: <Text style={{ color: T.textSecondary, fontWeight: '700' }}>
                      {fmtShortTime(entry.effective_transition_at)}
                    </Text>
                  </Text>
                  <Text style={ovStyles.confirmedTime}>
                    تأكيد فعلي: <Text style={{ color: T.warning, fontWeight: '600' }}>
                      {fmtShortTime(entry.confirmed_at)}
                    </Text>
                  </Text>
                  {entry.reporter_username && entry.source !== 'self_report' && (
                    <Text style={ovStyles.reporterLine}>
                      المُبلِّغ: <Text style={{ color: T.accent, fontWeight: '700' }}>{entry.reporter_username}</Text>
                    </Text>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Footer note */}
      <View style={ovStyles.footerNote}>
        <Text style={ovStyles.footerNoteText}>
          💡 المدة المعروضة = وقت الانتظار الذي تم خصمه من دورة التشغيل المقابلة
        </Text>
      </View>
    </View>
  );
}

const ovStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 20, padding: 18,
    marginBottom: 16, borderWidth: 1.5, borderColor: T.warning + '33',
  },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 6 },
  headerBadge: {
    backgroundColor: T.warning + '18', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4,
    borderWidth: 1, borderColor: T.warning + '44', flexShrink: 0,
  },
  headerBadgeText: { color: T.warning, fontSize: 10, fontWeight: '800' },
  headerTitle: { color: T.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'right', flex: 1 },
  headerSub: { color: T.textMuted, fontSize: 11, textAlign: 'right', lineHeight: 17, marginBottom: 14 },
  summaryRow: { flexDirection: 'row-reverse', gap: 8, marginBottom: 16 },
  summaryChip: {
    flex: 1, backgroundColor: T.elevated, borderRadius: 12, padding: 10,
    alignItems: 'center', borderWidth: 1, borderColor: T.border,
  },
  summaryChipLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600', marginBottom: 4, letterSpacing: 0.5 },
  summaryChipValue: { fontSize: 14, fontWeight: '900', textAlign: 'center' },
  emptyBox: { alignItems: 'center', paddingVertical: 24 },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyTitle: { color: T.textSecondary, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  emptySub: { color: T.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18, paddingHorizontal: 16 },
  row: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.elevated },
  deductBadge: {
    width: 68, borderRadius: 12, paddingVertical: 10, alignItems: 'center',
    borderWidth: 1.5, flexShrink: 0, gap: 2,
  },
  deductMin: { fontSize: 20, fontWeight: '900', lineHeight: 24 },
  deductUnit: { fontSize: 9, fontWeight: '600', letterSpacing: 0.5 },
  severityDot: { width: 5, height: 5, borderRadius: 3, marginTop: 4 },
  severityLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  detailRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' },
  sourcePill: {
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, flexShrink: 0,
  },
  sourcePillText: { fontSize: 10, fontWeight: '700' },
  offsetPill: {
    backgroundColor: T.elevated, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, borderColor: T.border,
  },
  offsetPillText: { color: T.textMuted, fontSize: 10 },
  effectiveTime: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginBottom: 3 },
  confirmedTime: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginBottom: 3 },
  reporterLine: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  footerNote: {
    backgroundColor: T.elevated, borderRadius: 10, padding: 10,
    marginTop: 12, borderWidth: 1, borderColor: T.border,
  },
  footerNoteText: { color: T.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const { profile } = useAuth();

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 100 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Section header */}
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>السجل</Text>
        <Text style={styles.pageSub}>سجل الأحداث الفعلية وتاريخ تجاوزات UNCERTAIN_ZONE</Text>
      </View>

      {/* Power events history */}
      <EventsHistorySection />

      {/* UNCERTAIN_ZONE overrun history */}
      <OverrunHistoryCard userId={profile?.id} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  pageHeader: {
    backgroundColor: T.surface, borderRadius: 16, padding: 16,
    marginBottom: 16, borderWidth: 1, borderColor: T.border,
  },
  pageTitle: { color: T.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  pageSub: { color: T.textMuted, fontSize: 12, textAlign: 'right', lineHeight: 18 },
});
