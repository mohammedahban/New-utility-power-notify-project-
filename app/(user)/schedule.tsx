import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ScrollView } from 'react-native';
import { useAuth } from '../../contexts/AuthContext';
import { useUserPredictions, UserPrediction, ShiftedScheduleSlot } from '../../hooks/useUserPredictions';
import { useResync } from '../../contexts/ResyncContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useTransitionMode } from '../../hooks/useTransitionMode';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { fmtYemenTime, durationLabelFromMin } from '../../app/(admin)/tmmsEngine';
import { SafeAreaView } from 'react-native-safe-area-context';

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

function formatTimeRangeYemen(start: string, end: string | null): string {
  if (!end) return fmtYemenTime(start);
  return `${fmtYemenTime(start)} — ${fmtYemenTime(end)}`;
}

function toYemenIsoHour(iso: string): number {
  return parseInt(
    new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden', hour: 'numeric', hour12: false,
    }),
    10,
  );
}

function formatTotalDuration(totalMin: number): string {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return `${h} ${h === 1 ? 'ساعة' : 'ساعات'}`;
  return `${h}س ${m}د`;
}

/**
 * ─── Schedule Card ───
 *
 * TMMS V2.2 additions:
 *   - If the slot is a "Generated ON" (the permanent timeline event created
 *     when an ON report is accepted), renders a "⚡ مُولّدة" badge.
 *   - If the slot is a future ON whose start time is "Estimated (Pending
 *     Offset)" because the user's offset is PENDING_NEGATIVE, renders a
 *     "تقديري (فارق معلّق)" badge.
 *   - Both badges are already set on the ShiftedScheduleSlot by
 *     useUserPredictions.ts in V2.2.
 */
function ScheduleCard({ slot, index, isCurrent, showShifted }: {
  slot: ShiftedScheduleSlot;
  index: number;
  isCurrent: boolean;
  showShifted: boolean;
}) {
  const isOn = slot.state === 'ON';
  const bg = isOn ? '#052e16' : '#2d0a0a';
  const border = isOn ? '#15803d66' : '#7f1d1d66';
  const durationColor = isOn ? T.success : T.danger;
  const durationLabel = slot.durationLabel ?? durationLabelFromMin(
    Math.round((new Date(slot.endIso ?? slot.startIso).getTime() - new Date(slot.startIso).getTime()) / 60000),
  );

  // V2.2: Determine which time to display.
  const displayStart = showShifted
    ? (slot as any).shiftedStartFormatted ?? fmtYemenTime(slot.startIso)
    : fmtYemenTime(slot.startIso);
  const displayEnd = slot.endIso
    ? (showShifted
        ? (slot as any).shiftedEndFormatted ?? fmtYemenTime(slot.endIso)
        : fmtYemenTime(slot.endIso))
    : null;

  return (
    <View style={[scStyles.card, {
      backgroundColor: bg, borderColor: border,
      opacity: isCurrent ? 1 : 0.6,
      transform: [{ scale: isCurrent ? 1 : 0.97 }],
    }]}>
      <View style={scStyles.header}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 6 }}>
          <Text style={[scStyles.state, { color: durationColor }]}>
            {isOn ? '⚡ تشغيل' : '🔴 انطفاء'}
          </Text>
          {/* V2.2: Generated ON badge */}
          {slot.isGeneratedOn && (
            <View style={[scStyles.badge, { borderColor: T.success + '55', backgroundColor: T.success + '15' }]}>
              <Text style={[scStyles.badgeText, { color: T.success }]}>⚡ مُولّدة</Text>
            </View>
          )}
          {/* V2.2: Estimated (Pending Offset) badge */}
          {slot.isEstimatedPendingOffset && (
            <View style={[scStyles.badge, { borderColor: T.warning + '55', backgroundColor: T.warning + '15' }]}>
              <Text style={[scStyles.badgeText, { color: T.warning }]}>⏳ تقديري (فارق معلّق)</Text>
            </View>
          )}
        </View>
        <Text style={[scStyles.order, { color: T.textMuted }]}>
          #{index + 1} · {slot.zone === 'DAY' ? '☀️ نهار' : '🌙 ليل'}
        </Text>
      </View>
      <Text style={scStyles.times}>
        {displayStart} — {displayEnd ?? 'مستمر'}
      </Text>
      <Text style={[scStyles.duration, { color: durationColor }]}>
        المدة: {durationLabel}
      </Text>
      {isCurrent && (
        <View style={scStyles.currentBadge}>
          <Text style={scStyles.currentBadgeText}>الحالة الحالية</Text>
        </View>
      )}
    </View>
  );
}

