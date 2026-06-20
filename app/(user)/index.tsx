import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity,
  ActivityIndicator, Pressable, Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../contexts/AuthContext';
import { useResync } from '../../contexts/ResyncContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, ScheduleStateMode } from '../../hooks/useUserPredictions';
import { useTransitionMode } from '../../hooks/useTransitionMode';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useStatusSnapshot } from '../../hooks/useStatusSnapshot';
import { AR } from '../../constants/arabic';
import { supabase } from '../../lib/supabase';

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg: '#060d1a',
  surface: '#0d1626',
  elevated: '#1a2640',
  border: '#1e3050',
  accent: '#38bdf8',
  accentDim: '#1e3a5f',
  textPrimary: '#f0f6ff',
  textSecondary: '#8ba3c7',
  textMuted: '#4a6080',
  success: '#22c55e',
  danger: '#ef4444',
  warning: '#f59e0b',
  purple: '#a78bfa',
  orange: '#f97316',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', 'ص').replace('PM', 'م');
}

function elapsedLabel(startIso: string | null): string {
  if (!startIso) return '';
  const elapsedMin = Math.floor((Date.now() - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const h = Math.floor(elapsedMin / 60);
  const m = elapsedMin % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return `${h}س`;
  return `${h}س ${m}د`;
}

function hhmmss(isoTarget: string): string {
  const diffMs = new Date(isoTarget).getTime() - Date.now();
  if (diffMs <= 0) return '00:00:00';
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

// ── Translate crisis reason to Arabic ────────────────────────────────────────
function translateCrisisReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason
    .replace(/Outage durations increased by (\d+)% vs baseline/i, 'مدة الانقطاع ارتفعت بنسبة $1% مقارنةً بالأساس')
    .replace(/On durations increased by (\d+)% vs baseline/i, 'مدة التشغيل ارتفعت بنسبة $1% مقارنةً بالأساس')
    .replace(/Outage durations decreased by (\d+)% vs baseline/i, 'مدة الانقطاع انخفضت بنسبة $1% مقارنةً بالأساس')
    .replace(/On durations decreased by (\d+)% vs baseline/i, 'مدة التشغيل انخفضت بنسبة $1% مقارنةً بالأساس')
    .replace(/Insufficient data for reliable prediction/i, 'بيانات غير كافية للتوقع الموثوق')
    .replace(/Pattern shift detected/i, 'تم اكتشاف تغيّر في النمط')
    .replace(/High volatility detected/i, 'تذبذب مرتفع في التوقعات')
    .replace(/The pattern is temporarily unstable/i, 'النمط مضطرب مؤقتاً')
    .replace(/Crisis mode active/i, 'وضع الأزمة نشط')
    .replace(/schedule/gi, 'الجدول')
    .replace(/pattern/gi, 'النمط')
    .replace(/baseline/gi, 'الأساس')
    .replace(/confidence/gi, 'الثقة')
    .replace(/unstable/gi, 'غير مستقر');
}

// ── Positive Offset Pending Banner ────────────────────────────────────────────
function PositiveOffsetPendingBanner({
  scheduledIso,
  growattTransitionIso,
  currentState,
}: {
  scheduledIso: string;
  growattTransitionIso: string | null;
  currentState: 'ON' | 'OFF';
}) {
  const [countdown, setCountdown] = useState(() => hhmmss(scheduledIso));
  const [progress, setProgress] = useState(0);

  const totalMs = growattTransitionIso
    ? new Date(scheduledIso).getTime() - new Date(growattTransitionIso).getTime()
    : 0;

  useEffect(() => {
    const tick = () => {
      setCountdown(hhmmss(scheduledIso));
      if (totalMs > 0) {
        const elapsed = Date.now() - new Date(growattTransitionIso!).getTime();
        setProgress(Math.min(1, Math.max(0, elapsed / totalMs)));
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [scheduledIso, growattTransitionIso, totalMs]);

  const nextState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';
  const color = nextState === 'ON' ? T.success : T.danger;
  const icon = nextState === 'ON' ? '⚡' : '🔴';
  const label = nextState === 'ON' ? 'الكهرباء ستشتغل' : 'الكهرباء ستطفى';

  return (
    <View style={[bStyles.banner, { borderColor: color + '44' }]}>
      <View style={bStyles.header}>
        <Text style={[bStyles.countdown, { color }]}>{countdown}</Text>
        <View style={bStyles.labelCol}>
          <Text style={[bStyles.title, { color }]}>{icon} {label}</Text>
          <Text style={bStyles.sub}>
            سيتم تغيير حالتك تلقائياً في {fmtYemenTime(scheduledIso)}
          </Text>
        </View>
      </View>
      {totalMs > 0 && (
        <View style={bStyles.progressTrack}>
          <View style={[bStyles.progressFill, { width: `${Math.round(progress * 100)}%` as any, backgroundColor: color }]} />
        </View>
      )}
      <Text style={bStyles.note}>⏰ تغيير تلقائي مجدول</Text>
    </View>
  );
}

const bStyles = StyleSheet.create({
  banner: {
    backgroundColor: '#001a2e', borderRadius: 16, padding: 16,
    marginBottom: 12, borderWidth: 1,
  },
  header: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 10 },
  labelCol: { flex: 1 },
  title: { fontSize: 16, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  sub: { color: T.textSecondary, fontSize: 12, textAlign: 'right' },
  countdown: { fontSize: 28, fontWeight: '900', fontVariant: ['tabular-nums'] as any },
  progressTrack: { height: 5, backgroundColor: '#0f172a', borderRadius: 3, overflow: 'hidden', marginBottom: 8 },
  progressFill: { height: 5, borderRadius: 3 },
  note: { color: T.textMuted, fontSize: 10, textAlign: 'right', letterSpacing: 0.8 },
});

// ── Current State Card ────────────────────────────────────────────────────────
function CurrentStateCard({
  state,
  durationLabel,
  startIso,
  atcMode,
  isHolding,
  statusLine,
  isResynced,
  reporterName,
}: {
  state: 'ON' | 'OFF';
  durationLabel: string;
  startIso: string | null;
  atcMode: ScheduleStateMode;
  isHolding: boolean;
  statusLine: string | null;
  isResynced: boolean;
  reporterName?: string | null;
}) {
  const isOn = state === 'ON';
  const color = isOn ? T.success : T.danger;
  const icon = isOn ? '⚡' : '🔴';
  const label = isOn ? AR.gridOn : AR.gridOff;

  const [elapsed, setElapsed] = useState(() => elapsedLabel(startIso));
  useEffect(() => {
    const id = setInterval(() => setElapsed(elapsedLabel(startIso)), 30_000);
    return () => clearInterval(id);
  }, [startIso]);

  const atcBadge = (() => {
    const map: Partial<Record<ScheduleStateMode, { label: string; color: string }>> = {
      UNCERTAIN_ZONE: { label: '⚠ منطقة عدم اليقين', color: T.warning },
      WAITING_FOR_GROWATT: { label: '⏳ بانتظار الحساس', color: T.accent },
      GRACE_MODE: { label: '⏳ مهلة المزامنة', color: T.orange },
      PREDICTION_RANGE: { label: '🔮 نطاق التوقع', color: T.accent },
      COMMUNITY_SYNCED: { label: '👥 مزامنة مجتمعية', color: T.purple },
      POSITIVE_OFFSET_PENDING: { label: '⏰ مجدول', color: T.accent },
    };
    return atcMode !== 'NORMAL' ? map[atcMode] : null;
  })();

  return (
    <View style={[csStyles.card, { borderColor: color + '55' }]}>
      <View style={csStyles.row}>
        <View style={csStyles.info}>
          {isResynced && reporterName && (
            <Text style={csStyles.resyncLabel}>
              👥 مزامنة عبر {reporterName}
            </Text>
          )}
          <Text style={[csStyles.state, { color }]}>{icon}  {label}</Text>
          {elapsed ? (
            <Text style={csStyles.elapsed}>
              {AR.for} {elapsed}
            </Text>
          ) : null}
          {statusLine ? (
            <Text style={[csStyles.statusLine, { color: T.warning }]}>{statusLine}</Text>
          ) : null}
        </View>
        <View style={[csStyles.dot, { backgroundColor: color }]} />
      </View>
      {atcBadge && (
        <View style={[csStyles.atcBadge, { backgroundColor: atcBadge.color + '18', borderColor: atcBadge.color + '44' }]}>
          <Text style={[csStyles.atcBadgeText, { color: atcBadge.color }]}>{atcBadge.label}</Text>
        </View>
      )}
    </View>
  );
}

const csStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 20, padding: 20,
    marginBottom: 12, borderWidth: 1.5,
  },
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  info: { flex: 1 },
  resyncLabel: { color: T.purple, fontSize: 11, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  state: { fontSize: 26, fontWeight: '900', textAlign: 'right', marginBottom: 4 },
  elapsed: { color: T.textSecondary, fontSize: 14, textAlign: 'right' },
  statusLine: { fontSize: 12, textAlign: 'right', marginTop: 6, lineHeight: 18 },
  dot: { width: 16, height: 16, borderRadius: 8, marginLeft: 8 },
  atcBadge: {
    marginTop: 12, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6,
    borderWidth: 1, alignSelf: 'flex-end',
  },
  atcBadgeText: { fontSize: 12, fontWeight: '700' },
});

// ── Upcoming Transition Card ──────────────────────────────────────────────────
function UpcomingTransitionCard({
  atcMode,
  nextTransition,
  scheduledAutoTransitionIso,
  currentState,
  crisisMode,
  crisisReason,
  isUnstable,
}: {
  atcMode: ScheduleStateMode;
  nextTransition: any;
  scheduledAutoTransitionIso: string | null;
  currentState: 'ON' | 'OFF';
  crisisMode: boolean;
  crisisReason: string | null;
  isUnstable: boolean;
}) {
  // Priority 1: POSITIVE_OFFSET_PENDING — show scheduled banner
  if (atcMode === 'POSITIVE_OFFSET_PENDING' && scheduledAutoTransitionIso) {
    const scheduledMs = new Date(scheduledAutoTransitionIso).getTime();
    if (scheduledMs > Date.now()) {
      const nextState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';
      const color = nextState === 'ON' ? T.success : T.danger;
      const icon = nextState === 'ON' ? '⚡' : '🔴';
      return (
        <View style={[upStyles.card, { borderColor: color + '44' }]}>
          <Text style={upStyles.title}>{AR.nextTransition}</Text>
          <Text style={[upStyles.mainLabel, { color }]}>{icon}  {nextState === 'ON' ? AR.gridWillTurnOn : AR.gridWillTurnOff}</Text>
          <Text style={upStyles.rangeLabel}>في {fmtYemenTime(scheduledAutoTransitionIso)}</Text>
          <Text style={upStyles.atcNote}>⏰ تغيير تلقائي مجدول (فارق موجب)</Text>
        </View>
      );
    }
  }

  // Priority 2: WAITING_FOR_GROWATT / UNCERTAIN_ZONE — show holding message
  if (atcMode === 'WAITING_FOR_GROWATT' || atcMode === 'UNCERTAIN_ZONE') {
    return (
      <View style={[upStyles.card, { borderColor: T.warning + '44' }]}>
        <Text style={upStyles.title}>{AR.nextTransition}</Text>
        <Text style={[upStyles.mainLabel, { color: T.warning }]}>
          {atcMode === 'UNCERTAIN_ZONE' ? '⚠ بانتظار تأكيد التغيير' : '⏳ بانتظار تأكيد الحساس'}
        </Text>
        <Text style={upStyles.rangeLabel}>
          {atcMode === 'UNCERTAIN_ZONE'
            ? 'تم تجاوز نهاية الفترة المتوقعة — جارٍ انتظار مصدر تأكيد'
            : 'النمط ممتد خارج النطاق المتوقع'}
        </Text>
      </View>
    );
  }

  // Priority 3: Crisis / Unstable
  if (crisisMode || isUnstable) {
    const arabicReason = translateCrisisReason(crisisReason) ?? 'النمط مضطرب مؤقتاً';
    return (
      <View style={[upStyles.card, { borderColor: T.warning + '55' }]}>
        <Text style={upStyles.title}>{AR.nextTransition}</Text>
        <Text style={[upStyles.mainLabel, { color: T.warning }]}>⚠ التوقع غير متاح مؤقتاً</Text>
        <Text style={upStyles.rangeLabel}>{arabicReason}</Text>
      </View>
    );
  }

  // Priority 4: Normal next transition
  if (!nextTransition) return null;

  const isOn = nextTransition.type === 'UTILITY_ON';
  const color = isOn ? T.success : T.danger;
  const icon = isOn ? '⚡' : '🔴';

  return (
    <View style={[upStyles.card, { borderColor: color + '44' }]}>
      <Text style={upStyles.title}>{AR.nextTransition}</Text>
      <Text style={[upStyles.mainLabel, { color }]}>{icon}  {isOn ? AR.gridWillTurnOn : AR.gridWillTurnOff}</Text>
      <Text style={upStyles.rangeLabel}>{nextTransition.rangeLabel}</Text>
      <Text style={upStyles.waitLabel}>{nextTransition.waitLabel}</Text>
    </View>
  );
}

const upStyles = StyleSheet.create({
  card: {
    backgroundColor: T.surface, borderRadius: 16, padding: 16,
    marginBottom: 12, borderWidth: 1,
  },
  title: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 8 },
  mainLabel: { fontSize: 20, fontWeight: '800', textAlign: 'right', marginBottom: 6 },
  rangeLabel: { color: T.textSecondary, fontSize: 13, textAlign: 'right', marginBottom: 4 },
  waitLabel: { color: T.textMuted, fontSize: 12, textAlign: 'right' },
  atcNote: { color: T.accent, fontSize: 11, textAlign: 'right', marginTop: 4 },
});

// ── Today's Schedule Mini Timeline ────────────────────────────────────────────
function TodayScheduleMini({
  slots,
  currentState,
  atcMode,
  isPositiveOffsetPending,
}: {
  slots: any[];
  currentState: 'ON' | 'OFF';
  atcMode: ScheduleStateMode;
  isPositiveOffsetPending: boolean;
}) {
  const nowMs = Date.now();
  // Show up to 4 slots starting from active
  const activeIdx = isPositiveOffsetPending && slots.length > 0 ? 0 :
    slots.findIndex(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    });

  const startIdx = activeIdx >= 0 ? activeIdx : slots.findIndex(s => new Date(s.startIso).getTime() > nowMs);
  const display = startIdx >= 0 ? slots.slice(startIdx, startIdx + 4) : slots.slice(0, 4);

  if (display.length === 0) return null;

  return (
    <View style={tmStyles.container}>
      <Text style={tmStyles.title}>📅 جدول اليوم</Text>
      {display.map((slot, i) => {
        const isActive = isPositiveOffsetPending ? i === 0 : (
          nowMs >= new Date(slot.startIso).getTime() &&
          nowMs < (slot.endIso ? new Date(slot.endIso).getTime() : Infinity)
        );
        const isOn = slot.state === 'ON';
        const color = isOn ? T.success : T.danger;
        return (
          <View key={i} style={[tmStyles.row, isActive && { backgroundColor: color + '12', borderRadius: 10 }]}>
            <View style={tmStyles.right}>
              {isActive && (
                <View style={[tmStyles.nowDot, { backgroundColor: color }]} />
              )}
              <Text style={[tmStyles.stateText, { color }]}>
                {isOn ? 'شغالة' : 'طافية'}
              </Text>
              {isActive && <Text style={[tmStyles.nowBadge, { color }]}>الآن</Text>}
              {slot.isEstimated && <Text style={tmStyles.estBadge}>تقديري</Text>}
            </View>
            <View style={tmStyles.left}>
              <Text style={tmStyles.timeText}>
                {slot.shiftedStartFormatted ?? slot.startFormatted}
                {slot.endIso ? ` ← ${slot.shiftedEndFormatted ?? slot.endFormatted ?? ''}` : ''}
              </Text>
              {slot.durationLabel ? <Text style={tmStyles.durText}>{slot.durationLabel}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const tmStyles = StyleSheet.create({
  container: {
    backgroundColor: T.surface, borderRadius: 16, padding: 16,
    marginBottom: 12, borderWidth: 1, borderColor: T.border,
  },
  title: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1, textAlign: 'right', marginBottom: 10 },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4 },
  right: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  nowDot: { width: 8, height: 8, borderRadius: 4 },
  stateText: { fontSize: 14, fontWeight: '700' },
  nowBadge: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  estBadge: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  left: { alignItems: 'flex-start' },
  timeText: { color: T.textSecondary, fontSize: 12, fontWeight: '600' },
  durText: { color: T.textMuted, fontSize: 10, marginTop: 2 },
});

// ── DSD Chip ──────────────────────────────────────────────────────────────────
function DSDChip({ offsetMinutes, isPending }: { offsetMinutes: number; isPending: boolean }) {
  const isNeg = offsetMinutes < 0;
  const color = isNeg ? T.orange : offsetMinutes > 0 ? T.success : T.textMuted;
  const label = `${offsetMinutes > 0 ? '+' : ''}${offsetMinutes}د`;

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isPending) { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.2, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isPending]);

  return (
    <View style={[dsdStyles.chip, { borderColor: color + '44', backgroundColor: color + '12' }]}>
      {isPending && (
        <Animated.View style={[dsdStyles.pendingDot, { opacity: pulseAnim, backgroundColor: color }]} />
      )}
      <Text style={[dsdStyles.value, { color }]}>{label}</Text>
      <Text style={dsdStyles.label}>DSD</Text>
    </View>
  );
}

const dsdStyles = StyleSheet.create({
  chip: { borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, alignItems: 'center', gap: 2, minWidth: 54 },
  value: { fontSize: 14, fontWeight: '800' },
  label: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1 },
  pendingDot: { width: 6, height: 6, borderRadius: 3, position: 'absolute', top: 4, left: 5 },
});

// ── Community Alerts Banner ───────────────────────────────────────────────────
function CommunityAlertsBanner({ count, onPress }: { count: number; onPress: () => void }) {
  if (count === 0) return null;
  return (
    <Pressable
      style={caStyles.banner}
      onPress={onPress}
      android_ripple={{ color: T.accentDim }}
    >
      <Text style={caStyles.arrow}>←</Text>
      <View style={caStyles.body}>
        <Text style={caStyles.count}>{count}</Text>
        <Text style={caStyles.label}>
          {count === 1 ? AR.commAlert : AR.commAlerts} {AR.pendingAlerts}
        </Text>
      </View>
      <Text style={caStyles.icon}>🔔</Text>
    </Pressable>
  );
}

const caStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: T.accentDim, borderRadius: 14, padding: 14,
    marginBottom: 12, borderWidth: 1, borderColor: T.accent + '44',
  },
  body: { flex: 1 },
  icon: { fontSize: 20 },
  count: { color: T.accent, fontSize: 18, fontWeight: '900', textAlign: 'right' },
  label: { color: T.textSecondary, fontSize: 12, textAlign: 'right' },
  arrow: { color: T.accent, fontSize: 16, fontWeight: '700' },
});

