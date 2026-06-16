import React, { useMemo, useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePredictions, Prediction, PatternStats } from '../../hooks/usePredictions';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';
import { applyOffsetToPrediction, ScheduleStateMode } from '../../hooks/useUserPredictions';

// ── Latest Accuracy Pill ──────────────────────────────────────────────────────
interface LatestAccuracyEntry {
  accuracy_score: number;
  error_minutes: number;
  predicted_state: string;
  created_at: string;
}

function useLatestAccuracy() {
  const [entry, setEntry] = useState<LatestAccuracyEntry | null>(null);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const { data } = await supabase
        .from('prediction_accuracy_logs')
        .select('accuracy_score, error_minutes, predicted_state, created_at')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setEntry(data as LatestAccuracyEntry | null);
    } catch { /* non-fatal */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); }, [fetch]);
  return { entry, loading, refetch: fetch };
}

function LatestAccuracyPill({ onPress }: { onPress?: () => void }) {
  const { entry, loading } = useLatestAccuracy();

  if (loading) {
    return (
      <View style={lapStyles.pill}>
        <ActivityIndicator size="small" color="#64748b" />
      </View>
    );
  }

  if (!entry) return null;

  const score = Math.round(entry.accuracy_score);
  const errorMin = Math.round(entry.error_minutes);
  const color = score >= 85 ? '#22c55e' : score >= 65 ? '#f59e0b' : '#ef4444';
  const isOn = entry.predicted_state === 'UTILITY_ON';
  const stateIcon = isOn ? '⚡' : '🔴';
  const timeAgo = Math.round((Date.now() - new Date(entry.created_at).getTime()) / 60_000);
  const timeLabel = timeAgo < 60 ? `${timeAgo}د` : `${Math.round(timeAgo / 60)}س`;

  return (
    <TouchableOpacity
      style={[lapStyles.pill, { borderColor: color + '55', backgroundColor: color + '12' }]}
      onPress={onPress}
      activeOpacity={0.8}
    >
      <Text style={lapStyles.sub}>آخر دقة · {timeLabel} مضت</Text>
      <View style={lapStyles.row}>
        <Text style={lapStyles.error}>{errorMin}د خطأ</Text>
        <Text style={lapStyles.sep}>·</Text>
        <Text style={lapStyles.state}>{stateIcon}</Text>
        <Text style={[lapStyles.score, { color }]}>{score}%</Text>
        <Text style={lapStyles.label}>دقة التوقع</Text>
      </View>
    </TouchableOpacity>
  );
}

const lapStyles = StyleSheet.create({
  pill: {
    borderRadius: 14, borderWidth: 1, borderColor: '#334155',
    paddingHorizontal: 14, paddingVertical: 10, marginBottom: 12,
    backgroundColor: '#1e293b',
  },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  label: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 0.8, flex: 1, textAlign: 'right' },
  score: { fontSize: 18, fontWeight: '900' },
  state: { fontSize: 14 },
  sep: { color: '#334155', fontSize: 12 },
  error: { color: '#64748b', fontSize: 11, fontWeight: '600' },
  sub: { color: '#475569', fontSize: 10, textAlign: 'right', marginBottom: 4 },
});

