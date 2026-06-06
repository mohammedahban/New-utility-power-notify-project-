import React, { useMemo } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePredictions, Prediction, PatternStats } from '../../hooks/usePredictions';
import { supabase } from '../../lib/supabase';

function ConfidenceMeter({ pct, label }: { pct: number; label: string }) {
  const color = pct >= 88 ? '#22c55e' : pct >= 72 ? '#38bdf8' : pct >= 52 ? '#f59e0b' : '#ef4444';
  return (
    <View style={confStyles.wrap}>
      <View style={confStyles.header}>
        <Text style={confStyles.label}>Prediction Confidence</Text>
        <Text style={[confStyles.pct, { color }]}>{pct}%</Text>
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
  header: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  label: { color: '#94a3b8', fontSize: 12, fontWeight: '600', letterSpacing: 0.5 },
  pct: { fontSize: 14, fontWeight: '800' },
  track: { height: 8, backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden', marginBottom: 4 },
  fill: { height: 8, borderRadius: 4 },
  levelLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' },
});

function Card({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <View style={[cardStyles.card, accent ? { borderLeftColor: accent, borderLeftWidth: 3 } : {}]}>
      <Text style={cardStyles.title}>{title}</Text>
      {children}
    </View>
  );
}
const cardStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12 },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 14 },
});

function StatRow({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <View style={statStyles.row}>
      <Text style={statStyles.label}>{label}</Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[statStyles.value, color ? { color } : {}]}>{value}</Text>
        {sub ? <Text style={statStyles.sub}>{sub}</Text> : null}
      </View>
    </View>
  );
}
const statStyles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  label: { color: '#64748b', fontSize: 13 },
  value: { color: '#e2e8f0', fontSize: 13, fontWeight: '700', textAlign: 'right' },
  sub: { color: '#475569', fontSize: 10, marginTop: 1, textAlign: 'right' },
});

