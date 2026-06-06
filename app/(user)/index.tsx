
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, UserPrediction } from '../../hooks/useUserPredictions';
import { useInverterState } from '../../hooks/useInverterState';
import { usePowerEvents } from '../../hooks/usePowerEvents';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';
import { useResync } from '../../contexts/ResyncContext';

// ── Theme ─────────────────────────────────────────────────────────────────────
const T = {
  bg: '#0a0f1e', surface: '#0f172a', elevated: '#1e293b',
  border: '#334155', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

function confColor(pct: number) {
  return pct >= 88 ? T.success : pct >= 72 ? T.accent : pct >= 52 ? T.warning : T.danger;
}

// ── Countdown Hook ────────────────────────────────────────────────────────────
function useCountdown(targetMinutes: number | null): { h: number; m: number; s: number; total: number } {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (targetMinutes === null || targetMinutes <= 0) return { h: 0, m: 0, s: 0, total: 0 };
  const totalSec = Math.max(0, Math.round(targetMinutes * 60) - tick);
  return {
    h: Math.floor(totalSec / 3600),
    m: Math.floor((totalSec % 3600) / 60),
    s: totalSec % 60,
    total: totalSec,
  };
}

// ── Elapsed Time Hook ─────────────────────────────────────────────────────────
function useElapsedTime(sinceIso: string | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!sinceIso) { setLabel(''); return; }
    const update = () => {
      const diffMs = Date.now() - new Date(sinceIso).getTime();
      const totalMin = Math.floor(diffMs / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h === 0) setLabel(`${m}m`);
      else if (m === 0) setLabel(`${h}h`);
      else setLabel(`${h}h ${m}m`);
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, [sinceIso]);
  return label;
}

// ── Countdown Card ────────────────────────────────────────────────────────────
function CountdownCard({ prediction }: { prediction: UserPrediction | null }) {
  const nt = prediction?.nextTransition ?? null;
  const midpointMin = nt ? (nt.minFromNowMin + nt.maxFromNowMin) / 2 : null;
  const { h, m, s, total } = useCountdown(midpointMin);
  const maxSec = midpointMin ? midpointMin * 60 : 1;
  const progress = Math.max(0, Math.min(1, total / maxSec));
  const animWidth = useRef(new Animated.Value(progress)).current;

  useEffect(() => {
    Animated.timing(animWidth, { toValue: progress, duration: 500, useNativeDriver: false }).start();
  }, [progress]);

  if (!prediction || prediction.isUnstable || !nt) {
    return (
      <View style={cdStyles.card}>
        <Text style={cdStyles.label}>NEXT TRANSITION</Text>
        <Text style={cdStyles.unstable}>⚠️  Predictions unavailable — pattern unstable</Text>
      </View>
    );
  }

  const isNextOn = nt.type === 'UTILITY_ON';
  const color = isNextOn ? T.success : T.danger;

  return (
    <View style={[cdStyles.card, { borderColor: color + '33' }]}>
      <Text style={cdStyles.label}>
        {isNextOn ? '⚡ GRID EXPECTED ON IN' : '🔴 GRID EXPECTED OFF IN'}
      </Text>
      <View style={cdStyles.timerRow}>
        {h > 0 && (
          <>
            <View style={cdStyles.timerUnit}>
              <Text style={[cdStyles.timerVal, { color }]}>{String(h).padStart(2, '0')}</Text>
              <Text style={cdStyles.timerSub}>h</Text>
            </View>
            <Text style={[cdStyles.timerColon, { color }]}>:</Text>
          </>
        )}
        <View style={cdStyles.timerUnit}>
          <Text style={[cdStyles.timerVal, { color }]}>{String(m).padStart(2, '0')}</Text>
          <Text style={cdStyles.timerSub}>m</Text>
        </View>
        <Text style={[cdStyles.timerColon, { color }]}>:</Text>
        <View style={cdStyles.timerUnit}>
          <Text style={[cdStyles.timerVal, { color }]}>{String(s).padStart(2, '0')}</Text>
          <Text style={cdStyles.timerSub}>s</Text>
        </View>
      </View>
      <View style={cdStyles.progressTrack}>
        <Animated.View
          style={[cdStyles.progressFill, {
            backgroundColor: color,
            width: animWidth.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          }]}
        />
      </View>
      <Text style={cdStyles.rangeLabel}>{nt.rangeLabel}</Text>
    </View>
  );
}

const cdStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 20, padding: 20, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  label: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 12 },
  timerRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 4, marginBottom: 16 },
  timerUnit: { alignItems: 'center', minWidth: 56 },
  timerVal: { fontSize: 52, fontWeight: '900', letterSpacing: -2, fontVariant: ['tabular-nums'] },
  timerSub: { color: T.textMuted, fontSize: 10, fontWeight: '600', marginTop: -4 },
  timerColon: { fontSize: 48, fontWeight: '900', marginBottom: 10 },
  progressTrack: { height: 4, backgroundColor: T.elevated, borderRadius: 2, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: 4, borderRadius: 2 },
  rangeLabel: { color: T.textMuted, fontSize: 11, textAlign: 'center' },
  unstable: { color: T.warning, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
});

// ── Schedule Hero ─────────────────────────────────────────────────────────────
function ScheduleHero({ prediction, onCalibrate }: { prediction: UserPrediction | null; onCalibrate: () => void }) {
  if (!prediction) {
    return (
      <TouchableOpacity style={shStyles.prompt} onPress={onCalibrate} activeOpacity={0.85}>
        <Text style={shStyles.promptIcon}>⚙️</Text>
        <Text style={shStyles.promptTitle}>Set Up Your Timing</Text>
        <Text style={shStyles.promptSub}>
          Go to My Offset tab, tell us when power last went ON or OFF, and we will calculate your personal block schedule
        </Text>
        <View style={shStyles.promptBtn}><Text style={shStyles.promptBtnText}>Calibrate Now →</Text></View>
      </TouchableOpacity>
    );
  }

  const nt = prediction.nextTransition;
  const cc = confColor(prediction.confidence);
  const isNextOn = nt?.type === 'UTILITY_ON';

  return (
    <View style={shStyles.card}>
      <View style={shStyles.topRow}>
        <View style={shStyles.badge}>
          <Text style={shStyles.badgeText}>MY SCHEDULE</Text>
        </View>
        <View style={[shStyles.modeBadge, { borderColor: cc + '44' }]}>
          <Text style={[shStyles.modeText, { color: cc }]}>
            {prediction.learningMode === 'learned' ? '🧠 Learned' : prediction.learningMode === 'hybrid' ? '📊 Hybrid' : '📐 Estimated'}
          </Text>
        </View>
      </View>

      <View style={shStyles.confRow}>
        <View style={[shStyles.confBadge, { borderColor: cc + '44', backgroundColor: cc + '18' }]}>
          <Text style={[shStyles.confPct, { color: cc }]}>{prediction.confidence}%</Text>
          <Text style={[shStyles.confLvl, { color: cc }]}>{prediction.confidenceLabel}</Text>
        </View>
        {prediction.offsetMinutes !== 0 && (
          <View style={shStyles.offsetBadge}>
            <Text style={shStyles.offsetText}>
              {prediction.offsetMinutes > 0 ? '+' : ''}{prediction.offsetMinutes}m offset
            </Text>
          </View>
        )}
      </View>

      {prediction.isUnstable || !nt ? (
        <View style={shStyles.unstableBox}>
          <Text style={shStyles.unstableText}>⚠️  Pattern changed recently — predictions temporarily unstable</Text>
        </View>
      ) : (
        <View style={shStyles.nextBox}>
          <View style={shStyles.nextLeft}>
            <Text style={shStyles.nextMicro}>NEXT TRANSITION</Text>
            <Text style={[shStyles.nextLabel, { color: isNextOn ? T.success : T.danger }]}>
              {isNextOn ? '⚡ Grid ON' : '🔴 Grid OFF'}
            </Text>
            <Text style={shStyles.nextRange}>{nt.rangeLabel}</Text>
          </View>
          <View style={[shStyles.waitBox, { borderColor: (isNextOn ? T.success : T.danger) + '33' }]}>
            <Text style={shStyles.waitMicro}>IN</Text>
            <Text style={[shStyles.waitVal, { color: isNextOn ? T.success : T.danger }]}>{nt.waitLabel}</Text>
          </View>
        </View>
      )}

      {(prediction.expectedOffDurationLabel || prediction.expectedOnDurationLabel) && (
        <View style={shStyles.durRow}>
          {prediction.expectedOffDurationLabel && (
            <View style={shStyles.durItem}>
              <Text style={shStyles.durMicro}>OUTAGE LENGTH</Text>
              <Text style={[shStyles.durVal, { color: T.danger }]}>{prediction.expectedOffDurationLabel}</Text>
            </View>
          )}
          {prediction.expectedOnDurationLabel && (
            <View style={shStyles.durItem}>
              <Text style={shStyles.durMicro}>GRID ON LENGTH</Text>
              <Text style={[shStyles.durVal, { color: T.success }]}>{prediction.expectedOnDurationLabel}</Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const shStyles = StyleSheet.create({
  prompt: { backgroundColor: T.surface, borderRadius: 20, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: T.border, borderStyle: 'dashed', marginBottom: 12 },
  promptIcon: { fontSize: 40, marginBottom: 12 },
  promptTitle: { color: T.textPrimary, fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  promptSub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  promptBtn: { backgroundColor: T.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12 },
  promptBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  card: { backgroundColor: T.surface, borderRadius: 20, padding: 18, borderWidth: 1, borderColor: T.border, marginBottom: 12 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badgeText: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  modeBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, backgroundColor: T.elevated },
  modeText: { fontSize: 11, fontWeight: '600' },
  confRow: { flexDirection: 'row', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' },
  confBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 10, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  confPct: { fontSize: 14, fontWeight: '800' },
  confLvl: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  offsetBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: T.elevated },
  offsetText: { color: T.accent, fontSize: 11, fontWeight: '600' },
  nextBox: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: T.bg, borderRadius: 14, padding: 14, marginBottom: 12 },
  nextLeft: { flex: 1 },
  nextMicro: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  nextLabel: { fontSize: 20, fontWeight: '800', marginBottom: 4 },
  nextRange: { color: T.textMuted, fontSize: 11, fontWeight: '600' },
  waitBox: { backgroundColor: T.surface, borderRadius: 12, padding: 12, alignItems: 'center', borderWidth: 1, minWidth: 80 },
  waitMicro: { color: T.textMuted, fontSize: 9, letterSpacing: 1, marginBottom: 4 },
  waitVal: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  unstableBox: { backgroundColor: '#1a0a00', borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: '#451a03' },
  unstableText: { color: '#92400e', fontSize: 12, lineHeight: 18 },
  durRow: { flexDirection: 'row', gap: 10 },
  durItem: { flex: 1, backgroundColor: T.bg, borderRadius: 10, padding: 12 },
  durMicro: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
  durVal: { fontSize: 15, fontWeight: '800' },
});

// ── Stability Gauge ───────────────────────────────────────────────────────────
function StabilityGauge({ score, label }: { score: number; label: string }) {
  const color = score >= 75 ? T.success : score >= 45 ? T.warning : T.danger;
  const animWidth = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(animWidth, { toValue: score, duration: 800, useNativeDriver: false }).start();
  }, [score]);
  return (
    <View style={sgStyles.wrap}>
      <View style={sgStyles.header}>
        <Text style={sgStyles.title}>PATTERN STABILITY</Text>
        <Text style={[sgStyles.score, { color }]}>{score}%  <Text style={[sgStyles.label, { color }]}>{label}</Text></Text>
      </View>
      <View style={sgStyles.track}>
        <Animated.View style={[sgStyles.fill, {
          backgroundColor: color,
          width: animWidth.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }]} />
      </View>
    </View>
  );
}
const sgStyles = StyleSheet.create({
  wrap: { backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.border },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  title: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  score: { fontSize: 13, fontWeight: '800' },
  label: { fontSize: 11, fontWeight: '600' },
  track: { height: 6, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
});

// ── Current Status Card ───────────────────────────────────────────────────────
function CurrentStatusCard() {
  const { state } = useInverterState();
  const { events } = usePowerEvents(1);
  const lastEvent = events[0] ?? null;
  const elapsed = useElapsedTime(lastEvent?.occurred_at ?? null);

  if (!state) return null;

  const isOn = state.utility_on === true;
  const isOffline = state.inverter_offline === true;
  const stateColor = isOffline ? T.warning : isOn ? T.success : T.danger;
  const lastPolled = state.last_polled
    ? new Date(state.last_polled).toLocaleString('en-US', { timeZone: 'Asia/Aden', timeStyle: 'short' })
    : '—';

  return (
    <View style={[csStyles.card, { borderColor: stateColor + '33' }]}>
      <View style={csStyles.row}>
        <View style={[csStyles.dot, { backgroundColor: stateColor }]} />
        <Text style={csStyles.microlabel}>CURRENT STATUS</Text>
        <Text style={csStyles.polled}>polled {lastPolled}</Text>
      </View>
      <Text style={[csStyles.value, { color: stateColor }]}>
        {isOffline ? '📡 Inverter Offline' : isOn ? '⚡ Grid Is ON' : '🔴 Grid Is OFF'}
      </Text>
      {elapsed ? (
        <Text style={[csStyles.elapsed, { color: stateColor + 'bb' }]}>For {elapsed}</Text>
      ) : null}
      {!isOffline && (
        <Text style={csStyles.sub}>
          {isOn ? `Grid input: ${state.vac != null ? `${Number(state.vac).toFixed(0)} W` : '—'}` : 'Running on solar / battery'}
        </Text>
      )}
    </View>
  );
}

const csStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, borderWidth: 1, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  microlabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, flex: 1 },
  polled: { color: T.textMuted, fontSize: 10 },
  value: { fontSize: 22, fontWeight: '800', marginBottom: 2 },
  elapsed: { fontSize: 14, fontWeight: '700', marginBottom: 4 },
  sub: { color: T.textMuted, fontSize: 12 },
});

// ── Day Schedule Mini ─────────────────────────────────────────────────────────
function DayScheduleMini({ prediction }: { prediction: UserPrediction | null }) {
  const slots = prediction?.daySchedule ?? [];
  if (slots.length === 0) return null;
  const preview = slots.slice(0, 4);
  return (
    <View style={dsStyles.card}>
      <Text style={dsStyles.title}>TODAY'S SCHEDULE</Text>
      {preview.map((slot, i) => {
        const isOn = slot.state === 'ON';
        const color = isOn ? T.success : T.danger;
        return (
          <View key={i} style={dsStyles.slotRow}>
            <View style={[dsStyles.stateDot, { backgroundColor: color }]} />
            <View style={dsStyles.slotInfo}>
              <Text style={[dsStyles.slotState, { color }]}>Grid {slot.state}</Text>
              <Text style={dsStyles.slotTime}>
                {slot.shiftedStartFormatted ?? slot.startFormatted}
                {slot.shiftedEndFormatted ? ` → ${slot.shiftedEndFormatted}` : ' →  …'}
              </Text>
            </View>
            <View style={dsStyles.slotRight}>
              {slot.durationLabel && <Text style={dsStyles.slotDur}>{slot.durationLabel}</Text>}
              <Text style={dsStyles.slotZone}>{slot.zone}</Text>
              {slot.isEstimated && <Text style={dsStyles.estimated}>est.</Text>}
            </View>
          </View>
        );
      })}
      {slots.length > 4 && (
        <Text style={dsStyles.moreHint}>+{slots.length - 4} more slots → see Schedule tab</Text>
      )}
    </View>
  );
}

const dsStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: T.border, marginBottom: 12 },
  title: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 12 },
  slotRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: T.elevated },
  stateDot: { width: 8, height: 8, borderRadius: 4 },
  slotInfo: { flex: 1 },
  slotState: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  slotTime: { color: T.textMuted, fontSize: 11 },
  slotRight: { alignItems: 'flex-end', gap: 2 },
  slotDur: { color: T.textSecondary, fontSize: 12, fontWeight: '600' },
  slotZone: { color: T.textMuted, fontSize: 10 },
  estimated: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  moreHint: { color: T.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8, paddingTop: 8 },
});