const scStyles = StyleSheet.create({
  card: { borderRadius: 14, padding: 14, marginBottom: 8, borderWidth: 1 },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  state: { fontSize: 16, fontWeight: '800' },
  order: { fontSize: 10, fontWeight: '600' },
  times: { color: T.textPrimary, fontSize: 13, fontWeight: '700', marginBottom: 4, textAlign: 'right' },
  duration: { fontSize: 11, fontWeight: '600' },
  badge: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1 },
  badgeText: { fontSize: 9, fontWeight: '700' },
  currentBadge: { backgroundColor: T.accent + '22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, marginTop: 6, alignSelf: 'flex-start', borderWidth: 1, borderColor: T.accent + '44' },
  currentBadgeText: { color: T.accent, fontSize: 10, fontWeight: '700' },
});

// ─── Summary ───
function Summary({ prediction }: { prediction: UserPrediction | null }) {
  const slots = prediction?.daySchedule ?? [];
  const totalOnMin = slots
    .filter(s => s.state === 'ON' && s.endIso)
    .reduce((sum, s) => sum + (new Date(s.endIso!).getTime() - new Date(s.startIso).getTime()) / 60000, 0);
  const totalOffMin = slots
    .filter(s => s.state === 'OFF' && s.endIso)
    .reduce((sum, s) => sum + (new Date(s.endIso!).getTime() - new Date(s.startIso).getTime()) / 60000, 0);
  const totalMin = totalOnMin + totalOffMin;
  const onPct = totalMin > 0 ? Math.round((totalOnMin / totalMin) * 100) : 0;
  const cycleCount = slots.filter(s => s.state === 'ON').length;

  // V2.2: show if there's a Generated ON
  const generatedOnCount = slots.filter(s => s.isGeneratedOn).length;

  return (
    <View style={sumStyles.wrap}>
      <View style={sumStyles.row}>
        <View style={sumStyles.cell}>
          <Text style={[sumStyles.val, { color: T.success }]}>{formatTotalDuration(totalOnMin)}</Text>
          <Text style={sumStyles.label}>إجمالي التشغيل</Text>
        </View>
        <View style={sumStyles.cell}>
          <Text style={[sumStyles.val, { color: T.danger }]}>{formatTotalDuration(totalOffMin)}</Text>
          <Text style={sumStyles.label}>إجمالي الانطفاء</Text>
        </View>
        <View style={sumStyles.cell}>
          <Text style={sumStyles.val}>{onPct}%</Text>
          <Text style={sumStyles.label}>نسبة التشغيل</Text>
        </View>
        <View style={sumStyles.cell}>
          <Text style={sumStyles.val}>{cycleCount}</Text>
          <Text style={sumStyles.label}>عدد الدورات</Text>
        </View>
      </View>
      {/* V2.2: Generated ON summary */}
      {generatedOnCount > 0 && (
        <View style={sumStyles.genOnRow}>
          <View style={[sumStyles.genOnBadge, { borderColor: T.success + '44', backgroundColor: T.success + '10' }]}>
            <Text style={[sumStyles.genOnText, { color: T.success }]}>
              ⚡ حالات مُولّدة: {generatedOnCount} — هذه أحداث دائمة في خطّك الزمني
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

const sumStyles = StyleSheet.create({
  wrap: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-around' },
  cell: { alignItems: 'center', flex: 1 },
  val: { color: T.textPrimary, fontSize: 16, fontWeight: '800', marginBottom: 2 },
  label: { color: T.textMuted, fontSize: 9, fontWeight: '600' },
  genOnRow: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border },
  genOnBadge: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  genOnText: { fontSize: 10, fontWeight: '700', textAlign: 'right' },
});

// ─── Main Screen ───
export default function ScheduleScreen() {
  const { offset } = useUserOffset();
  const { mode: transitionMode } = useTransitionMode();
  const { resyncPoint } = useResync();
  const { anchor } = useStateAnchor();
  const { userPrediction } = useUserPredictions(
    offset?.offset_minutes ?? 0,
    resyncPoint,
    transitionMode,
    anchor?.startIso ?? null,
  );
  const { user } = useAuth();

  const [view, setView] = useState<'timeline' | 'analysis'>('timeline');
  const [showShifted, setShowShifted] = useState(true);

  const slots = (userPrediction?.daySchedule ?? []) as ShiftedScheduleSlot[];
  const nowMs = Date.now();

  const nowIdx = slots.findIndex(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  const cycleInfo = (() => {
    if (nowIdx < 0) return null;
    const totalCycles = slots.filter(s => s.state === 'ON').length;
    const completedCycles = slots.filter((s, i) => s.state === 'ON' && i < nowIdx).length;
    return `${totalCycles} دورة · مكتمل ${completedCycles} · الحالية ${nowIdx + 1}`;
  })();

  // V2.2: Offset State display
  const offsetStateLabel = userPrediction?.offsetState ?? null;
  const offsetValueLabel = userPrediction?.offsetValue ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg }} edges={['top']}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>📅 جدول الكهرباء</Text>
          {cycleInfo && <Text style={styles.cycleInfo}>{cycleInfo}</Text>}
          {/* V2.2: Offset state indicator */}
          {offsetStateLabel && (
            <View style={styles.offsetRow}>
              <View style={[styles.offsetChip, {
                borderColor: offsetStateLabel === 'POSITIVE' ? T.success + '44'
                  : offsetStateLabel === 'NEGATIVE' ? T.warning + '44'
                  : offsetStateLabel === 'PENDING_NEGATIVE' ? T.warning + '44'
                  : T.textMuted + '44',
                backgroundColor: offsetStateLabel === 'POSITIVE' ? T.success + '10'
                  : offsetStateLabel === 'NEGATIVE' ? T.warning + '10'
                  : offsetStateLabel === 'PENDING_NEGATIVE' ? T.warning + '10'
                  : T.textMuted + '10',
              }]}>
                <Text style={[styles.offsetChipText, {
                  color: offsetStateLabel === 'POSITIVE' ? T.success
                    : offsetStateLabel === 'NEGATIVE' ? T.warning
                    : offsetStateLabel === 'PENDING_NEGATIVE' ? T.warning
                    : T.textMuted,
                }]}>
                  {offsetStateLabel === 'POSITIVE' ? 'فارق إيجابي'
                    : offsetStateLabel === 'NEGATIVE' ? 'فارق سلبي'
                    : offsetStateLabel === 'PENDING_NEGATIVE' ? 'فارق معلَّق'
                    : offsetStateLabel === 'NEUTRAL' ? 'فارق محايد'
                    : offsetStateLabel}
                  {offsetValueLabel !== null && offsetValueLabel !== undefined
                    ? (offsetValueLabel === 'PENDING' || offsetStateLabel === 'PENDING_NEGATIVE'
                        ? ' · بانتظار Growatt'
                        : ` · ${(offsetValueLabel as number) > 0 ? '+' : ''}${offsetValueLabel}د`)
                    : ''}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Controls */}
        <View style={styles.controls}>
          <View style={styles.viewToggle}>
            <TouchableOpacity style={[styles.viewBtn, view === 'analysis' && styles.viewBtnActive]} onPress={() => setView('analysis')} activeOpacity={0.8}>
              <Text style={[styles.viewBtnText, view === 'analysis' && styles.viewBtnTextActive]}>📊 تحليل</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.viewBtn, view === 'timeline' && styles.viewBtnActive]} onPress={() => setView('timeline')} activeOpacity={0.8}>
              <Text style={[styles.viewBtnText, view === 'timeline' && styles.viewBtnTextActive]}>⏰ الجدول</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity
            style={[styles.shiftToggle, { borderColor: showShifted ? T.accent + '55' : T.border }]}
            onPress={() => setShowShifted(v => !v)}
            activeOpacity={0.8}
          >
            <Text style={[styles.shiftToggleText, { color: showShifted ? T.accent : T.textMuted }]}>
              {showShifted ? '⏱ الفارق مفعَّل' : '⏱ الفارق معطّل'}
            </Text>
          </TouchableOpacity>
        </View>

        {/* V2.2: Generated ON explanation */}
        <View style={styles.infoBox}>
          <Text style={styles.infoText}>
            ⚡ = حالة تشغيل مُولّدة (بلاغ حقيقي) · ⏳ = فارق معلّق (تقديري حتى تحوّل Growatt)
          </Text>
        </View>

        {view === 'timeline' ? (
          <FlatList
            data={slots}
            keyExtractor={(_, i) => `slot-${i}`}
            contentContainerStyle={styles.list}
            ListHeaderComponent={<Summary prediction={userPrediction} />}
            renderItem={({ item, index }) => (
              <ScheduleCard
                slot={item}
                index={index}
                isCurrent={index === nowIdx}
                showShifted={showShifted}
              />
            )}
            ListEmptyComponent={
              <View style={styles.emptyBox}>
                <Text style={{ fontSize: 48, marginBottom: 14 }}>📅</Text>
                <Text style={styles.emptyTitle}>لا يوجد جدول متاح</Text>
                <Text style={styles.emptySub}>يستمر التطبيق في تحليل أنماط الكهرباء.</Text>
              </View>
            }
          />
        ) : (
          <AnalysisView prediction={userPrediction} />
        )}
      </View>
    </SafeAreaView>
  );
}