function PatternBlock({ title, stats }: { title: string; stats: PatternStats | null }) {
  if (!stats || stats.cycles === 0) {
    return (
      <View style={pbStyles.empty}>
        <Text style={pbStyles.emptyTitle}>{title}</Text>
        <Text style={pbStyles.emptyText}>No data</Text>
      </View>
    );
  }
  const fmtMin = (min: number) => {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
  };
  return (
    <View style={pbStyles.block}>
      <Text style={pbStyles.title}>{title}</Text>
      <Text style={pbStyles.cycles}>{stats.cycles} cycle{stats.cycles !== 1 ? 's' : ''}</Text>
      <View style={pbStyles.row}>
        <View style={pbStyles.cell}>
          <View style={[pbStyles.dot, { backgroundColor: '#ef4444' }]} />
          <Text style={pbStyles.cellLabel}>Avg OFF</Text>
          <Text style={[pbStyles.cellValue, { color: '#ef4444' }]}>{fmtMin(stats.avgOffMin)}</Text>
          <Text style={pbStyles.cellSub}>±{fmtMin(stats.stdDevOffMin)}</Text>
        </View>
        <View style={pbStyles.divider} />
        <View style={pbStyles.cell}>
          <View style={[pbStyles.dot, { backgroundColor: '#22c55e' }]} />
          <Text style={pbStyles.cellLabel}>Avg ON</Text>
          <Text style={[pbStyles.cellValue, { color: '#22c55e' }]}>{stats.avgOnMin !== null ? fmtMin(stats.avgOnMin) : '—'}</Text>
          {stats.stdDevOnMin !== null && <Text style={pbStyles.cellSub}>±{fmtMin(stats.stdDevOnMin)}</Text>}
        </View>
      </View>
    </View>
  );
}
const pbStyles = StyleSheet.create({
  block: { backgroundColor: '#0f172a', borderRadius: 12, padding: 14, flex: 1 },
  title: { color: '#94a3b8', fontSize: 11, fontWeight: '700', marginBottom: 2 },
  cycles: { color: '#475569', fontSize: 10, marginBottom: 10 },
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
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

// ── Profile definitions (must match analyze-patterns edge function) ────────
const PROFILE_ORDER = [
  { key: 'Night Generator',    icon: '🌑', color: '#818cf8', hours: '00–06' },
  { key: 'Morning Transition', icon: '🌅', color: '#fb923c', hours: '06–10' },
  { key: 'Solar Assisted',     icon: '☀️',  color: '#facc15', hours: '10–16' },
  { key: 'Evening Transition', icon: '🌆', color: '#f472b6', hours: '16–20' },
  { key: 'Night Consumption',  icon: '🌃', color: '#60a5fa', hours: '20–00' },
];

function ProfileBlendCard({ apppe }: { apppe: NonNullable<Prediction['apppe']> }) {
  const blend = apppe.profileBlend;    // { 'Solar Assisted': 72, … }
  const samples = apppe.profileSamples;

  return (
    <View style={ppStyles.card}>
      <View style={ppStyles.headerRow}>
        <Text style={ppStyles.cardTitle}>APPPE PROFILE BLEND</Text>
        <View style={[ppStyles.versionBadge, apppe.crisisMode && ppStyles.crisisBadge]}>
          <Text style={[ppStyles.versionText, apppe.crisisMode && ppStyles.crisisText]}>
            {apppe.crisisMode ? '⚠️ CRISIS MODE' : `v${apppe.version}`}
          </Text>
        </View>
      </View>

      {apppe.crisisMode && apppe.crisisReason ? (
        <View style={ppStyles.crisisBox}>
          <Text style={ppStyles.crisisReason}>{apppe.crisisReason}</Text>
        </View>
      ) : null}

      <Text style={ppStyles.dominantLabel}>
        Dominant: <Text style={ppStyles.dominantValue}>{apppe.dominantProfile}</Text>
      </Text>

      {PROFILE_ORDER.map(({ key, icon, color, hours }) => {
        const pct   = Math.round(blend[key] ?? 0);
        const count = samples[key] ?? 0;
        if (pct < 1 && count === 0) return null;

        return (
          <View key={key} style={ppStyles.profileRow}>
            {/* Left: icon + name + hours */}
            <View style={ppStyles.profileLeft}>
              <Text style={ppStyles.profileIcon}>{icon}</Text>
              <View>
                <Text style={[ppStyles.profileName, pct > 5 && { color }]}>{key}</Text>
                <Text style={ppStyles.profileHours}>{hours}</Text>
              </View>
            </View>

            {/* Bar + numbers */}
            <View style={ppStyles.barSection}>
              <View style={ppStyles.barTrack}>
                <View
                  style={[
                    ppStyles.barFill,
                    { width: `${Math.min(100, pct)}%` as any, backgroundColor: color },
                    pct >= 50 && ppStyles.barGlow,
                  ]}
                />
              </View>
              <View style={ppStyles.barNums}>
                <Text style={[ppStyles.barPct, pct > 5 && { color }]}>{pct}%</Text>
                <Text style={ppStyles.sampleCount}>
                  {count === 0 ? 'no data' : `${count} sample${count !== 1 ? 's' : ''}`}
                </Text>
              </View>
            </View>
          </View>
        );
      })}

      <Text style={ppStyles.noteText}>
        Profiles blend smoothly over time — no hard slot boundaries. Weights sum to 100%.
      </Text>
    </View>
  );
}

const ppStyles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 16,
    padding: 18,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#38bdf8',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  cardTitle: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  versionBadge: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#334155',
  },
  crisisBadge: { borderColor: '#f59e0b', backgroundColor: '#1a0e00' },
  versionText: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  crisisText: { color: '#f59e0b', fontWeight: '700' },
  crisisBox: {
    backgroundColor: '#1a0e00',
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#78350f',
  },
  crisisReason: { color: '#fbbf24', fontSize: 12, lineHeight: 18 },
  dominantLabel: { color: '#64748b', fontSize: 11, marginBottom: 14 },
  dominantValue: { color: '#e2e8f0', fontWeight: '700' },
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 12,
  },
  profileLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: 148,
  },
  profileIcon: { fontSize: 18 },
  profileName: { color: '#64748b', fontSize: 12, fontWeight: '600', lineHeight: 16 },
  profileHours: { color: '#334155', fontSize: 10, marginTop: 1 },
  barSection: { flex: 1 },
  barTrack: {
    height: 8,
    backgroundColor: '#0f172a',
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 4,
  },
  barFill: { height: 8, borderRadius: 4 },
  barGlow: { opacity: 0.95 },
  barNums: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  barPct: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  sampleCount: { color: '#334155', fontSize: 10 },
  noteText: { color: '#334155', fontSize: 10, textAlign: 'center', marginTop: 8, lineHeight: 15 },
});