// ── ATC System-Wide Indicator ─────────────────────────────────────────────────
function ATCSystemIndicator({ prediction }: { prediction: Prediction | null }) {
  const [userCount, setUserCount] = useState<number>(0);
  const [avgOffset, setAvgOffset] = useState<number>(0);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('user_offsets')
        .select('offset_minutes');
      if (data && data.length > 0) {
        setUserCount(data.length);
        const avg = data.reduce((s: number, r: any) => s + (r.offset_minutes ?? 0), 0) / data.length;
        setAvgOffset(Math.round(avg));
      }
    })();
  }, []);

  if (!prediction) return null;

  // Simulate ATC state for "neutral offset" user (most common case)
  const samplePrediction = applyOffsetToPrediction(prediction, 0, null);
  const sampleNeg = applyOffsetToPrediction(prediction, -45, null);
  const samplePos = applyOffsetToPrediction(prediction, 45, null);

  const modeColors: Record<ScheduleStateMode, string> = {
    NORMAL: '#22c55e',
    PREDICTION_RANGE: '#38bdf8',
    UNCERTAIN_ZONE: '#f59e0b',
    COMMUNITY_SYNCED: '#a78bfa',
    WAITING_FOR_GROWATT: '#3b82f6',
    GRACE_MODE: '#f97316',
  };
  const modeIcons: Record<ScheduleStateMode, string> = {
    NORMAL: '✅',
    PREDICTION_RANGE: '🔮',
    UNCERTAIN_ZONE: '⚠️',
    COMMUNITY_SYNCED: '👥',
    WAITING_FOR_GROWATT: '⏳',
    GRACE_MODE: '⏳',
  };

  const rows: { label: string; mode: ScheduleStateMode; overrun: number }[] = [
    { label: 'فارق صفري (0د)', mode: samplePrediction.atc.mode, overrun: samplePrediction.atc.overrunMinutes },
    { label: 'فارق سالب (-45د)', mode: sampleNeg.atc.mode, overrun: sampleNeg.atc.overrunMinutes },
    { label: 'فارق موجب (+45د)', mode: samplePos.atc.mode, overrun: samplePos.atc.overrunMinutes },
  ];

  return (
    <View style={atcSysStyles.card}>
      <View style={atcSysStyles.header}>
        <Text style={atcSysStyles.subtitle}>{userCount} مستخدم · متوسط الفارق {avgOffset > 0 ? '+' : ''}{avgOffset}د</Text>
        <Text style={atcSysStyles.title}>🎛️ ATC — حالة النظام</Text>
      </View>
      {rows.map((r, i) => (
        <View key={i} style={atcSysStyles.row}>
          <View style={atcSysStyles.right}>
            {r.overrun > 0 && (
              <Text style={atcSysStyles.overrun}>تجاوز: {Math.round(r.overrun)}د</Text>
            )}
            <View style={[atcSysStyles.modeBadge, { borderColor: modeColors[r.mode] + '55', backgroundColor: modeColors[r.mode] + '18' }]}>
              <Text style={[atcSysStyles.modeText, { color: modeColors[r.mode] }]}>
                {modeIcons[r.mode]} {r.mode}
              </Text>
            </View>
          </View>
          <Text style={atcSysStyles.label}>{r.label}</Text>
        </View>
      ))}
      <Text style={atcSysStyles.note}>المحاكاة بناءً على التوقعات الحالية. الحالة الفعلية تعتمد على فارق كل مستخدم.</Text>
    </View>
  );
}
const atcSysStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginBottom: 12, borderRightWidth: 3, borderRightColor: '#a78bfa' },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  subtitle: { color: '#475569', fontSize: 10 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#0f172a' },
  label: { color: '#64748b', fontSize: 12 },
  right: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  modeBadge: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  modeText: { fontSize: 11, fontWeight: '700' },
  overrun: { color: '#f59e0b', fontSize: 10, fontWeight: '600' },
  note: { color: '#334155', fontSize: 10, textAlign: 'right', marginTop: 10, lineHeight: 15 },
});