// ── Community Alert Banner ────────────────────────────────────────────────────
function CommunityAlertBanner({ count, onPress }: { count: number; onPress: () => void }) {
  if (count === 0) return null;
  return (
    <TouchableOpacity style={cabStyles.banner} onPress={onPress} activeOpacity={0.85}>
      <View style={cabStyles.dot} />
      <Text style={cabStyles.text}>
        <Text style={cabStyles.count}>{count}</Text> community alert{count > 1 ? 's' : ''} awaiting your response
      </Text>
      <Text style={cabStyles.arrow}>→</Text>
    </TouchableOpacity>
  );
}
const cabStyles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#001a2e', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: T.accent + '55', gap: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: T.accent },
  text: { color: T.textSecondary, fontSize: 13, flex: 1 },
  count: { color: T.accent, fontWeight: '800' },
  arrow: { color: T.accent, fontSize: 14, fontWeight: '700' },
});

// ── Crisis Banner ─────────────────────────────────────────────────────────────
function CrisisBanner({ reason }: { reason: string }) {
  return (
    <View style={cbStyles.banner}>
      <View style={cbStyles.iconWrap}><Text style={cbStyles.icon}>⚠️</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={cbStyles.title}>PATTERN SHIFT DETECTED</Text>
        <Text style={cbStyles.reason}>{reason}</Text>
      </View>
    </View>
  );
}
const cbStyles = StyleSheet.create({
  banner: { backgroundColor: '#1a0e00', borderRadius: 14, padding: 14, marginBottom: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderWidth: 1.5, borderColor: '#92400e' },
  iconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#451a03', alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 18 },
  title: { color: '#f59e0b', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  reason: { color: '#fbbf24', fontSize: 13, lineHeight: 19 },
});

// ── Why Panel ─────────────────────────────────────────────────────────────────
function WhyPanel({ prediction }: { prediction: UserPrediction | null }) {
  const [expanded, setExpanded] = useState(false);
  if (!prediction || prediction.reasoning.length === 0) return null;
  return (
    <View style={wpStyles.card}>
      <TouchableOpacity style={wpStyles.header} onPress={() => setExpanded(v => !v)} activeOpacity={0.8}>
        <Text style={wpStyles.title}>💡 Why this prediction?</Text>
        <Text style={wpStyles.chevron}>{expanded ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {expanded && (
        <View style={wpStyles.body}>
          {prediction.reasoning.map((r, i) => (
            <View key={i} style={wpStyles.row}>
              <Text style={wpStyles.bullet}>›</Text>
              <Text style={wpStyles.text}>{r}</Text>
            </View>
          ))}
          <View style={wpStyles.metaRow}>
            <Text style={wpStyles.metaItem}>Offset: {prediction.offsetMinutes > 0 ? '+' : ''}{prediction.offsetMinutes}m</Text>
            <Text style={wpStyles.metaItem}>
              Mode: {prediction.learningMode === 'learned' ? '🧠 Learned' : prediction.learningMode === 'hybrid' ? '📊 Hybrid' : '📐 Estimated'}
            </Text>
            {prediction.computedAt && (
              <Text style={wpStyles.metaItem}>
                Updated: {new Date(prediction.computedAt).toLocaleString('en-US', { timeZone: 'Asia/Aden', timeStyle: 'short', dateStyle: 'short' })}
              </Text>
            )}
          </View>
        </View>
      )}
    </View>
  );
}
const wpStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, marginBottom: 16, borderWidth: 1, borderColor: T.border, overflow: 'hidden' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { color: T.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  chevron: { color: T.textMuted, fontSize: 11 },
  body: { paddingHorizontal: 16, paddingBottom: 16 },
  row: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  bullet: { color: T.accent, fontSize: 14, marginTop: 1 },
  text: { color: T.textMuted, fontSize: 12, flex: 1, lineHeight: 18 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: T.elevated },
  metaItem: { color: T.textMuted, fontSize: 10, backgroundColor: T.elevated, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
});

// ── Community Summary Strip ───────────────────────────────────────────────────
function CommunitySummaryStrip({ pendingAlerts, onViewAll }: { pendingAlerts: number; onViewAll: () => void }) {
  return (
    <View style={cmStyles.card}>
      <View style={cmStyles.header}>
        <Text style={cmStyles.title}>COMMUNITY NETWORK</Text>
        <TouchableOpacity onPress={onViewAll}><Text style={cmStyles.seeAll}>Open →</Text></TouchableOpacity>
      </View>
      <View style={cmStyles.row}>
        <View style={cmStyles.item}>
          <Text style={cmStyles.itemIcon}>📢</Text>
          <Text style={cmStyles.itemLabel}>Report a grid transition to alert your followers</Text>
        </View>
      </View>
      {pendingAlerts > 0 && (
        <TouchableOpacity style={cmStyles.alertRow} onPress={onViewAll} activeOpacity={0.85}>
          <View style={cmStyles.alertDot} />
          <Text style={cmStyles.alertText}>{pendingAlerts} pending alert{pendingAlerts > 1 ? 's' : ''} from people you follow</Text>
          <Text style={cmStyles.alertArrow}>→</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}
const cmStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: T.border, marginBottom: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  title: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  seeAll: { color: T.accent, fontSize: 12, fontWeight: '600' },
  row: { marginBottom: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  itemIcon: { fontSize: 20 },
  itemLabel: { color: T.textMuted, fontSize: 12, flex: 1, lineHeight: 17 },
  alertRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#001a2e', borderRadius: 10, padding: 12, marginTop: 8, gap: 8, borderWidth: 1, borderColor: T.accent + '44' },
  alertDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  alertText: { color: T.textSecondary, fontSize: 12, flex: 1 },
  alertArrow: { color: T.accent, fontWeight: '700' },
});

// ── Home Screen ───────────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, signOut } = useAuth();
  const { offset, loading: offsetLoading } = useUserOffset();
  const { resyncPoint } = useResync(); // Moved this line up to be available for useUserPredictions
  const { userPrediction, loading: predLoading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint);
  const { pendingCount } = useResyncNotifications();
  const { score: myScore } = useMyReliability(profile?.id);

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  const loading = offsetLoading || predLoading;

  if (loading && !userPrediction) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={{ color: T.textMuted, marginTop: 12, fontSize: 14 }}>Loading your timing…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.greeting}>Hi, {profile?.username ?? 'there'} 👋</Text>
          <Text style={styles.date}>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
        </View>
        <View style={styles.headerBtns}>
          {myScore && (
            <View style={styles.reliabilityPill}>
              <Text style={[styles.reliabilityText, { color: getReliabilityBadge(myScore.reliability_score).color }]}>
                {myScore.reliability_score}%
              </Text>
            </View>
          )}
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/(user)/settings')}>
            <Text style={styles.iconBtnText}>⚙️</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.iconBtn, { marginLeft: 8 }]} onPress={signOut}>
            <Text style={styles.iconBtnText}>⏻</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Crisis Banner */}
      {userPrediction?.crisisMode && userPrediction.crisisReason ? (
        <CrisisBanner reason={userPrediction.crisisReason} />
      ) : null}

      {/* Community alert banner */}
      <CommunityAlertBanner
        count={pendingCount}
        onPress={() => router.push('/(user)/community')}
      />

      {/* My Schedule Hero */}
      <ScheduleHero
        prediction={userPrediction}
        onCalibrate={() => router.push('/(user)/calibrate')}
      />

      {/* Countdown */}
      <CountdownCard prediction={userPrediction} />

      {/* Resync active badge */}
      {userPrediction?.isResynced && (
        <View style={styles.resyncBadge}>
          <Text style={styles.resyncBadgeText}>👥 Schedule synced via community report</Text>
        </View>
      )}

      {/* Stability Gauge */}
      {userPrediction && (
        <StabilityGauge score={userPrediction.stabilityScore} label={userPrediction.stabilityLabel} />
      )}

      {/* Current Status */}
      <CurrentStatusCard />

      {/* Day Schedule Preview */}
      <DayScheduleMini prediction={userPrediction} />

      {/* Why This Prediction */}
      <WhyPanel prediction={userPrediction} />

      {/* Community strip */}
      <CommunitySummaryStrip
        pendingAlerts={pendingCount}
        onViewAll={() => router.push('/(user)/community')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  greeting: { color: T.textPrimary, fontSize: 22, fontWeight: '800' },
  date: { color: T.textMuted, fontSize: 12, marginTop: 2 },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reliabilityPill: { backgroundColor: T.elevated, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  reliabilityText: { fontSize: 12, fontWeight: '800' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  iconBtnText: { fontSize: 18 },
  resyncBadge: {
    backgroundColor: '#001a2e',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#38bdf844',
    flexDirection: 'row',
    alignItems: 'center',
  },
  resyncBadgeText: {
    color: '#38bdf8',
    fontSize: 12,
    fontWeight: '600',
  },
});