function LearningProgressCard({ prediction }: { prediction: Prediction }) {
  const TARGET_DAYS = 7; // APPPE uses 7-day window; 'learned' mode at max samples
  const mode = prediction.learningMode;
  const maxSamples = Math.max(
    ...(Object.values(prediction.apppe?.profileSamples ?? {}) as number[])
  );

  // Estimate days from sample count: roughly 3-4 cycles/day in Yemen grid
  const CYCLES_PER_DAY = 3.5;
  const estimatedDays = Math.min(TARGET_DAYS, Math.round(maxSamples / CYCLES_PER_DAY * 10) / 10);
  const progressPct = Math.min(100, Math.round((estimatedDays / TARGET_DAYS) * 100));

  const modeColor = mode === 'learned' ? '#22c55e' : mode === 'hybrid' ? '#38bdf8' : '#f59e0b';
  const modeIcon  = mode === 'learned' ? '🧠' : mode === 'hybrid' ? '📊' : '📐';
  const modeDesc  = mode === 'learned'
    ? 'Fully learned — predictions based on real historical data'
    : mode === 'hybrid'
      ? 'Hybrid — blending learned data with statistical priors'
      : 'Prior only — not enough data yet, using calibrated starting estimates';

  const milestones = [
    { label: 'Hybrid', day: 3, pct: Math.round((3 / TARGET_DAYS) * 100) },
    { label: 'Learned', day: TARGET_DAYS, pct: 100 },
  ];

  return (
    <View style={lpStyles.card}>
      <View style={lpStyles.headerRow}>
        <Text style={lpStyles.cardTitle}>LEARNING PROGRESS</Text>
        <View style={[lpStyles.modeBadge, { borderColor: modeColor + '55', backgroundColor: modeColor + '18' }]}>
          <Text style={lpStyles.modeIcon}>{modeIcon}</Text>
          <Text style={[lpStyles.modeLabel, { color: modeColor }]}>{mode.replace('_', ' ').toUpperCase()}</Text>
        </View>
      </View>

      <View style={lpStyles.daysRow}>
        <Text style={[lpStyles.daysValue, { color: modeColor }]}>{estimatedDays.toFixed(1)}</Text>
        <Text style={lpStyles.daysSep}> / </Text>
        <Text style={lpStyles.daysTarget}>{TARGET_DAYS}</Text>
        <Text style={lpStyles.daysLabel}> days of real data</Text>
      </View>

      {/* Progress track with milestones */}
      <View style={lpStyles.trackWrap}>
        <View style={lpStyles.track}>
          <View style={[lpStyles.fill, { width: `${progressPct}%` as any, backgroundColor: modeColor }]} />
        </View>
        {milestones.map((m) => (
          <View key={m.label} style={[lpStyles.milestone, { left: `${m.pct}%` as any }]}>
            <View style={[lpStyles.milestoneTick, { backgroundColor: estimatedDays >= m.day ? modeColor : '#334155' }]} />
            <Text style={[lpStyles.milestoneLabel, { color: estimatedDays >= m.day ? modeColor : '#475569' }]}>
              {m.label}
            </Text>
          </View>
        ))}
      </View>

      <Text style={lpStyles.modeDesc}>{modeDesc}</Text>

      {maxSamples > 0 && (
        <Text style={lpStyles.sampleNote}>
          {maxSamples} total cycle{maxSamples !== 1 ? 's' : ''} across all profiles
        </Text>
      )}
    </View>
  );
}

const lpStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: '#22c55e' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: '#94a3b8', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  modeBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 8, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  modeIcon: { fontSize: 13 },
  modeLabel: { fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  daysRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 14 },
  daysValue: { fontSize: 36, fontWeight: '900' },
  daysSep: { color: '#475569', fontSize: 22, fontWeight: '300' },
  daysTarget: { color: '#94a3b8', fontSize: 26, fontWeight: '700' },
  daysLabel: { color: '#64748b', fontSize: 13, marginLeft: 4, marginBottom: 2 },
  trackWrap: { position: 'relative', marginBottom: 28 },
  track: { height: 8, backgroundColor: '#0f172a', borderRadius: 4, overflow: 'hidden', marginBottom: 0 },
  fill: { height: 8, borderRadius: 4 },
  milestone: { position: 'absolute', top: -1, transform: [{ translateX: -12 }], alignItems: 'center' },
  milestoneTick: { width: 2, height: 12, borderRadius: 1, marginBottom: 3 },
  milestoneLabel: { fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  modeDesc: { color: '#64748b', fontSize: 12, lineHeight: 18, marginBottom: 6 },
  sampleNote: { color: '#334155', fontSize: 10, marginTop: 2 },
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

  // Auto-trigger analysis on mount so the admin always sees fresh APPPE output
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
    return new Date(computedAt).toLocaleString('en-US', { timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short' });
  }, [computedAt]);

  if (loading) {
    return <View style={styles.centered}><ActivityIndicator size="large" color="#38bdf8" /><Text style={styles.loadingText}>Analyzing patterns…</Text></View>;
  }

  const showAutoRefreshBanner = autoRefreshing && !refreshing;

  if (!prediction) {
    return (
      <View style={styles.centered}>
        <Text style={styles.noDataIcon}>📊</Text>
        <Text style={styles.noDataTitle}>No Analysis Yet</Text>
        <Text style={styles.noDataBody}>Pull down to trigger the analysis engine.</Text>
        <TouchableOpacity style={styles.refreshBtn} onPress={triggerRefresh}>
          <Text style={styles.refreshBtnText}>Run Analysis Now</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const isOn = prediction.currentState === 'ON';
  const fmtDur = (label: string) => label || '—';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={triggerRefresh} tintColor="#38bdf8" />}
    >
      {showAutoRefreshBanner && (
        <View style={styles.autoRefreshBanner}>
          <ActivityIndicator size="small" color="#38bdf8" style={{ marginRight: 8 }} />
          <Text style={styles.autoRefreshText}>Fetching latest APPPE analysis…</Text>
        </View>
      )}
      <View style={[styles.stateBar, { borderColor: isOn ? '#22c55e' : '#ef4444' }]}>
        <Text style={styles.stateBarLabel}>CURRENT STATE</Text>
        <Text style={[styles.stateBarValue, { color: isOn ? '#22c55e' : '#ef4444' }]}>{isOn ? '⚡ Grid ON' : '🔴 Grid OFF'}</Text>
        <Text style={styles.stateBarDur}>for {fmtDur(prediction.currentStateDurationLabel)} · {prediction.currentPeriod === 'day' ? '☀️ Daytime' : '🌙 Nighttime'}</Text>
        <ConfidenceMeter pct={prediction.confidence} label={prediction.confidenceLabel} />
      </View>

      {prediction.nextTransition ? (
        <Card title="Next Transition" accent={prediction.nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444'}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <Text style={{ fontSize: 28 }}>{prediction.nextTransition.type === 'UTILITY_ON' ? '⚡' : '🔴'}</Text>
            <View>
              <Text style={[{ fontSize: 18, fontWeight: '800' }, { color: prediction.nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444' }]}>
                Grid will turn {prediction.nextTransition.type === 'UTILITY_ON' ? 'ON' : 'OFF'}
              </Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, marginTop: 2 }}>{prediction.nextTransition.rangeLabel}</Text>
            </View>
          </View>
        </Card>
      ) : null}

      <Card title="Day vs Night Patterns">
        <Text style={styles.patternNote}>{prediction.cyclesAnalyzed} cycles — {prediction.dayCyclesAnalyzed} day · {prediction.nightCyclesAnalyzed} night</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <PatternBlock title="☀️ Day (6AM–6PM)" stats={prediction.dayPattern} />
          <PatternBlock title="🌙 Night (6PM–6AM)" stats={prediction.nightPattern} />
        </View>
      </Card>

      <Card title="Pattern Stability" accent={prediction.stabilityScore >= 75 ? '#22c55e' : prediction.stabilityScore >= 45 ? '#f59e0b' : '#ef4444'}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: '#e2e8f0', fontSize: 40, fontWeight: '800', width: 72 }}>{prediction.stabilityScore}%</Text>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={{ color: prediction.stabilityScore >= 75 ? '#22c55e' : prediction.stabilityScore >= 45 ? '#f59e0b' : '#ef4444', fontSize: 14, fontWeight: '700', marginBottom: 4 }}>{prediction.stabilityLabel}</Text>
            <Text style={{ color: '#64748b', fontSize: 12, lineHeight: 18 }}>
              {prediction.stabilityScore >= 75 ? 'Consistent cycles. Predictions are reliable.' : prediction.stabilityScore >= 45 ? 'Some variability. Use as approximate guides.' : 'High variability. Schedule is changing frequently.'}
            </Text>
          </View>
        </View>
      </Card>

      {prediction.apppe && (
        <ProfileBlendCard apppe={prediction.apppe} />
      )}

      <LearningProgressCard prediction={prediction} />

      <Card title="Analysis Reasoning">
        {prediction.reasoning.map((r, i) => (
          <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            <Text style={{ color: '#38bdf8', fontSize: 14, marginTop: 1 }}>›</Text>
            <Text style={{ color: '#94a3b8', fontSize: 13, flex: 1, lineHeight: 19 }}>{r}</Text>
          </View>
        ))}
        {computedLabel ? <Text style={{ color: '#334155', fontSize: 11, marginTop: 8, textAlign: 'right' }}>Last computed: {computedLabel} (Yemen)</Text> : null}
      </Card>

      <TouchableOpacity style={styles.reanalyzeBtn} onPress={triggerRefresh} activeOpacity={0.75}>
        <Text style={styles.reanalyzeBtnText}>🔄  Reanalyze Now</Text>
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
  noDataTitle: { color: '#94a3b8', fontSize: 20, fontWeight: '700', marginBottom: 10 },
  noDataBody: { color: '#475569', fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  refreshBtn: { backgroundColor: '#1e293b', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 12, borderWidth: 1, borderColor: '#334155' },
  refreshBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 15 },
  stateBar: { backgroundColor: '#1e293b', borderRadius: 16, padding: 18, marginBottom: 12, borderWidth: 2 },
  stateBarLabel: { color: '#64748b', fontSize: 10, fontWeight: '700', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 4 },
  stateBarValue: { fontSize: 26, fontWeight: '800', marginBottom: 4 },
  stateBarDur: { color: '#64748b', fontSize: 12, marginBottom: 16 },
  patternNote: { color: '#475569', fontSize: 11, marginBottom: 10 },
  reanalyzeBtn: { marginTop: 4, backgroundColor: '#1e293b', padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  reanalyzeBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 15 },
  autoRefreshBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0f172a', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, marginBottom: 10, borderWidth: 1, borderColor: '#1e3a4a' },
  autoRefreshText: { color: '#38bdf8', fontSize: 12, fontWeight: '600' },
});