function ConfidenceMeter({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 88 ? '#22c55e' : pct >= 72 ? '#38bdf8' : pct >= 52 ? '#f59e0b' : '#ef4444';
  return (
    <View style={confStyles.wrap}>
      <View style={confStyles.header}>
        <Text style={[confStyles.pct, { color }]}>{pct}%</Text>
        <Text style={confStyles.label}>{AR.predictionConfidence}</Text>
      </View>
      <View style={confStyles.track}>
        <View style={[confStyles.fill, { width: `${Math.min(100, pct)}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={[confStyles.levelLabel, { color }]}>{label}</Text>
    </View>
  );
}
const confStyles = StyleSheet.create({
  wrap: { marginBottom: 18 },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 6 },
  label: { color: '#94a3b8', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  pct: { fontSize: 14, fontWeight: '800' },
  track: { height: 8, backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden', marginBottom: 4 },
  fill: { height: 8, borderRadius: 4 },
  levelLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, textAlign: 'right' },
});

function Card({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <View style={[cardStyles.card, accent ? { borderRightColor: accent, borderRightWidth: 3 } : {}]}>
      <Text style={cardStyles.title}>{title}</Text>
      {children}
    </View>
  );
}
const cardStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12 },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 14, textAlign: 'right' },
});

function StatRow({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={statStyles.row}>
      <View style={{ alignItems: 'flex-start' }}>
        <Text style={[statStyles.value, color ? { color } : {}]}>{value}</Text>
        {sub ? <Text style={statStyles.sub}>{sub}</Text> : null}
      </View>
      <Text style={statStyles.label}>{label}</Text>
    </View>
  );
}
const statStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  label: { color: '#64748b', fontSize: 13, textAlign: 'right' },
  value: { color: '#e2e8f0', fontSize: 13, fontWeight: '700', textAlign: 'left' },
  sub: { color: '#475569', fontSize: 10, marginTop: 1, textAlign: 'left' },
});

function PatternBlock({ title, stats }: { title: string; stats: PatternStats | null }) {
  if (!stats || stats.cycles === 0) {
    return (
      <View style={pbStyles.empty}>
        <Text style={pbStyles.emptyTitle}>{title}</Text>
        <Text style={pbStyles.emptyText}>{AR.noData}</Text>
      </View>
    );
  }
  const fmtMin = (min: number) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h === 0) return `${m}د`;
    if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
    return `${h}س ${m}د`;
  };
  return (
    <View style={pbStyles.block}>
      <Text style={pbStyles.title}>{title}</Text>
      <Text style={pbStyles.cycles}>{stats.cycles} {stats.cycles === 1 ? AR.cycleWord : AR.cyclesWord}</Text>
      <View style={pbStyles.row}>
        <View style={pbStyles.cell}>
          {stats.stdDevOnMin !== null && <Text style={pbStyles.cellSub}>±{fmtMin(stats.stdDevOnMin)}</Text>}
          <Text style={[pbStyles.cellValue, { color: '#22c55e' }]}>{stats.avgOnMin !== null ? fmtMin(stats.avgOnMin) : '—'}</Text>
          <Text style={pbStyles.cellLabel}>{AR.avgOnLabel}</Text>
          <View style={[pbStyles.dot, { backgroundColor: '#22c55e' }]} />
        </View>
        <View style={pbStyles.divider} />
        <View style={pbStyles.cell}>
          <Text style={pbStyles.cellSub}>±{fmtMin(stats.stdDevOffMin)}</Text>
          <Text style={[pbStyles.cellValue, { color: '#ef4444' }]}>{fmtMin(stats.avgOffMin)}</Text>
          <Text style={pbStyles.cellLabel}>{AR.avgOffLabel}</Text>
          <View style={[pbStyles.dot, { backgroundColor: '#ef4444' }]} />
        </View>
      </View>
    </View>
  );
}
const pbStyles = StyleSheet.create({
  block: { backgroundColor: '#0f172a', borderRadius: 12, padding: 14, flex: 1 },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', marginBottom: 2, textAlign: 'right' },
  cycles: { color: '#475569', fontSize: 10, marginBottom: 10, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', alignItems: 'stretch', gap: 8 },
  cell: { flex: 1, alignItems: 'center' },
  dot: { width: 6, height: 6, borderRadius: 3, marginBottom: 4 },
  cellLabel: { color: '#64748b', fontSize: 10, marginBottom: 2 },
  cellValue: { fontSize: 14, fontWeight: '800' },
  cellSub: { color: '#475569', fontSize: 10, marginTop: 1 },
  divider: { width: 1, backgroundColor: '#1e293b', alignSelf: 'stretch' },
  empty: { flex: 1, backgroundColor: '#0f172a', borderRadius: 12, padding: 14, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: '#64748b', fontSize: 11, fontWeight: '700', marginBottom: 4 },
  emptyText: { color: '#475569', fontSize: 11 },
});

function ProfileBlendCard({ apppe }: { apppe: NonNullable<Prediction['apppe']> }) {
  const driftColor = apppe.driftOffset === 0 ? '#22c55e' : Math.abs(apppe.driftOffset) < 20 ? '#f59e0b' : '#ef4444';
  const biasColor = Math.abs(1 - apppe.biasRatio) < 0.05 ? '#22c55e' : Math.abs(1 - apppe.biasRatio) < 0.15 ? '#f59e0b' : '#ef4444';
  const volColor = apppe.volatilityLabel === 'Low' ? '#22c55e' : apppe.volatilityLabel === 'Moderate' ? '#f59e0b' : '#ef4444';
  const trustPct = apppe.learningStrength ?? 0;
  const trustColor = trustPct >= 70 ? '#22c55e' : trustPct >= 40 ? '#f59e0b' : '#f97316';

  const fmtOffset = (min: number) => {
    if (min === 0) return 'لا انحراف';
    const sign = min > 0 ? '+' : '';
    const h = Math.floor(Math.abs(min) / 60);
    const m = Math.round(Math.abs(min) % 60);
    const durStr = h > 0 ? (m > 0 ? `${h}س ${m}د` : `${h}س`) : `${m}د`;
    return `${sign}${min > 0 ? '' : '-'}${durStr}`;
  };

  return (
    <View style={ppStyles.card}>
      <View style={ppStyles.headerRow}>
        <View style={[ppStyles.versionBadge, apppe.crisisActive && ppStyles.crisisBadge]}>
          <Text style={[ppStyles.versionText, apppe.crisisActive && ppStyles.crisisText]}>
            {apppe.crisisActive ? '⚠️ وضع الأزمة' : `APPPE v${apppe.version}`}
          </Text>
        </View>
        <Text style={ppStyles.cardTitle}>محركات التعلم التكيّفي</Text>
      </View>

      {apppe.crisisActive && apppe.crisisReason ? (
        <View style={ppStyles.crisisBox}>
          <Text style={ppStyles.crisisReason}>{apppe.crisisReason}</Text>
        </View>
      ) : null}

      {/* Learning Trust Bar */}
      <View style={ppStyles.trustRow}>
        <Text style={[ppStyles.trustPct, { color: trustColor }]}>{trustPct}%</Text>
        <View style={ppStyles.trustTrack}>
          <View style={[ppStyles.trustFill, { width: `${trustPct}%` as any, backgroundColor: trustColor }]} />
        </View>
        <Text style={ppStyles.trustLabel}>قوة التعلم · {(apppe.effectiveWeightedSamples ?? 0).toFixed(1)} عينة مرجّحة</Text>
      </View>

      {/* Metric Rows */}
      {[
        {
          icon: '📐',
          label: 'انحراف التوقيت',
          value: fmtOffset(apppe.driftOffset),
          sub: `${apppe.driftSampleCount} حدث`,
          color: driftColor,
        },
        {
          icon: '⚖️',
          label: 'تحيّز المدة',
          value: `×${apppe.biasRatio?.toFixed(2) ?? '1.00'}`,
          sub: `${apppe.biasSampleCount} حدث`,
          color: biasColor,
        },
        {
          icon: '📈',
          label: 'تذبذب التوقع',
          value: apppe.volatilityLabel === 'Low' ? 'منخفض' : apppe.volatilityLabel === 'Moderate' ? 'متوسط' : apppe.volatilityLabel === 'Elevated' ? 'مرتفع' : 'عالٍ جداً',
          sub: `EMA ${(apppe.volatilityEMA ?? 0).toFixed(0)} د`,
          color: volColor,
        },
        {
          icon: '🔀',
          label: 'انحراف: انقطاع',
          value: apppe.madOff != null ? `${apppe.madOff}د` : '—',
          sub: 'MAD',
          color: '#94a3b8',
        },
        {
          icon: '🔀',
          label: 'انحراف: تشغيل',
          value: apppe.madOn != null ? `${apppe.madOn}د` : '—',
          sub: 'MAD',
          color: '#94a3b8',
        },
      ].map((item, i) => (
        <View key={i} style={ppStyles.metricRow}>
          <View style={ppStyles.metricRight}>
            <Text style={[ppStyles.metricValue, { color: item.color }]}>{item.value}</Text>
            <Text style={ppStyles.metricSub}>{item.sub}</Text>
          </View>
          <View style={ppStyles.metricLeft}>
            <Text style={ppStyles.metricIcon}>{item.icon}</Text>
            <Text style={ppStyles.metricLabel}>{item.label}</Text>
          </View>
        </View>
      ))}

      {apppe.crisisActive && apppe.crisisShift && (
        <View style={ppStyles.shiftRow}>
          <Text style={ppStyles.shiftText}>
            إزاحة الأزمة — انقطاع: {apppe.crisisShift.off > 0 ? '+' : ''}{apppe.crisisShift.off}د
            {'  '}تشغيل: {apppe.crisisShift.on > 0 ? '+' : ''}{apppe.crisisShift.on}د
          </Text>
        </View>
      )}
    </View>
  );
}

const ppStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderRightWidth: 3, borderRightColor: '#38bdf8' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  versionBadge: { backgroundColor: '#0f172a', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#334155' },
  crisisBadge: { borderColor: '#f59e0b', backgroundColor: '#1a0e00' },
  versionText: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  crisisText: { color: '#f59e0b', fontWeight: '700' },
  crisisBox: { backgroundColor: '#1a0e00', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#78350f' },
  crisisReason: { color: '#fbbf24', fontSize: 12, lineHeight: 18, textAlign: 'right' },
  trustRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 14 },
  trustLabel: { color: '#64748b', fontSize: 10, flex: 1, textAlign: 'right' },
  trustPct: { fontSize: 13, fontWeight: '800', minWidth: 36, textAlign: 'left' },
  trustTrack: { flex: 1, height: 6, backgroundColor: '#0f172a', borderRadius: 3, overflow: 'hidden' },
  trustFill: { height: 6, borderRadius: 3 },
  metricRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 9, borderTopWidth: 1, borderTopColor: '#0f172a' },
  metricLeft: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  metricIcon: { fontSize: 14 },
  metricLabel: { color: '#64748b', fontSize: 13 },
  metricRight: { alignItems: 'flex-start' },
  metricValue: { fontSize: 14, fontWeight: '800' },
  metricSub: { color: '#475569', fontSize: 10, marginTop: 1 },
  shiftRow: { marginTop: 10, backgroundColor: '#1a0e00', borderRadius: 8, padding: 10, borderWidth: 1, borderColor: '#78350f' },
  shiftText: { color: '#f59e0b', fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

function LearningProgressCard({ prediction }: { prediction: Prediction }) {
  const TARGET_DAYS = 7;
  const mode = prediction.learningMode;
  const effectiveSamples = prediction.apppe?.effectiveWeightedSamples ?? 0;
  const maxSamples = effectiveSamples;
  const CYCLES_PER_DAY = 3.5;
  const estimatedDays = Math.min(TARGET_DAYS, Math.round(effectiveSamples / CYCLES_PER_DAY * 10) / 10);
  const progressPct = Math.min(100, Math.round((estimatedDays / TARGET_DAYS) * 100));

  const modeColor = mode === 'learned' ? '#22c55e' : mode === 'hybrid' ? '#38bdf8' : '#f59e0b';
  const modeIcon = mode === 'learned' ? '🧠' : mode === 'hybrid' ? '📊' : '📐';
  const modeLabel = mode === 'learned' ? AR.learnedMode : mode === 'hybrid' ? AR.hybridMode : AR.priorOnly;
  const modeDesc = mode === 'learned' ? AR.learnedDesc : mode === 'hybrid' ? AR.hybridDesc : AR.priorOnlyDesc;

  const milestones = [
    { label: 'هجين', day: 3, pct: Math.round((3 / TARGET_DAYS) * 100) },
    { label: 'مُتعلَّم', day: TARGET_DAYS, pct: 100 },
  ];

  return (
    <View style={lpStyles.card}>
      <View style={lpStyles.headerRow}>
        <View style={[lpStyles.modeBadge, { borderColor: modeColor + '55', backgroundColor: modeColor + '18' }]}>
          <Text style={[lpStyles.modeLabel, { color: modeColor }]}>{modeLabel}</Text>
          <Text style={lpStyles.modeIcon}>{modeIcon}</Text>
        </View>
        <Text style={lpStyles.cardTitle}>{AR.learningProgress}</Text>
      </View>

      <View style={lpStyles.daysRow}>
        <Text style={lpStyles.daysLabel}> {AR.daysOfRealData}</Text>
        <Text style={lpStyles.daysTarget}>{TARGET_DAYS}</Text>
        <Text style={lpStyles.daysSep}> / </Text>
        <Text style={[lpStyles.daysValue, { color: modeColor }]}>{estimatedDays.toFixed(1)}</Text>
      </View>

      <View style={lpStyles.trackWrap}>
        <View style={lpStyles.track}>
          <View style={[lpStyles.fill, { width: `${progressPct}%` as any, backgroundColor: modeColor }]} />
        </View>
        {milestones.map((m) => (
          <View key={m.label} style={[lpStyles.milestone, { left: `${m.pct}%` as any }]}>
            <View style={[lpStyles.milestoneTick, { backgroundColor: estimatedDays >= m.day ? modeColor : '#334155' }]} />
            <Text style={[lpStyles.milestoneLabel, { color: estimatedDays >= m.day ? modeColor : '#475569' }]}>{m.label}</Text>
          </View>
        ))}
      </View>

      <Text style={lpStyles.modeDesc}>{modeDesc}</Text>
      {effectiveSamples > 0 && (
        <Text style={lpStyles.sampleNote}>
          {effectiveSamples.toFixed(1)} {AR.cyclesWord} — {AR.totalCycles}
        </Text>
      )}
    </View>
  );
}

const lpStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderRightWidth: 3, borderRightColor: '#22c55e' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  modeBadge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  modeIcon: { fontSize: 13 },
  modeLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  daysRow: { flexDirection: 'row-reverse', alignItems: 'baseline', marginBottom: 14 },
  daysValue: { fontSize: 36, fontWeight: '900' },
  daysSep: { color: '#475569', fontSize: 22, fontWeight: '300' },
  daysTarget: { color: '#94a3b8', fontSize: 26, fontWeight: '700' },
  daysLabel: { color: '#64748b', fontSize: 13, marginRight: 4, marginBottom: 2 },
  trackWrap: { position: 'relative', marginBottom: 28 },
  track: { height: 8, backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden', marginBottom: 0 },
  fill: { height: 8, borderRadius: 4 },
  milestone: { position: 'absolute', top: -1, transform: [{ translateX: -12 }], alignItems: 'center' },
  milestoneTick: { width: 2, height: 12, borderRadius: 1, marginBottom: 3 },
  milestoneLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  modeDesc: { color: '#64748b', fontSize: 12, lineHeight: 18, marginBottom: 6, textAlign: 'right' },
  sampleNote: { color: '#334155', fontSize: 10, marginTop: 2, textAlign: 'right' },
});

export default function AdminPredictions() {
  const { prediction, computedAt, loading } = usePredictions();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = React.useState(false);
  const [autoRefreshing, setAutoRefreshing] = React.useState(false);

  const triggerRefresh = React.useCallback(async () => {
    setRefreshing(true);
    try { await supabase.functions.invoke('analyze-patterns', { body: {} }); } catch (_) {}
    setTimeout(() => setRefreshing(false), 2000);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setAutoRefreshing(true);
      try { await supabase.functions.invoke('analyze-patterns', { body: {} }); } catch (_) {}
      if (!cancelled) setAutoRefreshing(false);
    };
    run();
    return () => { cancelled = true; };
  }, []);

  const computedLabel = useMemo(() => {
    if (!computedAt) return null;
    return new Date(computedAt).toLocaleString('ar-SA', { timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short' });
  }, [computedAt]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color="#38bdf8" /><Text style={styles.loadingText}>{AR.analyzingPatterns}</Text></View>;
  }


  const showAutoRefreshBanner = autoRefreshing && !refreshing;

  if (!prediction) {
    return (
      <View style={styles.centered}>
        <Text style={styles.noDataIcon}>📊</Text>
        <Text style={styles.noDataTitle}>{AR.noAnalysisYet}</Text>
        <Text style={styles.noDataBody}>{AR.pullToTrigger}</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={triggerRefresh}>
          <Text style={styles.refreshBtnText}>{AR.runAnalysisNow}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isOn = prediction.currentState === 'ON';
  const fmtDur = (label: string) => label || '—';
  const periodLabel = prediction.currentPeriod === 'day' ? AR.dayTime : AR.nightTime;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={triggerRefresh} tintColor="#38bdf8" />}
    >
      {showAutoRefreshBanner && (
        <View style={styles.autoRefreshBanner}>
          <Text style={styles.autoRefreshText}>{AR.fetchingLatest}</Text>
          <ActivityIndicator size="small" color="#38bdf8" style={{ marginLeft: 8 }} />
        </View>
      )}

      <LatestAccuracyPill />

      <View style={[styles.stateBar, { borderColor: isOn ? '#22c55e' : '#ef4444' }]}>
        <Text style={styles.stateBarLabel}>{AR.currentState}</Text>
        <Text style={[styles.stateBarValue, { color: isOn ? '#22c55e' : '#ef4444' }]}>{isOn ? '⚡ ' + AR.gridOn : '🔴 ' + AR.gridOff}</Text>
        <Text style={styles.stateBarDur}>{AR.for} {fmtDur(prediction.currentStateDurationLabel)} · {periodLabel}</Text>
        <ConfidenceMeter pct={prediction.confidence} label={prediction.confidenceLabel} />
      </View>

      {prediction.nextTransition ? (
        <Card title={AR.nextTransitionCard} accent={prediction.nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444'}>
          <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <View>
              <Text style={[{ fontSize: 18, fontWeight: '800', textAlign: 'right' }, { color: prediction.nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444' }]}>
                {prediction.nextTransition.type === 'UTILITY_ON' ? AR.gridWillTurnOn : AR.gridWillTurnOff}
              </Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 2, textAlign: 'right' }}>{prediction.nextTransition.rangeLabel}</Text>
            </View>
            <Text style={{ fontSize: 28 }}>{prediction.nextTransition.type === 'UTILITY_ON' ? '⚡' : '🔴'}</Text>
          </View>
        </Card>
      ) : null}

      <Card title={AR.dayNightPatterns}>
        <Text style={styles.patternNote}>{prediction.cyclesAnalyzed} {AR.cyclesAnalyzed} — {prediction.dayCyclesAnalyzed} {AR.dayLabel} · {prediction.nightCyclesAnalyzed} {AR.nightLabel}</Text>
        <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
          <PatternBlock title={AR.nightPattern} stats={prediction.nightPattern} />
          <PatternBlock title={AR.dayPattern} stats={prediction.dayPattern} />
        </View>
      </Card>

      <Card title={AR.patternStabilityCard} accent={prediction.stabilityScore >= 75 ? '#22c55e' : prediction.stabilityScore >= 45 ? '#f59e0b' : '#ef4444'}>
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center' }}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={{ color: prediction.stabilityScore >= 75 ? '#22c55e' : prediction.stabilityScore >= 45 ? '#f59e0b' : '#ef4444', fontSize: 14, fontWeight: '700', marginBottom: 4, textAlign: 'right' }}>
              {prediction.stabilityLabel === 'Stable' ? AR.stableDesc : prediction.stabilityLabel === 'Slightly Unstable' ? AR.slightlyUnstableDesc : AR.unstableDesc}
            </Text>
            <Text style={{ color: '#64748b', fontSize: 12, lineHeight: 18, textAlign: 'right' }}>
              {prediction.stabilityScore >= 75 ? AR.stableDesc : prediction.stabilityScore >= 45 ? AR.slightlyUnstableDesc : AR.unstableDesc}
            </Text>
          </View>
          <Text style={{ color: '#e2e8f0', fontSize: 40, fontWeight: '800', width: 72, textAlign: 'center' }}>{prediction.stabilityScore}%</Text>
        </View>
      </Card>

      {prediction.apppe && <ProfileBlendCard apppe={prediction.apppe} />}

      <ATCSystemIndicator prediction={prediction} />

      <LearningProgressCard prediction={prediction} />

      <Card title={AR.analysisReasoning}>
        {prediction.reasoning.map((r, i) => (
          <View key={i} style={{ flexDirection: 'row-reverse', gap: 8, marginBottom: 8 }}>
            <Text style={{ color: '#94a3b8', fontSize: 13, flex: 1, lineHeight: 19, textAlign: 'right' }}>{r}</Text>
            <Text style={{ color: '#38bdf8', fontSize: 14, marginTop: 1 }}>›</Text>
          </View>
        ))}
        {computedLabel ? <Text style={{ color: '#334155', fontSize: 11, marginTop: 8, textAlign: 'right' }}>{AR.lastComputed} {computedLabel} (اليمن)</Text> : null}
      </Card>

      <TouchableOpacity style={styles.reanalyzeBtn} onPress={triggerRefresh} activeOpacity={0.75}>
        <Text style={styles.reanalyzeBtnText}>{AR.reanalyzeNow}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16, paddingTop: 12 },
  centered: { flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 32 },
  loadingText: { color: '#64748b', marginTop: 12, fontSize: 14 },
  noDataIcon: { fontSize: 48, marginBottom: 16 },
  noDataTitle: { color: '#94a3b8', fontSize: 20, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  noDataBody: { color: '#475569', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  refreshBtn: { backgroundColor: '#1e293b', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: '#334155' },
  refreshBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 15 },
  stateBar: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 2 },
  stateBarLabel: { color: '#64748b', fontSize: 10, fontWeight: '700', letterSpacing: 2, marginBottom: 4, textAlign: 'right' },
  stateBarValue: { fontSize: 26, fontWeight: '800', marginBottom: 4, textAlign: 'right' },
  stateBarDur: { color: '#64748b', fontSize: 12, marginBottom: 16, textAlign: 'right' },
  patternNote: { color: '#475569', fontSize: 11, marginBottom: 10, textAlign: 'right' },
  reanalyzeBtn: { marginTop: 4, backgroundColor: '#1e293b', padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  reanalyzeBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 15 },
  autoRefreshBanner: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10, borderWidth: 1, borderColor: '#1e3a4a' },
  autoRefreshText: { color: '#38bdf8', fontSize: 12, fontWeight: '600', textAlign: 'right' },
});