// ─── Analysis View ───
function AnalysisView({ prediction }: { prediction: UserPrediction | null }) {
  const apppe = prediction?.apppe;
  if (!apppe) {
    return (
      <View style={styles.emptyBox}>
        <Text style={{ fontSize: 48, marginBottom: 14 }}>📊</Text>
        <Text style={styles.emptyTitle}>لا توجد بيانات تحليلية</Text>
        <Text style={styles.emptySub}>يستمر التطبيق في جمع البيانات.</Text>
      </View>
    );
  }

  const { dayPattern, nightPattern } = prediction;
  const q = apppe.predictionQuality;

  const QualityRow = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <View style={aStyles.qualityRow}>
      <Text style={[aStyles.qualityVal, { color }]}>{Math.round(value * 100)}%</Text>
      <View style={[aStyles.qualityBar, { backgroundColor: T.elevated }]}>
        <View style={[aStyles.qualityFill, { width: `${Math.round(value * 100)}%`, backgroundColor: color }]} />
      </View>
      <Text style={aStyles.qualityLabel}>{label}</Text>
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.list}>
      <Summary prediction={prediction} />
      <View style={aStyles.section}>
        <Text style={aStyles.sectionTitle}>🎯 جودة التوقع</Text>
        <Text style={aStyles.sectionSub}>APPPE v4 — {apppe.historySource}</Text>
        <QualityRow label="كمية البيانات" value={q.dataQuantityFactor} color={T.accent} />
        <QualityRow label="استقرار الأنماط" value={q.stabilityFactor} color={T.success} />
        <QualityRow label="استقرار الانحراف" value={q.driftStabilityFactor} color={T.warning} />
        <QualityRow label="استقرار الانحياز" value={q.biasStabilityFactor} color={T.primary} />
        <QualityRow label="التقلب" value={q.volatilityFactor} color={T.danger} />
        <QualityRow label="أزمة" value={q.crisisFactor} color={T.danger} />
        <View style={aStyles.totalRow}>
          <Text style={aStyles.totalVal}>{prediction.confidence}%</Text>
          <Text style={aStyles.totalLabel}>الثقة الإجمالية</Text>
        </View>
      </View>
      <View style={aStyles.section}>
        <Text style={aStyles.sectionTitle}>⚙️ تكوين المحرك</Text>
        <View style={aStyles.row2}>
          <View style={aStyles.cell2}>
            <Text style={aStyles.cell2Val}>{apppe.driftSampleCount}</Text>
            <Text style={aStyles.cell2Label}>عينات الانحراف</Text>
          </View>
          <View style={aStyles.cell2}>
            <Text style={aStyles.cell2Val}>{apppe.biasSampleCount}</Text>
            <Text style={aStyles.cell2Label}>عينات الانحياز</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const aStyles = StyleSheet.create({
  section: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  sectionTitle: { color: T.textPrimary, fontSize: 16, fontWeight: '800', marginBottom: 6, textAlign: 'right' },
  sectionSub: { color: T.textMuted, fontSize: 11, marginBottom: 14, textAlign: 'right' },
  qualityRow: { flexDirection: 'row-reverse', alignItems: 'center', marginBottom: 10, gap: 10 },
  qualityLabel: { color: T.textSecondary, fontSize: 12, width: 80, textAlign: 'right' },
  qualityBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  qualityFill: { height: 6, borderRadius: 3 },
  qualityVal: { fontSize: 12, fontWeight: '700', width: 40, textAlign: 'right' },
  totalRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.border },
  totalLabel: { color: T.textPrimary, fontSize: 14, fontWeight: '800' },
  totalVal: { color: T.accent, fontSize: 18, fontWeight: '900' },
  row2: { flexDirection: 'row-reverse', gap: 10 },
  cell2: { flex: 1, backgroundColor: T.elevated, borderRadius: 10, padding: 12, alignItems: 'center' },
  cell2Val: { color: T.textPrimary, fontSize: 16, fontWeight: '800' },
  cell2Label: { color: T.textMuted, fontSize: 10, marginTop: 4 },
});

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  header: { paddingVertical: 12 },
  headerTitle: { color: T.textPrimary, fontSize: 18, fontWeight: '800', textAlign: 'right' },
  cycleInfo: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginTop: 4 },
  offsetRow: { flexDirection: 'row-reverse', marginTop: 6 },
  offsetChip: { borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1 },
  offsetChipText: { fontSize: 10, fontWeight: '700' },
  controls: { flexDirection: 'row-reverse', alignItems: 'center', marginBottom: 12, gap: 10 },
  viewToggle: { flexDirection: 'row-reverse', backgroundColor: T.surface, borderRadius: 10, padding: 3, borderWidth: 1, borderColor: T.border },
  viewBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8 },
  viewBtnActive: { backgroundColor: T.primary + '33' },
  viewBtnText: { color: T.textMuted, fontSize: 12, fontWeight: '600' },
  viewBtnTextActive: { color: T.accent, fontWeight: '700' },
  shiftToggle: { flex: 1, borderRadius: 10, paddingVertical: 7, borderWidth: 1, alignItems: 'center' },
  shiftToggleText: { fontSize: 11, fontWeight: '700' },
  infoBox: { backgroundColor: T.surface, borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  infoText: { color: T.textMuted, fontSize: 10, textAlign: 'right' },
  list: { paddingBottom: 32 },
  emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: T.textSecondary, fontSize: 18, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 22 },
});