// ── TMMS Mode Toggle ──────────────────────────────────────────────────────────
function TMMSToggle({ mode, onToggle }: { mode: 'AUTO' | 'MANUAL'; onToggle: () => void }) {
  const isAuto = mode === 'AUTO';
  return (
    <TouchableOpacity
      style={[ttStyles.wrap, { borderColor: isAuto ? T.success + '44' : T.warning + '44' }]}
      onPress={onToggle}
      activeOpacity={0.8}
    >
      <Text style={[ttStyles.value, { color: isAuto ? T.success : T.warning }]}>
        {isAuto ? '🤖 تلقائي' : '🖐 يدوي'}
      </Text>
      <Text style={ttStyles.label}>وضع التحكم</Text>
    </TouchableOpacity>
  );
}

const ttStyles = StyleSheet.create({
  wrap: {
    borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10,
    borderWidth: 1, alignItems: 'center', gap: 2, backgroundColor: T.surface,
  },
  value: { fontSize: 13, fontWeight: '800' },
  label: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1 },
});

// ── Revert Community Sync Button ──────────────────────────────────────────────
function RevertSyncButton({ onRevert }: { onRevert: () => void }) {
  return (
    <TouchableOpacity style={rvStyles.btn} onPress={onRevert} activeOpacity={0.8}>
      <Text style={rvStyles.text}>↩ العودة إلى الحالة الأصلية</Text>
    </TouchableOpacity>
  );
}

