import React, { useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePredictions, Prediction, PatternStats } from '../../hooks/usePredictions';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';

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

const PROFILE_ORDER = [
  { key: 'Night Generator',    icon: '🌑', color: '#818cf8', hours: '00–06' },
  { key: 'Morning Transition', icon: '🌅', color: '#fb923c', hours: '06–10' },
  { key: 'Solar Assisted',     icon: '☀️',  color: '#facc15', hours: '10–16' },
  { key: 'Evening Transition', icon: '🌆', color: '#f472b6', hours: '16–20' },
  { key: 'Night Consumption',  icon: '🌃', color: '#60a5fa', hours: '20–00' },
];

function ProfileBlendCard({ apppe }: { apppe: NonNullable<Prediction['apppe']> }) {
  const blend = apppe.profileBlend;
  const samples = apppe.profileSamples;

  return (
    <View style={ppStyles.card}>
      <View style={ppStyles.headerRow}>
        <View style={[ppStyles.versionBadge, apppe.crisisMode && ppStyles.crisisBadge]}>
          <Text style={[ppStyles.versionText, apppe.crisisMode && ppStyles.crisisText]}>
            {apppe.crisisMode ? '⚠️ وضع الأزمة' : `v${apppe.version}`}
          </Text>
        </View>
        <Text style={ppStyles.cardTitle}>{AR.apppeProfileBlend}</Text>
      </View>

      {apppe.crisisMode && apppe.crisisReason ? (
        <View style={ppStyles.crisisBox}>
          <Text style={ppStyles.crisisReason}>{apppe.crisisReason}</Text>
        </View>
      ) : null}

      <Text style={ppStyles.dominantLabel}>
        {AR.dominant} <Text style={ppStyles.dominantValue}>{apppe.dominantProfile}</Text>
      </Text>

      {PROFILE_ORDER.map(({ key, icon, color, hours }) => {
        const pct = Math.round(blend[key] ?? 0);
        const count = samples[key] ?? 0;
        if (pct < 1 && count === 0) return null;

        return (
          <View key={key} style={ppStyles.profileRow}>
            <View style={ppStyles.barSection}>
              <View style={ppStyles.barNums}>
                <Text style={ppStyles.sampleCount}>
                  {count === 0 ? 'لا بيانات' : `${count} ${count === 1 ? AR.samples : AR.samplesPlural}`}
                </Text>
                <Text style={[ppStyles.barPct, pct > 5 && { color }]}>{pct}%</Text>
              </View>
              <View style={ppStyles.barTrack}>
                <View style={[ppStyles.barFill, { width: `${Math.min(100, pct)}%` as any, backgroundColor: color }, pct >= 50 && ppStyles.barGlow]} />
              </View>
            </View>

            <View style={ppStyles.profileLeft}>
              <View>
                <Text style={[ppStyles.profileName, pct > 5 && { color }]}>{key}</Text>
                <Text style={ppStyles.profileHours}>{hours}</Text>
              </View>
              <Text style={ppStyles.profileIcon}>{icon}</Text>
            </View>
          </View>
        );
      })}

      <Text style={ppStyles.noteText}>{AR.blendsSmoothly}</Text>
    </View>
  );
}

const ppStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderRightWidth: 3, borderRightColor: '#38bdf8' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  cardTitle: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  versionBadge: { backgroundColor: '#0f172a', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: '#334155' },
  crisisBadge: { borderColor: '#f59e0b', backgroundColor: '#1a0e00' },
  versionText: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  crisisText: { color: '#f59e0b', fontWeight: '700' },
  crisisBox: { backgroundColor: '#1a0e00', borderRadius: 10, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#78350f' },
  crisisReason: { color: '#fbbf24', fontSize: 12, lineHeight: 18, textAlign: 'right' },
  dominantLabel: { color: '#64748b', fontSize: 11, marginBottom: 14, textAlign: 'right' },
  dominantValue: { color: '#e2e8f0', fontWeight: '700' },
  profileRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 12 },
  profileLeft: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, width: 148 },
  profileIcon: { fontSize: 18 },
  profileName: { color: '#64748b', fontSize: 12, fontWeight: '600', lineHeight: 16, textAlign: 'right' },
  profileHours: { color: '#334155', fontSize: 10, marginTop: 1 },
  barSection: { flex: 1 },
  barTrack: { height: 8, backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden', marginBottom: 4 },
  barFill: { height: 8, borderRadius: 4 },
  barGlow: { opacity: 0.95 },
  barNums: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  barPct: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  sampleCount: { color: '#334155', fontSize: 10 },
  noteText: { color: '#334155', fontSize: 10, textAlign: 'center', marginTop: 8, lineHeight: 15 },
});

function LearningProgressCard({ prediction }: { prediction: Prediction }) {
  const TARGET_DAYS = 7;
  const mode = prediction.learningMode;
  const maxSamples = Math.max(...(Object.values(prediction.apppe?.profileSamples ?? {}) as number[]));
  const CYCLES_PER_DAY = 3.5;
  const estimatedDays = Math.min(TARGET_DAYS, Math.round(maxSamples / CYCLES_PER_DAY * 10) / 10);
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
      {maxSamples > 0 && (
        <Text style={lpStyles.sampleNote}>
          {maxSamples} {maxSamples === 1 ? AR.cycleWord : AR.cyclesWord} — {AR.totalCycles}
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