const rvStyles = StyleSheet.create({
  btn: {
    backgroundColor: T.elevated, borderRadius: 12, paddingVertical: 10,
    paddingHorizontal: 16, alignItems: 'center', marginBottom: 12,
    borderWidth: 1, borderColor: T.border,
  },
  text: { color: T.textSecondary, fontSize: 13, fontWeight: '700' },
});

// ── Setup Prompt ──────────────────────────────────────────────────────────────
function SetupPrompt({ onPress }: { onPress: () => void }) {
  return (
    <View style={spStyles.card}>
      <Text style={spStyles.title}>{AR.setUpTiming}</Text>
      <Text style={spStyles.body}>{AR.setUpTimingPrompt}</Text>
      <TouchableOpacity style={spStyles.btn} onPress={onPress} activeOpacity={0.8}>
        <Text style={spStyles.btnText}>{AR.calibrateNow}</Text>
      </TouchableOpacity>
    </View>
  );
}

const spStyles = StyleSheet.create({
  card: {
    backgroundColor: T.accentDim, borderRadius: 16, padding: 16,
    marginBottom: 12, borderWidth: 1, borderColor: T.accent + '44',
  },
  title: { color: T.accent, fontSize: 15, fontWeight: '800', textAlign: 'right', marginBottom: 6 },
  body: { color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 12 },
  btn: { backgroundColor: T.accent, borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  btnText: { color: '#000', fontSize: 14, fontWeight: '800' },
});

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function UserHomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { profile } = useAuth();
  const { resyncPoint, clearResync, registerSnapshotCallback } = useResync();
  const { offset, pendingDSD } = useUserOffset();
  const { mode: transitionMode, toggle: toggleMode } = useTransitionMode();
  const { anchor } = useStateAnchor();
  const { pendingCount } = useResyncNotifications();

  const offsetMinutes = offset?.offset_minutes ?? 0;
  const offsetMs = offsetMinutes * 60_000;

  // Compute anchor start ISO adjusted for offset
  const anchorStartIso = (() => {
    if (resyncPoint?.syncedAtIso) return resyncPoint.syncedAtIso;
    if (!anchor) return null;
    return new Date(new Date(anchor.startIso).getTime() + offsetMs).toISOString();
  })();

  const { userPrediction, loading } = useUserPredictions(
    offsetMinutes,
    resyncPoint,
    transitionMode,
    anchorStartIso,
  );

  // Register snapshot callback for community resync
  const { captureSnapshot } = useStatusSnapshot();
  const snapshotForResync = useCallback(async (point: any) => {
    if (!userPrediction) return;
    await captureSnapshot(
      userPrediction.currentState,
      userPrediction.currentStateStartIso,
      offsetMinutes,
      resyncPoint ?? null,
      'community_confirm',
    );
  }, [captureSnapshot, userPrediction, offsetMinutes, resyncPoint]);

  useEffect(() => {
    registerSnapshotCallback(snapshotForResync);
    return () => registerSnapshotCallback(null);
  }, [snapshotForResync, registerSnapshotCallback]);

  const atcMode = userPrediction?.atc?.mode ?? 'NORMAL';
  const isPositiveOffsetPending = atcMode === 'POSITIVE_OFFSET_PENDING';
  const hasOffset = offsetMinutes !== 0;

  // For POSITIVE_OFFSET_PENDING: use currentStateStartIso, otherwise anchor+offset or computed
  const displayStartIso = (() => {
    if (userPrediction?.reconciledCycleStartIso) return userPrediction.reconciledCycleStartIso;
    if (isPositiveOffsetPending) return userPrediction?.currentStateStartIso ?? null;
    return userPrediction?.currentStateStartIso ?? anchorStartIso;
  })();

  if (loading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={styles.loadingText}>{AR.loading}</Text>
      </View>
    );
  }

  const greeting = profile?.username
    ? `${AR.greeting} ${profile.username}`
    : AR.appName;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRight}>
          <DSDChip offsetMinutes={offsetMinutes} isPending={!!pendingDSD} />
          <TMMSToggle mode={transitionMode} onToggle={toggleMode} />
        </View>
        <Text style={styles.greeting}>{greeting}</Text>
      </View>

      {/* Community alerts banner */}
      <CommunityAlertsBanner
        count={pendingCount ?? 0}
        onPress={() => router.push('/(user)/community')}
      />

      {/* Positive offset pending banner */}
      {isPositiveOffsetPending && userPrediction?.atc.scheduledAutoTransitionIso && (
        <PositiveOffsetPendingBanner
          scheduledIso={userPrediction.atc.scheduledAutoTransitionIso}
          growattTransitionIso={null}
          currentState={userPrediction.currentState}
        />
      )}

      {/* Current State */}
      {userPrediction ? (
        <CurrentStateCard
          state={userPrediction.currentState}
          durationLabel={userPrediction.currentStateDurationLabel}
          startIso={displayStartIso}
          atcMode={atcMode}
          isHolding={userPrediction.isHoldingState}
          statusLine={userPrediction.atc.statusLine}
          isResynced={userPrediction.isResynced}
          reporterName={userPrediction.communitySyncMeta?.reporterName}
        />
      ) : (
        <View style={[styles.noDataCard]}>
          <Text style={styles.noDataText}>لا توجد بيانات متاحة</Text>
        </View>
      )}

      {/* Revert community sync */}
      {userPrediction?.isResynced && (
        <RevertSyncButton onRevert={clearResync} />
      )}

      {/* Setup prompt if no offset calibrated */}
      {!hasOffset && !loading && (
        <SetupPrompt onPress={() => router.push('/(user)/settings')} />
      )}

      {/* Upcoming transition */}
      {userPrediction && (
        <UpcomingTransitionCard
          atcMode={atcMode}
          nextTransition={userPrediction.nextTransition}
          scheduledAutoTransitionIso={userPrediction.atc.scheduledAutoTransitionIso}
          currentState={userPrediction.currentState}
          crisisMode={userPrediction.crisisMode}
          crisisReason={userPrediction.crisisReason}
          isUnstable={userPrediction.isUnstable}
        />
      )}

      {/* Duration expectations */}
      {userPrediction && (userPrediction.expectedOnDurationLabel || userPrediction.expectedOffDurationLabel) && (
        <View style={styles.durRow}>
          {userPrediction.expectedOnDurationLabel && (
            <View style={[styles.durCard, { borderColor: T.success + '44' }]}>
              <Text style={[styles.durValue, { color: T.success }]}>{userPrediction.expectedOnDurationLabel}</Text>
              <Text style={styles.durLabel}>مدة التشغيل</Text>
            </View>
          )}
          {userPrediction.expectedOffDurationLabel && (
            <View style={[styles.durCard, { borderColor: T.danger + '44' }]}>
              <Text style={[styles.durValue, { color: T.danger }]}>{userPrediction.expectedOffDurationLabel}</Text>
              <Text style={styles.durLabel}>مدة الانقطاع</Text>
            </View>
          )}
        </View>
      )}

      {/* Today's schedule mini */}
      {userPrediction && userPrediction.daySchedule.length > 0 && (
        <TodayScheduleMini
          slots={userPrediction.daySchedule}
          currentState={userPrediction.currentState}
          atcMode={atcMode}
          isPositiveOffsetPending={isPositiveOffsetPending}
        />
      )}

      {/* Confidence & stability row */}
      {userPrediction && (
        <View style={styles.metricsRow}>
          <View style={styles.metricItem}>
            <Text style={[styles.metricValue, {
              color: (userPrediction.confidence ?? 0) >= 75 ? T.success
                : (userPrediction.confidence ?? 0) >= 50 ? T.warning : T.danger
            }]}>{userPrediction.confidence ?? 0}%</Text>
            <Text style={styles.metricLabel}>الثقة</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricValue, {
              color: (userPrediction.stabilityScore ?? 0) >= 75 ? T.success
                : (userPrediction.stabilityScore ?? 0) >= 45 ? T.warning : T.danger
            }]}>{userPrediction.stabilityScore ?? 0}%</Text>
            <Text style={styles.metricLabel}>الاستقرار</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metricItem}>
            <Text style={[styles.metricValue, { color: T.textSecondary }]}>
              {userPrediction.learningMode === 'learned' ? AR.learned
                : userPrediction.learningMode === 'hybrid' ? AR.hybrid : AR.estimated}
            </Text>
            <Text style={styles.metricLabel}>النمط</Text>
          </View>
        </View>
      )}

      {/* Community activity shortcut */}
      <TouchableOpacity
        style={styles.communityBtn}
        onPress={() => router.push('/(user)/community')}
        activeOpacity={0.8}
      >
        <Text style={styles.communityBtnArrow}>←</Text>
        <Text style={styles.communityBtnText}>{AR.communityNetwork}</Text>
        <Text style={styles.communityBtnIcon}>👥</Text>
      </TouchableOpacity>

      {/* Computed at */}
      {userPrediction?.computedAt && (
        <Text style={styles.computedAt}>
          {AR.computedAt}{' '}
          {new Date(userPrediction.computedAt).toLocaleString('ar-SA', {
            timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short',
          })} (اليمن)
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16 },
  centered: { flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: T.textMuted, marginTop: 12, fontSize: 14 },
  header: {
    flexDirection: 'row-reverse', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 16,
  },
  headerRight: { flexDirection: 'row-reverse', gap: 8, alignItems: 'center' },
  greeting: { color: T.textPrimary, fontSize: 18, fontWeight: '700', flex: 1, textAlign: 'right' },
  noDataCard: {
    backgroundColor: T.surface, borderRadius: 20, padding: 20,
    marginBottom: 12, alignItems: 'center',
  },
  noDataText: { color: T.textMuted, fontSize: 14 },
  durRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 12 },
  durCard: {
    flex: 1, backgroundColor: T.surface, borderRadius: 14, padding: 14,
    alignItems: 'center', borderWidth: 1,
  },
  durValue: { fontSize: 18, fontWeight: '800', marginBottom: 4 },
  durLabel: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  metricsRow: {
    flexDirection: 'row-reverse', backgroundColor: T.surface, borderRadius: 14,
    paddingVertical: 12, paddingHorizontal: 8, marginBottom: 12,
    borderWidth: 1, borderColor: T.border, alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  metricItem: { alignItems: 'center', flex: 1 },
  metricValue: { fontSize: 15, fontWeight: '800', marginBottom: 2 },
  metricLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  metricDivider: { width: 1, height: 28, backgroundColor: T.border },
  communityBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: T.surface, borderRadius: 14, padding: 14,
    marginBottom: 12, borderWidth: 1, borderColor: T.border,
  },
  communityBtnIcon: { fontSize: 20 },
  communityBtnText: { color: T.textPrimary, fontSize: 15, fontWeight: '700', flex: 1, textAlign: 'right' },
  communityBtnArrow: { color: T.textMuted, fontSize: 16 },
  computedAt: { color: T.textMuted, fontSize: 10, textAlign: 'center', marginTop: 4 },
});
