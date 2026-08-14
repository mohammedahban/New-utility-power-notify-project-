import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, Animated, Platform, Alert,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Stop } from 'react-native-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { UserPrediction } from '../../hooks/useUserPredictions';
import { useSharedUserPrediction } from '../../contexts/UserPredictionContext';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';
import { useResync } from '../../contexts/ResyncContext';
import { useStatusSnapshot, readPreActionStateForSnapshot } from '../../hooks/useStatusSnapshot';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { supabase } from '../../lib/supabase';
import { serverNowMs } from '../../lib/serverTime';
import type { PendingDSDCandidate } from '../../hooks/useUserOffset';

// ── Theme (screenshot-inspired deep navy / coral / mint) ────────────────────
const T = {
  bg: '#080e1a', surface: '#111a2c', elevated: '#1a2540',
  border: '#233252', primary: '#3b82f6', accent: '#4aa8ff',
  textPrimary: '#f2f6fc', textSecondary: '#9aa8c0', textMuted: '#5b6b86',
  success: '#2fe6a7', warning: '#f5b64a', danger: '#ff6f6f',
};
const TINT = {
  successBg: '#0a2418', warningBg: '#2a1c07', accentBg: '#0a1e33', dangerBg: '#2a1014',
};

function translateCrisisReason(reason: string): string {
  if (!reason) return reason;
  let r = reason;
  r = r.replace(/Outage durations increased by (\d+)% vs baseline/, 'مدد الانقطاع ارتفعت بنسبة $1% مقارنةً بالأساس');
  r = r.replace(/possible fuel shortage or schedule change/, 'ربما بسبب نقص وقود أو تغيير في الجدول');
  r = r.replace(/Prediction center shifted by ([^.]+)/, 'تم ضبط مركز التوقع بمقدار $1');
  r = r.replace(/ON durations decreased by (\d+)% vs baseline/, 'مدد التشغيل انخفضت بنسبة $1% مقارنةً بالأساس');
  r = r.replace(/possible generator capacity issue/, 'ربما بسبب مشكلة في سعة المولد');
  return r;
}

function fmtOverrunAr(min: number): string {
  if (min < 60) return `${min} دقيقة`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hLabel = h === 1 ? 'ساعة' : h === 2 ? 'ساعتين' : `${h} ساعات`;
  return m === 0 ? hLabel : `${hLabel} و ${m} دقيقة`;
}

// ── Header mode pill (purely presentational map of the engine's atc mode) ───
const MODE_PILL: Record<string, { label: string; color: string }> = {
  NORMAL: { label: 'الوضع الآن — مؤكد', color: T.success },
  COMMUNITY_SYNCED: { label: 'الوضع الآن — مزامنة مجتمعية', color: T.accent },
  PREDICTION_RANGE: { label: 'الوضع الآن — نطاق توقع', color: T.accent },
  UNCERTAIN_ZONE: { label: 'الوضع الآن — غير مؤكد', color: T.warning },
  WAITING_FOR_GROWATT: { label: 'الوضع الآن — بانتظار الحساس', color: T.warning },
  GRACE_MODE: { label: 'الوضع الآن — فترة سماح', color: T.warning },
  POSITIVE_OFFSET_PENDING: { label: 'الوضع الآن — تغيير مجدول', color: T.accent },
};

// ── Stable elapsed timer ──────────────────────────────────────────────────────
function useElapsedFromIso(startIso: string | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!startIso) { setLabel(''); return; }
    const update = () => {
      const diff = serverNowMs() - new Date(startIso).getTime();
      const totalMin = Math.floor(diff / 60000);
      if (totalMin < 1) { setLabel('للتو'); return; }
      const h = Math.floor(totalMin / 60); const m = totalMin % 60;
      if (h === 0) setLabel(`${m} دقيقة`);
      else if (m === 0) setLabel(h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`);
      else setLabel(`${h} س و ${m} د`);
    };
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [startIso]);
  return label;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROWATT ON TOAST — 3-second auto-dismiss
// <GeneratedOnBanner prediction={stablePrediction} />
// Shown when a UTILITY_ON power_event arrives while user is in
// UNCERTAIN_ZONE / WAITING_FOR_GROWATT with a negative offset.
// ─────────────────────────────────────────────────────────────────────────────
function GrowattOnToast({ visible, onDismiss }: { visible: boolean; onDismiss: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) { opacity.setValue(0); return; }
    Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2500),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]).start(() => onDismiss());
  }, [visible]);
  if (!visible) return null;
  return (
    <Animated.View style={[gtStyles.toast, { opacity }]}>
      <Text style={gtStyles.text}>⚡ الحساس تحوّل إلى تشغيل — تم تحديث جدولك</Text>
    </Animated.View>
  );
}
const gtStyles = StyleSheet.create({
  toast: {
    position: 'absolute', top: 56, left: 16, right: 16, zIndex: 999,
    backgroundColor: TINT.successBg, borderRadius: 14, padding: 14,
    borderWidth: 1.5, borderColor: T.success + '88',
    shadowColor: T.success, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3, shadowRadius: 8, elevation: 8,
  },
  text: { color: T.success, fontSize: 14, fontWeight: '800', textAlign: 'center' },
});

// ── Live overrun seconds clock ──────────────────────────────────────────────
// Ticks every second to show exact HH:MM:SS elapsed since the predicted OFF
// ended. Anchors the entry timestamp from `overrunMinutes` on first render
// (when uncertain state begins) so subsequent 30s heartbeat re-derivations
// of overrunMinutes don't reset or drift the clock.
function useOverrunLiveClock(overrunMinutes: number, isUncertain: boolean): string {
  const entryMsRef = useRef<number | null>(null);
  const [display, setDisplay] = useState('00:00:00');
  useEffect(() => {
    if (!isUncertain || overrunMinutes <= 0) {
      entryMsRef.current = null;
      setDisplay('00:00:00');
      return;
    }
    // Anchor on first activation — derive from overrunMinutes once
    if (entryMsRef.current === null) {
      entryMsRef.current = serverNowMs() - overrunMinutes * 60_000;
    }
    const update = () => {
      const elapsed = Math.max(0, serverNowMs() - entryMsRef.current!);
      const totalSec = Math.floor(elapsed / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      setDisplay(
        `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
      );
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  // Only re-anchor when the uncertain state flips or overrunMinutes crosses zero
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isUncertain, overrunMinutes > 0]);
  return display;
}

// ── Countdown hook ────────────────────────────────────────────────────────────
// SPEC-FIX C1: anchor the countdown on the absolute target ISO instead of a
// "minutes from now" snapshot. The old tick-based version drifted whenever the
// component re-rendered with a stale midMin (countdown ran too fast/slow vs the
// real target time). Now remaining = target − Date.now(), recomputed each tick.
function useCountdownSec(targetIso: string | null) {
  const [nowMs, setNowMs] = useState(() => serverNowMs());
  useEffect(() => {
    const id = setInterval(() => setNowMs(serverNowMs()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!targetIso) return { h: 0, m: 0, s: 0, total: 0 };
  const targetMs = new Date(targetIso).getTime();
  if (!Number.isFinite(targetMs)) return { h: 0, m: 0, s: 0, total: 0 };
  const total = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60, total };
}

function fmtTimeAr(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const raw = d.toLocaleString('en-US', { timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

const HOUR_WORDS_AR = ['', 'ساعة', 'ساعتان', 'ثلاث ساعات', 'أربع ساعات', 'خمس ساعات', 'ست ساعات', 'سبع ساعات', 'ثماني ساعات', 'تسع ساعات', 'عشر ساعات'];
function hoursToArabicWords(h: number): string {
  if (h >= 1 && h <= 10) return HOUR_WORDS_AR[h];
  return `${h} ساعة`;
}
function durationWordsAr(label: string | null | undefined): string | null {
  if (!label) return null;
  let hours = 0; let minutes = 0; let matched = false;
  const hMatch = label.match(/(\d+(?:\.\d+)?)\s*(?:س(?:اعات|اعة)?|h)/i);
  if (hMatch) { hours = parseFloat(hMatch[1]); matched = true; }
  const mMatch = label.match(/(\d+)\s*(?:د(?:قيقة|قائق)?|m)/i);
  if (mMatch) { minutes = parseInt(mMatch[1], 10); matched = true; }
  if (!matched) return label;
  const totalMin = Math.round(hours * 60) + minutes;
  const H = Math.floor(totalMin / 60); const M = totalMin % 60;
  if (H === 0) {
    if (M === 30) return 'نصف ساعة'; if (M === 15) return 'ربع ساعة';
    if (M === 45) return 'ثلاثة أرباع الساعة'; return `${M} دقيقة`;
  }
  const hWords = hoursToArabicWords(H);
  if (M === 0) return hWords; if (M === 30) return `${hWords} ونصف`;
  if (M === 15) return `${hWords} وربع`; if (M === 45) return `${hWords} وثلاثة أرباع`;
  return `${hWords} و${M} دقيقة`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATUS RING — circular gauge around the live state (screenshot hero)
// progress=null renders a dimmed full ring (no reliable window to measure).
// ─────────────────────────────────────────────────────────────────────────────
function StatusRing({ progress, color, size = 224, stroke = 16, children }: {
  progress: number | null; color: string; size?: number; stroke?: number; children?: React.ReactNode;
}) {
  const r = (size - stroke * 2) / 2;
  const c = 2 * Math.PI * r;
  const p = progress === null ? 1 : Math.max(0, Math.min(1, progress));
  const dimmed = progress === null;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <Defs>
          <SvgLinearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity="1" />
            <Stop offset="1" stopColor={color} stopOpacity="0.45" />
          </SvgLinearGradient>
        </Defs>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={T.elevated} strokeWidth={stroke} fill="none" />
        {/* soft glow behind the arc */}
        <Circle
          cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth={stroke + 14} fill="none"
          strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - p)}
          strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`}
          opacity={dimmed ? 0.05 : 0.13}
        />
        <Circle
          cx={size / 2} cy={size / 2} r={r} stroke="url(#ringGrad)" strokeWidth={stroke} fill="none"
          strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - p)}
          strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`}
          opacity={dimmed ? 0.22 : 1}
        />
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center', paddingHorizontal: stroke + 8 }}>
        {children}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERATED ON BANNER
// ─────────────────────────────────────────────────────────────────────────────
function GeneratedOnBanner({ prediction }: { prediction: UserPrediction | null }) {
  const genOn = prediction?.generatedOnInfo;
  if (!genOn || !prediction?.isGeneratedOnCurrent) return null;
  const color = T.success;
  const startTime = new Date(genOn.startIso).toLocaleString('en-US', { timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true }).replace('AM', ' ص').replace('PM', ' م');
  const durationLabel = genOn.durationMin >= 60 ? `${Math.floor(genOn.durationMin / 60)}س ${genOn.durationMin % 60}د` : `${genOn.durationMin}د`;
  const refTime = new Date(genOn.referenceIso).toLocaleString('en-US', { timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true }).replace('AM', ' ص').replace('PM', ' م');
  return (
    <View style={goStyles.banner}>
      <View style={goStyles.iconWrap}><Text style={{ fontSize: 22 }}>⚡</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={goStyles.title}>حالة تشغيل مُولّدة</Text>
        <Text style={goStyles.body}>بدأت في <Text style={{ fontWeight: '800', color: T.accent }}>{startTime}</Text>{' '}· المدّة المنسوخة من أقرب دورة تشغيل منطقية:{' '}<Text style={{ fontWeight: '800', color }}>{durationLabel}</Text></Text>
        <Text style={goStyles.ref}>{genOn.referenceKind === 'active' ? `🔄 تتبّع دورة مرجعية نشطة (بدأت ${refTime}) — ستتوارث نافذة التحقق ومنطقة UNCERTAIN وإصلاح المدة تلقائياً` : `📍 مرجع مكتمل (دورة سابقة بدأت ${refTime}) — المدّة نهائية`}</Text>
        <Text style={goStyles.note}>⚡ هذه الحالة حدث فعلي دائم في خطّك الزمني — لا يُحذف ولا يُستبدل.</Text>
      </View>
    </View>
  );
}
const goStyles = StyleSheet.create({
  banner: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, backgroundColor: TINT.successBg, borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.success + '66' },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.success, fontSize: 13.5, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5, textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2 },
  body: { color: T.textPrimary, fontSize: 13, lineHeight: 19, textAlign: 'right', marginBottom: 6 },
  ref: { color: T.textSecondary, fontSize: 11.5, lineHeight: 16, textAlign: 'right', marginBottom: 4 },
  note: { color: T.success + 'cc', fontSize: 11.5, fontStyle: 'italic', textAlign: 'right', fontWeight: '600' },
});

// ─────────────────────────────────────────────────────────────────────────────
// PENDING NEGATIVE BANNER
// ─────────────────────────────────────────────────────────────────────────────
function PendingNegativeBanner({ prediction }: { prediction: UserPrediction | null }) {
  const isPending = prediction?.isPendingNegative ?? false;
  const resolutionIso = prediction?.pendingNegativeResolutionIso ?? null;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isPending) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isPending]);
  if (!isPending) return null;
  let countdownLabel = 'بانتظار تحوّل الحساس الرئيسي القادم';
  if (resolutionIso) {
    const ms = new Date(resolutionIso).getTime() - serverNowMs();
    if (ms > 0) {
      const h = Math.floor(ms / 3600000); const m = Math.floor((ms % 3600000) / 60000); const s = Math.floor((ms % 60000) / 1000);
      countdownLabel = `≈ ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else { countdownLabel = 'الآن — بانتظار تقريرك او تقرير احد المتابعين '; }
  }
  return (
    <View style={pn2Styles.banner}>
      <View style={pn2Styles.iconWrap}><Text style={{ fontSize: 22 }}>⏳</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={pn2Styles.title}>فارق معلَّق (Pending Negative)</Text>
        <Text style={pn2Styles.body}>بلاغك أو بلاغ المُبلِّغ وصل في النصف الثاني من فترة الانطفاء المتوقّعة. الفارق الزمني سيُحسب تلقائياً بمجرد أن يتحوّل الحساس الرئيسي إلى تشغيل.</Text>
        <View style={pn2Styles.countdownRow}>
          <Text style={pn2Styles.countdownLabel}>توقّع الحل:</Text>
          <Text style={pn2Styles.countdownValue}>{countdownLabel}</Text>
        </View>
        <Text style={pn2Styles.note}>⚠ تنبؤات التشغيل القادمة تُعرض كـ "تقديري (فارق معلّق)" حتى يُحلّ الفارق.</Text>
      </View>
    </View>
  );
}
const pn2Styles = StyleSheet.create({
  banner: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, backgroundColor: TINT.warningBg, borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.warning + '66' },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.warning, fontSize: 13.5, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5, textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2 },
  body: { color: T.textPrimary, fontSize: 13, lineHeight: 19, textAlign: 'right', marginBottom: 8 },
  countdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 6 },
  countdownLabel: { color: T.textMuted, fontSize: 11.5, fontWeight: '600' },
  countdownValue: { color: T.warning, fontSize: 17, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  note: { color: T.warning + 'cc', fontSize: 11.5, fontStyle: 'italic', textAlign: 'right', fontWeight: '600' },
});

// ─────────────────────────────────────────────────────────────────────────────
// OFFSET STATE CHIP
// ─────────────────────────────────────────────────────────────────────────────
function OffsetStateChip({ prediction }: { prediction: UserPrediction | null }) {
  const state = prediction?.offsetState; const value = prediction?.offsetValue;
  if (!state) return null;
  const stateLabelAr: Record<string, string> = { POSITIVE: 'فارق إيجابي', NEGATIVE: 'فارق سلبي', NEUTRAL: 'فارق محايد', PENDING_NEGATIVE: 'فارق معلَّق' };
  const stateColor: Record<string, string> = { POSITIVE: T.success, NEGATIVE: T.warning, NEUTRAL: T.textMuted, PENDING_NEGATIVE: T.warning };
  const color = stateColor[state] ?? T.textMuted;
  const label = stateLabelAr[state] ?? state;
  const valueLabel = value === 'PENDING' || state === 'PENDING_NEGATIVE' ? 'بانتظار الحساس الرئيسي ' : (typeof value === 'number' ? `${value > 0 ? '+' : ''}${value}د` : '');
  return (
    <View style={[osStyles.chip, { borderColor: color + '55', backgroundColor: color + '12' }]}>
      <Text style={[osStyles.label, { color }]}>{label}</Text>
      {valueLabel ? <Text style={[osStyles.value, { color }]}>{valueLabel}</Text> : null}
    </View>
  );
}
const osStyles = StyleSheet.create({
  chip: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, alignSelf: 'flex-start', marginBottom: 14 },
  label: { fontSize: 12.5, fontWeight: '700' },
  value: { fontSize: 14.5, fontWeight: '900' },
});

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE OFFSET PENDING BANNER
// ─────────────────────────────────────────────────────────────────────────────
function PositiveOffsetPendingBanner({ prediction }: { prediction: UserPrediction | null }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const atcMode = prediction?.atc?.mode;
  const scheduledIso = prediction?.atc?.scheduledAutoTransitionIso;
  if (atcMode !== 'POSITIVE_OFFSET_PENDING' || !scheduledIso) return null;
  const scheduledMs = new Date(scheduledIso).getTime(); const nowMs = serverNowMs();
  const totalSecondsLeft = Math.max(0, Math.round((scheduledMs - nowMs) / 1000));
  const hLeft = Math.floor(totalSecondsLeft / 3600); const mLeft = Math.floor((totalSecondsLeft % 3600) / 60); const sLeft = totalSecondsLeft % 60;
  const countdownLabel = totalSecondsLeft > 0 ? `${String(hLeft).padStart(2,'0')}:${String(mLeft).padStart(2,'0')}:${String(sLeft).padStart(2,'0')}` : 'الآن';
  const growattTransitionMs = scheduledMs - (prediction?.offsetMinutes ?? 0) * 60_000;
  const totalDurationMs = scheduledMs - growattTransitionMs;
  const elapsedMs = Math.max(0, nowMs - growattTransitionMs);
  const progressPct = totalDurationMs > 0 ? Math.min(1, elapsedMs / totalDurationMs) : 0;
  // SPEC-FIX C6: show how long ago the sensor actually flipped (live, grows
  // every minute) instead of the static stored offset value.
  const sensorElapsedMin = Math.max(0, Math.floor(elapsedMs / 60_000));
  const isOn = prediction?.currentState === 'ON';
  const nextStateLabel = isOn ? 'طافية' : 'شغالة'; const nextStateEmoji = isOn ? '🔴' : '⚡';
  const scheduledTimeLabel = new Date(scheduledIso).toLocaleString('en-US', { timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true }).replace('AM', 'ص').replace('PM', 'م');
  return (
    <View style={popStyles.banner}>
      <View style={popStyles.iconWrap}><Text style={{ fontSize: 22 }}>⏰</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={popStyles.title}>تغيير تلقائي مجدول</Text>
        <Text style={popStyles.body}>سيتم تغيير حالتك إلى{' '}<Text style={{ fontWeight: '800', color: isOn ? T.danger : T.success }}>{nextStateEmoji} {nextStateLabel}</Text>{' '}تلقائياً في الساعة{' '}<Text style={{ fontWeight: '800', color: T.accent }}>{scheduledTimeLabel}</Text></Text>
        <View style={popStyles.countdownRow}>
          <Text style={popStyles.countdownLabel}>الوقت المتبقي:</Text>
          <Text style={popStyles.countdownValue}>{countdownLabel}</Text>
        </View>
        <View style={popStyles.progressTrack}>
          <View style={[popStyles.progressFill, { width: `${Math.round(progressPct * 100)}%` }]} />
        </View>
        <View style={popStyles.progressLabels}>
          <Text style={popStyles.progressLabelRight}>تحويل الحساس الرئيسي </Text>
          <Text style={popStyles.progressPct}>{Math.round(progressPct * 100)}%</Text>
          <Text style={popStyles.progressLabelLeft}>وقتك المجدول</Text>
        </View>
        <Text style={popStyles.sub}>الحساس الرئيسي حوّل حالته منذ {sensorElapsedMin} دقيقة</Text>
      </View>
    </View>
  );
}
const popStyles = StyleSheet.create({
  banner: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, backgroundColor: TINT.accentBg, borderRadius: 18, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.accent + '66' },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.accent, fontSize: 13, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5, textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: {width: 0, height: 1}, textShadowRadius: 2 },
  body: { color: T.textPrimary, fontSize: 14, lineHeight: 21, textAlign: 'right', marginBottom: 8 },
  sub: { color: T.textSecondary, fontSize: 11.5, textAlign: 'right', marginTop: 6 },
  countdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 8 },
  countdownLabel: { color: T.textMuted, fontSize: 11.5, fontWeight: '600' },
  countdownValue: { color: T.accent, fontSize: 19, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  progressTrack: { height: 6, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: 6, backgroundColor: T.accent, borderRadius: 3 },
  progressLabels: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  progressLabelRight: { color: T.textMuted, fontSize: 10.5 },
  progressLabelLeft: { color: T.accent + 'aa', fontSize: 10.5 },
  progressPct: { color: T.accent, fontSize: 11.5, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION WINDOW TOAST
// ─────────────────────────────────────────────────────────────────────────────
function ValidationWindowToast({ prediction }: { prediction: UserPrediction | null }) {
  const atcMode = prediction?.atc?.mode;
  const inWindow = prediction?.atc?.inValidationWindow ?? false;
  const remaining = Math.ceil(prediction?.atc?.validationWindowRemainingMin ?? 0);
  const [dismissed, setDismissed] = useState(false);
  const prevInWindow = useRef(false);
  useEffect(() => {
    if (inWindow && !prevInWindow.current) setDismissed(false);
    prevInWindow.current = inWindow;
  }, [inWindow]);
  if (atcMode !== 'COMMUNITY_SYNCED' || !inWindow || dismissed) return null;
  return (
    <View style={vwStyles.toast}>
      <View style={{ flex: 1 }}>
        <Text style={vwStyles.title}>⚠ الحساس الرئيسي يُشير إلى تغيير</Text>
        <Text style={vwStyles.body}>حالتك مزامَنة مجتمعياً وتظل كما هي. نافذة التحقق: {remaining} دقيقة متبقية.</Text>
      </View>
      <TouchableOpacity onPress={() => setDismissed(true)} style={vwStyles.close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={vwStyles.closeText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}
const vwStyles = StyleSheet.create({
  toast: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: TINT.warningBg, borderRadius: 16, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.warning + '66' },
  title: { color: T.warning, fontSize: 13.5, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  body: { color: '#fbbf24dd', fontSize: 12.5, lineHeight: 18, textAlign: 'right', fontWeight: '600' },
  close: { width: 26, height: 26, borderRadius: 13, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  closeText: { color: T.textMuted, fontSize: 12, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// PENDING DSD CHIP
// ─────────────────────────────────────────────────────────────────────────────
function PendingDSDChip({ pendingDSD, onCancel }: { pendingDSD: PendingDSDCandidate | null; onCancel: () => void }) {
  if (!pendingDSD) return null;
  const ageMin = Math.round((serverNowMs() - new Date(pendingDSD.createdAtIso).getTime()) / 60_000);
  const tentative = pendingDSD.tentativeDSD;
  const eventLabel = pendingDSD.eventType === 'UTILITY_ON' ? 'تشغيل' : 'انقطاع';
  return (
    <View style={pdcStyles.chip}>
      <TouchableOpacity onPress={onCancel} style={pdcStyles.cancelBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={pdcStyles.cancelText}>✕</Text>
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={pdcStyles.title}>⏳ معايرة DSD بانتظار الحساس الرئيسي </Text>
        <Text style={pdcStyles.body}>بلاغ {eventLabel} · فارق مؤقت: {tentative}د · منذ {ageMin} دقيقة</Text>
        <Text style={pdcStyles.sub}>سيتم تأكيد الفارق تلقائياً عند وصول إشارة الحساس الرئيسي </Text>
      </View>
      <View style={pdcStyles.dot} />
    </View>
  );
}
const pdcStyles = StyleSheet.create({
  chip: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: TINT.successBg, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 11, marginBottom: 12, borderWidth: 1.5, borderColor: T.success + '44' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.success, flexShrink: 0 },
  title: { color: T.success, fontSize: 12.5, fontWeight: '800', textAlign: 'right', marginBottom: 3 },
  body: { color: T.success + 'cc', fontSize: 12.5, textAlign: 'right' },
  sub: { color: T.textMuted, fontSize: 11, textAlign: 'right', marginTop: 2 },
  cancelBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  cancelText: { color: T.textMuted, fontSize: 11, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// PERSONAL STATUS CARD — hero ring + live stats (all engine logic unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function PersonalStatusCard({ prediction, anchorStartIso, onRevertToGrowatt, hasSnapshot, reasoningLine }: {
  prediction: UserPrediction | null; anchorStartIso: string | null;
  onRevertToGrowatt?: () => void; hasSnapshot?: boolean; reasoningLine?: string;
}) {
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const isOn = prediction?.currentState === 'ON';
  const color = isOn ? T.success : T.danger;
  const offsetStateChip = <OffsetStateChip prediction={prediction} />;
  const elapsed = useElapsedFromIso(anchorStartIso);
  const meta = prediction?.communitySyncMeta;
  const syncElapsed = useElapsedFromIso(meta?.syncedAtIso ?? null);

  const currentSlot = (() => {
    const slots = prediction?.daySchedule ?? [];
    const nowMs = serverNowMs();
    if (atcMode === 'POSITIVE_OFFSET_PENDING' && slots.length > 0) return slots[0];
    // SPEC-FIX B2: in COMMUNITY_SYNCED the engine's daySchedule is already the
    // community-synced (resynced) timeline — the slot containing "now" is the
    // authoritative current window. Fall back to slots[0] when "now" sits in a
    // gap so the remaining-time label still reflects the synced window.
    if (atcMode === 'COMMUNITY_SYNCED' && slots.length > 0) {
      return slots.find(s => {
        const start = new Date(s.startIso).getTime();
        const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
        return nowMs >= start && nowMs < end;
      }) ?? slots[0];
    }
    if (isHolding) return null;
    return slots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    }) ?? null;
  })();

  const remainMinutes = currentSlot?.endIso ? Math.max(0, (new Date(currentSlot.endIso).getTime() - serverNowMs()) / 60000) : null;
  // SPEC-FIX C2: round total minutes ONCE, then split — the old floor/round
  // mix could show e.g. "1 س و 60 د" when remainMinutes was 119.6.
  const remainTotalMin = remainMinutes !== null ? Math.round(remainMinutes) : null;
  const remainH = remainTotalMin !== null ? Math.floor(remainTotalMin / 60) : 0;
  const remainM = remainTotalMin !== null ? remainTotalMin % 60 : 0;
  const remainLabel = remainTotalMin === null ? null : remainTotalMin < 1 ? 'قريباً' : remainH === 0 ? `${remainM} دقيقة` : remainM === 0 ? (remainH === 1 ? 'ساعة' : remainH === 2 ? 'ساعتان' : `${remainH} ساعات`) : `${remainH} س و ${remainM} د`;

  const [revertConfirmVisible, setRevertConfirmVisible] = useState(false);
  const handleRevertPress = useCallback(() => {
    if (Platform.OS === 'web') { setRevertConfirmVisible(true); } else { onRevertToGrowatt?.(); }
  }, [onRevertToGrowatt]);

  const isUncertain = atcMode === 'UNCERTAIN_ZONE' || atcMode === 'الانتظار للحساس الرئيسي ';
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  const overrunLiveClock = useOverrunLiveClock(overrunMin, isUncertain);

  const animColor = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(Animated.sequence([
      Animated.timing(animColor, { toValue: 1, duration: 1800, useNativeDriver: false }),
      Animated.timing(animColor, { toValue: 0, duration: 1800, useNativeDriver: false }),
    ])).start();
  }, []);
  const pulseOpacity = animColor.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] });

  // ── Ring progress (presentational only): elapsed share of the current
  // predicted window. Null when the window can't be measured (e.g. holding
  // OFF in UNCERTAIN_ZONE) → the ring renders dimmed and the line hides.
  const elapsedMin = anchorStartIso ? Math.max(0, (serverNowMs() - new Date(anchorStartIso).getTime()) / 60000) : null;
  const totalWindowMin = (elapsedMin !== null && remainTotalMin !== null) ? elapsedMin + remainTotalMin : null;
  const ringProgress = totalWindowMin && totalWindowMin > 0 ? Math.max(0, Math.min(1, (elapsedMin as number) / totalWindowMin)) : null;
  const ringPct = ringProgress !== null ? Math.round(ringProgress * 100) : null;
  const expectedLabel = isOn ? prediction?.expectedOnDurationLabel : prediction?.expectedOffDurationLabel;
  const expectedWords = expectedLabel ? durationWordsAr(expectedLabel) : null;
  const modePill = MODE_PILL[atcMode] ?? MODE_PILL.NORMAL;
  const windowDays = prediction?.dataWindowHours ? Math.max(1, Math.round(prediction.dataWindowHours / 24)) : null;
  const isSynced = atcMode === 'COMMUNITY_SYNCED';

  const RevertConfirmBanner = revertConfirmVisible ? (
    <View style={psStyles.revertConfirmBox}>
      <Text style={psStyles.revertConfirmText}>{hasSnapshot ? 'هل تريد العودة إلى الحالة الأصلية قبل هذا البلاغ؟ سيتم استعادة جدولك السابق تماماً.' : 'هل تريد العودة إلى جدول الحساس الرئيسي ؟ سيتم إلغاء المزامنة المجتمعية الحالية.'}</Text>
      <View style={psStyles.revertConfirmBtns}>
        <TouchableOpacity style={[psStyles.revertConfirmBtn, psStyles.revertConfirmBtnCancel]} onPress={() => setRevertConfirmVisible(false)} activeOpacity={0.8}>
          <Text style={psStyles.revertConfirmBtnCancelText}>إلغاء</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[psStyles.revertConfirmBtn, psStyles.revertConfirmBtnOk]} onPress={() => { setRevertConfirmVisible(false); onRevertToGrowatt?.(); }} activeOpacity={0.8}>
          <Text style={psStyles.revertConfirmBtnOkText}>تأكيد العودة</Text>
        </TouchableOpacity>
      </View>
    </View>
  ) : null;

  // ── "من سجلك" typical durations (unchanged data, dotted-chip styling) ──
  const DurationsBlock = (prediction?.expectedOnDurationLabel || prediction?.expectedOffDurationLabel) ? (
    <View style={psStyles.durSection}>
      <Text style={psStyles.durSectionTitle}>{windowDays ? `من سجلك خلال آخر ${windowDays} يوماً:` : 'من سجلك:'}</Text>
      <View style={psStyles.durRow}>
        {prediction?.expectedOffDurationLabel ? (
          <View style={psStyles.durChip}>
            <View style={{ flex: 1 }}><Text style={psStyles.durChipLabel}>الانقطاع يستمر عادةً</Text><Text style={[psStyles.durChipValue, { color: T.danger }]}>{durationWordsAr(prediction.expectedOffDurationLabel)}</Text></View>
            <View style={[psStyles.durDot, { backgroundColor: T.danger }]} />
          </View>
        ) : null}
        {prediction?.expectedOnDurationLabel ? (
          <View style={psStyles.durChip}>
            <View style={{ flex: 1 }}><Text style={psStyles.durChipLabel}>الكهرباء تستمر عادةً</Text><Text style={[psStyles.durChipValue, { color: T.success }]}>{durationWordsAr(prediction.expectedOnDurationLabel)}</Text></View>
            <View style={[psStyles.durDot, { backgroundColor: T.success }]} />
          </View>
        ) : null}
      </View>
    </View>
  ) : null;

  const ReasoningBlock = reasoningLine ? (
    <View style={psStyles.reasoningBox}><Text style={psStyles.reasoningText}>💡 {reasoningLine}</Text></View>
  ) : null;

  // ISSUE-FIX (disappearing revert button, spec §28): the revert affordance
  // belongs to the active community-sync BRANCH / stored snapshot — not to
  // the COMMUNITY_SYNCED atc MODE. The mode legitimately flips to NORMAL
  // once the Generated ON becomes the active slot (schedule surgery), which
  // made the button vanish seconds after every app open while the sync was
  // still in effect. Render it whenever a resync branch or snapshot exists.
  const showRevert = meta != null || hasSnapshot === true;
  const RevertBlock = showRevert ? (
    <>
      {RevertConfirmBanner}
      <TouchableOpacity style={psStyles.revertBtn} onPress={handleRevertPress} activeOpacity={0.75}>
        <Text style={psStyles.revertIcon}>↩</Text>
        <Text style={psStyles.revertLabel}>{hasSnapshot ? 'العودة إلى الحالة الأصلية' : 'العودة إلى الحساس الرئيسي '}</Text>
      </TouchableOpacity>
    </>
  ) : null;

  const reporterName = meta?.reporterName ?? 'مجهول';
  const reporterRel = meta?.reporterReliability;

  return (
    <View style={[psStyles.card, { borderColor: color + (isSynced ? '50' : '30') }]}>
      {/* header: title right, live mode pill left */}
      <View style={psStyles.cardHeaderRow}>
        <View style={[psStyles.modePill, { borderColor: modePill.color + '55', backgroundColor: modePill.color + '14' }]}>
          <View style={[psStyles.modePillDot, { backgroundColor: modePill.color }]} />
          <Text style={[psStyles.modePillText, { color: modePill.color }]}>{modePill.label}</Text>
        </View>
        <Text style={psStyles.cardTitle}>⚡ حالة الكهرباء</Text>
      </View>

      {/* hero ring */}
      <View style={psStyles.ringWrap}>
        <StatusRing progress={ringProgress} color={color}>
          <Animated.View style={[psStyles.ringDot, { backgroundColor: color, opacity: pulseOpacity }]} />
          <Text style={[psStyles.ringStatus, { color }]}>{isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية'}</Text>
          {elapsed ? <Text style={psStyles.ringElapsed}>منذ {elapsed}</Text> : null}
        </StatusRing>
      </View>

      {ringPct !== null && (
        <Text style={psStyles.ringPctLine}>
          قطعت <Text style={{ color, fontWeight: '900' }}>{ringPct}%</Text> من مدة {isOn ? 'التشغيل' : 'الانقطاع'} المعتادة{expectedWords ? ` (${expectedWords} تقريباً)` : ''}
        </Text>
      )}

      {offsetStateChip}

      {/* community sync banner (COMMUNITY_SYNCED only) — content unchanged */}
      {isSynced && (
        <View style={[psStyles.communityBanner, { borderColor: T.accent + '44' }]}>
          <View style={{ flex: 1 }}>
            <Text style={psStyles.communityBannerTitle}>تمت مزامنة الحالة عبر المجتمع 🤝</Text>
            <View style={psStyles.communityBannerRow}>
              {reporterRel !== null && reporterRel !== undefined && (<View style={psStyles.reliabilityChip}><Text style={psStyles.reliabilityChipText}>موثوقية {reporterRel}%</Text></View>)}
              <Text style={psStyles.communityBannerReporter}>المُبلِّغ: <Text style={{ color: T.accent, fontWeight: '800' }}>{reporterName}</Text></Text>
            </View>
            {meta?.syncedAtIso && (<Text style={psStyles.communityBannerTime}>تم تأكيد هذه الحالة منذ: {syncElapsed || 'للتو'}</Text>)}
            <Text style={psStyles.communityBannerNote}>⚠ تأكيدك لا يغيّر وقت البلاغ الأصلي ولا الفارق — يُؤثّر فقط على موثوقية المُبلِّغ.</Text>
          </View>
          <Text style={{ fontSize: 30 }}>👥</Text>
        </View>
      )}

      {RevertBlock}

      {/* elapsed / remaining stat cards */}
      {(elapsed || remainLabel) ? (
        <View style={psStyles.timeRow}>
          {elapsed ? (<View style={psStyles.timeBlock}><Text style={psStyles.timeLabel}>منذ (وقت فعلي)</Text><Text style={[psStyles.timeValue, { color: color + 'cc' }]}>{elapsed}</Text></View>) : null}
          {remainLabel ? (<View style={[psStyles.timeBlock, psStyles.timeBlockDashed, { borderColor: color + '77' }]}><Text style={psStyles.timeLabel}>{isSynced ? 'الوقت المتوقع المتبقي:' : 'متبقي (تقديري)'}</Text><Text style={[psStyles.timeValue, { color }]}>{remainLabel}</Text></View>) : null}
        </View>
      ) : null}

      {/* ATC mode badge (never in COMMUNITY_SYNCED) — content unchanged */}
      {!isSynced && (() => {
        const showATCBadge = atcMode !== 'NORMAL';
        if (!showATCBadge) return null;
        const tMode = prediction?.atc?.transitionMode ?? 'AUTO';
        const configs: Record<string, { icon: string; bg: string; border: string; textColor: string }> = {
          PREDICTION_RANGE: { icon: '🔮', bg: TINT.accentBg, border: T.accent + '55', textColor: T.accent },
          UNCERTAIN_ZONE:       { icon: '⚠',  bg: TINT.warningBg, border: T.warning + '55', textColor: T.warning },
          WAITING_FOR_GROWATT:  { icon: '⏳', bg: TINT.warningBg, border: T.warning + '55', textColor: T.warning },
          GRACE_MODE: { icon: '⏳', bg: TINT.accentBg, border: T.warning + '44', textColor: T.warning },
          POSITIVE_OFFSET_PENDING: { icon: '⏰', bg: TINT.accentBg, border: T.accent + '55', textColor: T.accent },
        };
        const cfg = configs[atcMode];
        if (!cfg) return null;
        return (
          <View style={[psStyles.atcBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
            <Text style={[psStyles.atcBadgeLine, { color: cfg.textColor }]}>
              {cfg.icon}  {prediction?.atc?.statusLine ?? atcMode}
            </Text>
            {/* Prominent exceeded-time badge for UNCERTAIN_ZONE / WAITING_FOR_GROWATT */}
            {isUncertain && overrunMin > 0 && (
              <View style={psStyles.exceededBadge}>
                <View style={psStyles.exceededRow}>
                  <Text style={psStyles.exceededIcon}>⏱</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={psStyles.exceededLabel}>تجاوز المدة المتوقعة</Text>
                    <Text style={psStyles.exceededValue}>{fmtOverrunAr(overrunMin)}</Text>
                  </View>
                </View>
                {/* Live HH:MM:SS ticking clock — updates every second */}
                <View style={psStyles.liveClockRow}>
                  <Text style={psStyles.liveClockLabel}>وقت الانتظار الفعلي</Text>
                  <Text style={psStyles.liveClockValue}>{overrunLiveClock}</Text>
                </View>
                {/* SPEC-FIX C3: the deduction note only makes sense for a negative
                    offset (user ON started before Growatt ON). For neutral/positive
                    offsets nothing is deducted, so the note is hidden. */}
                {(prediction?.offsetMinutes ?? 0) < 0 && (
                  <Text style={psStyles.deductionNote}>سيُخصم من مدة التشغيل القادمة</Text>
                )}
              </View>
            )}
            {isUncertain && tMode === 'MANUAL' && (
              <Text style={[psStyles.atcBodyLine, { color: cfg.textColor + 'aa' }]}>وضع يدوي — بلاغك أو تأكيد مجتمعي ينهي الدورة</Text>
            )}
            <Text style={psStyles.atcSubLine}> 👥 بلاغات المجتمع ذات أولوية مرتفعة,في اي لحظة سوف تشتغل الكهرباء لذلك قدم تقرير أثناء حدوث ذلك </Text>
          </View>
        );
      })()}

      {DurationsBlock}{ReasoningBlock}
    </View>
  );
}

const psStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 26, padding: 20, marginBottom: 14, borderWidth: 1.5 },
  cardHeaderRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  cardTitle: { color: T.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2, textAlign: 'right' },
  modePill: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, borderRadius: 20, paddingHorizontal: 11, paddingVertical: 5, borderWidth: 1 },
  modePillDot: { width: 6, height: 6, borderRadius: 3 },
  modePillText: { fontSize: 11, fontWeight: '800' },
  ringWrap: { alignItems: 'center', marginTop: 6, marginBottom: 4 },
  ringDot: { width: 10, height: 10, borderRadius: 5, marginBottom: 10 },
  ringStatus: { fontSize: 27, fontWeight: '900', textAlign: 'center', lineHeight: 34 },
  ringElapsed: { color: T.textSecondary, fontSize: 13.5, fontWeight: '600', textAlign: 'center', marginTop: 6 },
  ringPctLine: { color: T.textSecondary, fontSize: 12.5, fontWeight: '600', textAlign: 'center', marginTop: 10, marginBottom: 2 },
  timeRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 14, marginTop: 4 },
  timeBlock: { flex: 1, backgroundColor: T.elevated, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: 'transparent' },
  timeBlockDashed: { backgroundColor: T.surface, borderStyle: 'dashed' },
  timeLabel: { color: T.textMuted, fontSize: 11.5, fontWeight: '600', textAlign: 'right', marginBottom: 5 },
  timeValue: { fontSize: 21, fontWeight: '800', textAlign: 'right' },
  durSection: { marginTop: 6 },
  durSectionTitle: { color: T.textMuted, fontSize: 11.5, fontWeight: '700', textAlign: 'right', marginBottom: 8 },
  durRow: { flexDirection: 'row-reverse', gap: 8 },
  durChip: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: T.elevated, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: T.border },
  durDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  durChipLabel: { color: T.textMuted, fontSize: 11, fontWeight: '600', marginBottom: 3, textAlign: 'right' },
  durChipValue: { fontSize: 15, fontWeight: '800', textAlign: 'right' },
  communityBanner: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, backgroundColor: TINT.accentBg, borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1 },
  communityBannerTitle: { color: T.accent, fontSize: 13.5, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  communityBannerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 4 },
  communityBannerReporter: { color: T.textSecondary, fontSize: 14.5, textAlign: 'right' },
  communityBannerTime: { color: T.textMuted, fontSize: 12.5, textAlign: 'right' },
  communityBannerNote: { color: T.warning + 'aa', fontSize: 11.5, fontStyle: 'italic', marginTop: 6, textAlign: 'right', lineHeight: 16 },
  reliabilityChip: { backgroundColor: T.success + '20', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: T.success + '44' },
  reliabilityChipText: { color: T.success, fontSize: 11.5, fontWeight: '700' },
  revertBtn: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: TINT.accentBg, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 16, marginBottom: 14, borderWidth: 1.5, borderColor: T.accent + '55', alignSelf: 'stretch' },
  revertIcon: { color: T.accent, fontSize: 17, fontWeight: '700' },
  revertLabel: { color: T.accent, fontSize: 14.5, fontWeight: '700' },
  revertConfirmBox: { backgroundColor: '#0a1929', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.danger + '55' },
  revertConfirmText: { color: T.textSecondary, fontSize: 14, lineHeight: 21, textAlign: 'right', marginBottom: 12 },
  revertConfirmBtns: { flexDirection: 'row-reverse', gap: 10 },
  revertConfirmBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1 },
  revertConfirmBtnCancel: { backgroundColor: T.elevated, borderColor: T.border },
  revertConfirmBtnCancelText: { color: T.textSecondary, fontSize: 14, fontWeight: '700' },
  revertConfirmBtnOk: { backgroundColor: TINT.dangerBg, borderColor: T.danger + '55' },
  revertConfirmBtnOkText: { color: T.danger, fontSize: 14, fontWeight: '800' },
  atcBadge: { borderRadius: 14, padding: 12, marginBottom: 12, borderWidth: 1 },
  atcBadgeLine: { fontSize: 14.5, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  atcBodyLine: { fontSize: 12.5, textAlign: 'right', marginBottom: 4, lineHeight: 18 },
  atcSubLine: { color: T.accent, fontSize: 12.5, textAlign: 'right' },
  exceededBadge: { backgroundColor: '#2d1a00', borderRadius: 12, padding: 10, marginBottom: 8, borderWidth: 1, borderColor: T.warning + '66' },
  exceededRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 8 },
  exceededIcon: { fontSize: 22, flexShrink: 0 },
  exceededLabel: { color: T.warning, fontSize: 11.5, fontWeight: '700', textAlign: 'right', marginBottom: 2 },
  exceededValue: { color: T.warning, fontSize: 22, fontWeight: '900', textAlign: 'right' },
  liveClockRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#1a0a00', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 8 },
  liveClockLabel: { color: T.warning + '99', fontSize: 11.5, fontWeight: '600' },
  liveClockValue: { color: T.warning, fontSize: 22, fontWeight: '900', fontVariant: ['tabular-nums'], letterSpacing: 2 },
  deductionNote: { color: T.warning + 'cc', fontSize: 12.5, fontWeight: '600', textAlign: 'right', fontStyle: 'italic' },
  reasoningBox: { backgroundColor: T.elevated, borderRadius: 12, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.border },
  reasoningText: { color: T.textSecondary, fontSize: 12.5, lineHeight: 19, textAlign: 'right', fontWeight: '500' },
});

// ─────────────────────────────────────────────────────────────────────────────
// UPCOMING TRANSITION CARD — dashed estimate card (screenshot style)
// ─────────────────────────────────────────────────────────────────────────────
function UpcomingTransitionCard({ prediction }: { prediction: UserPrediction | null }) {
  const nt = prediction?.nextTransition ?? null;
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  // SPEC-FIX C1: countdown targets the transition's rangeStart ISO directly.
  const countdownTargetIso = nt?.rangeStartIso ?? null;
  const { h, m, s, total } = useCountdownSec(countdownTargetIso);
  // Progress bar baseline: capture the initial total when the target changes so
  // the bar drains smoothly 1 → 0 against the real remaining time.
  const countdownBaseRef = useRef<{ iso: string | null; total: number }>({ iso: null, total: 0 });
  if (countdownTargetIso !== countdownBaseRef.current.iso) {
    countdownBaseRef.current = { iso: countdownTargetIso, total };
  }
  const progress = countdownBaseRef.current.total > 0 ? Math.max(0, Math.min(1, total / countdownBaseRef.current.total)) : 0;
  const animProg = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(animProg, { toValue: progress, duration: 600, useNativeDriver: false }).start();
  }, [progress]);
  if (!prediction) return null;

  const effectiveNt = (() => {
    if (isHolding && atcMode === 'POSITIVE_OFFSET_PENDING' && !nt && prediction?.atc?.scheduledAutoTransitionIso) {
      const scheduledIso = prediction.atc.scheduledAutoTransitionIso;
      const scheduledMs = new Date(scheduledIso).getTime();
      const minFromNow = Math.max(0, (scheduledMs - serverNowMs()) / 60_000);
      return { type: (prediction.currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON') as 'UTILITY_ON' | 'UTILITY_OFF', rangeStartIso: scheduledIso, rangeEndIso: scheduledIso, rangeLabel: fmtTimeAr(scheduledIso), minFromNowMin: minFromNow, maxFromNowMin: minFromNow, waitLabel: '', inRangeWindow: minFromNow <= 0 };
    }
    // SPEC-FIX B5: while holding (UNCERTAIN_ZONE / WAITING_FOR_GROWATT /
    // GRACE_MODE) the engine's stale "next transition" range belongs to a cycle
    // whose timing is no longer trustworthy — suppress it so the card shows
    // only the hold status instead of a misleading start/end range.
    if (isHolding) return null;
    return nt;
  })();

  if (isHolding && atcMode !== 'NORMAL' && atcMode !== 'COMMUNITY_SYNCED') {
    const isCurrentOn = prediction.currentState === 'ON';
    const tMode = prediction.atc.transitionMode ?? 'AUTO';
    const modeConfigs: Record<string, { icon: string; title: string; body: string; borderColor: string; iconColor: string }> = {
      UNCERTAIN_ZONE: { icon: '⚠️', title: 'استمرار غير معتاد', body: overrunMin > 0 ? `تجاوزت المدة المتوقعة بـ ${fmtOverrunAr(overrunMin)} — قد تعود الكهرباء في أي لحظة الآن. عند تأكيد الحساس (Growatt) يبدأ التشغيل ويُحسب المتبقي من فارقك المخزّن تلقائياً. إذا وصلتك الكهرباء قبل ذلك أرسل بلاغ تغيير الحالة فوراً ليستفيد جيرانك` : 'الكهرباء قد تشتغل في أي لحظة — التغيير محتمل لكنه غير مؤكد بعد. بمجرد أن تصلك الكهرباء أرسل بلاغ تغيير الحالة ليتحدّث توقيتك وتوقيت مجتمعك فوراً', borderColor: T.warning + '44', iconColor: T.warning },
      WAITING_FOR_GROWATT: { icon: '⏳', title: 'بانتظار تأكيد الحساس', body: tMode === 'MANUAL' ? 'وضع يدوي — بلاغك أو تأكيد مجتمعي ينهي الدورة' : 'تجاوزنا نطاق التوقع وبانتظار تأكيد الحساس أو بلاغ مجتمعي — قد تشتغل الكهرباء في أي لحظة. إذا وصلتك الكهرباء أرسل بلاغ تغيير الحالة فوراً', borderColor: T.accent + '44', iconColor: T.accent },
      PREDICTION_RANGE: { icon: '🔮', title: 'نطاق التوقع نشط', body: 'التغيير محتمل الآن — بانتظار تأكيد', borderColor: T.accent + '33', iconColor: T.accent },
      GRACE_MODE: { icon: '⏳', title: 'تأخر غير معتاد', body: 'لا يزال التشغيل مستمراً خارج النطاق المتوقع — سيتم المزامنة فور تغيير الحالة', borderColor: T.warning + '44', iconColor: T.warning },
      POSITIVE_OFFSET_PENDING: { icon: '⏰', title: 'تغيير تلقائي مجدول', body: prediction?.atc?.statusLine ?? 'الحساس الرئيسي حوّل حالته — سيتم التحديث تلقائياً في الوقت المحدد', borderColor: T.accent + '44', iconColor: T.accent },
    };
    const cfg = modeConfigs[atcMode] ?? modeConfigs.UNCERTAIN_ZONE;
    return (
      <View style={[utStyles.card, { borderColor: cfg.borderColor }]}>
        <View style={utStyles.headerRow}>
          <Text style={utStyles.cardTitle}>⚡ التوقع القادم</Text>
        </View>
        <View style={utStyles.holdBox}>
          <View style={{ flex: 1 }}>
            <Text style={[utStyles.holdTitle, { color: cfg.iconColor }]}>{cfg.icon} {cfg.title}</Text>
            <Text style={utStyles.holdBody}>{cfg.body}</Text>
          </View>
        </View>
        {prediction.atc.communityElevated && (
          <View style={utStyles.communityPrioBox}><Text style={utStyles.communityPrioText}>👥 بلاغات المجتمع ذات أولوية مرتفعة الآن — شارك بملاحظاتك</Text></View>
        )}
        {effectiveNt && (
          <View style={utStyles.rangeBox}>
            <Text style={[utStyles.rangeBoxLabel, { color: isCurrentOn ? T.danger : T.success }]}>{effectiveNt.type === 'UTILITY_ON' ? 'من المتوقع أن تشتغل الكهرباء بين:' : 'من المتوقع أن تنطفئ الكهرباء بين:'}</Text>
            <View style={utStyles.rangeTimeStack} dir="ltr">
              <Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(effectiveNt.rangeStartIso) || (effectiveNt as any).earliestFormatted || '—'}</Text>
              {effectiveNt.rangeStartIso !== effectiveNt.rangeEndIso && (<><Text style={utStyles.rangeSep}>و</Text><Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(effectiveNt.rangeEndIso) || (effectiveNt as any).latestFormatted || '—'}</Text></>)}
            </View>
          </View>
        )}
      </View>
    );
  }

  if (!nt) {
    return (
      <View style={[utStyles.card, { borderColor: T.warning + '44' }]}>
        <View style={utStyles.headerRow}>
          <Text style={utStyles.cardTitle}>⚡ التوقع القادم</Text>
        </View>
        <View style={utStyles.holdBox}>
          <Text style={utStyles.holdTitle}>⚠️ لا يوجد توقع متاح حالياً</Text>
          <Text style={utStyles.holdBody}>يستمر التطبيق في التعلم من أنماط الكهرباء. حاول مجدداً خلال دقائق.</Text>
        </View>
      </View>
    );
  }

  const isNextOn = nt.type === 'UTILITY_ON';
  const color = isNextOn ? T.success : T.danger;
  const confPct = prediction.confidence;
  const confText = confPct >= 80 ? 'ثقة مرتفعة' : confPct >= 55 ? 'ثقة متوسطة' : 'ثقة منخفضة';
  const confColor = confPct >= 80 ? T.success : confPct >= 55 ? T.warning : T.danger;
  const showCrisisAwareChip = prediction.isUnstable;
  const slots = prediction.daySchedule ?? [];
  const nextIdx = slots.findIndex(s => { const state: 'ON' | 'OFF' = isNextOn ? 'ON' : 'OFF'; return s.state === state && new Date(s.startIso).getTime() > serverNowMs(); });
  const afterNext = nextIdx >= 0 && nextIdx + 1 < slots.length ? slots[nextIdx + 1] : null;
  const cycles = prediction.cyclesAnalyzed ?? 0;
  const windowDays = Math.max(1, Math.round((prediction.dataWindowHours ?? 24) / 24));

  return (
    <View style={[utStyles.card, { borderColor: color + '55' }]}>
      <View style={utStyles.headerRow}>
        <View style={[utStyles.confBadge, { backgroundColor: confColor + '20', borderColor: confColor + '44' }]}><Text style={[utStyles.confText, { color: confColor }]}>{confText}</Text></View>
        <Text style={utStyles.cardTitle}>⚡ التوقع القادم</Text>
      </View>
      <View style={utStyles.approxPill}>
        <Text style={utStyles.approxPillText}>⏱ تقدير تقريبي — ليس موعداً مؤكداً</Text>
      </View>
      {showCrisisAwareChip && (<View style={utStyles.crisisAwareChip}><Text style={utStyles.crisisAwareChipText}>⚠️ محرك التوقع يتكيّف مع تغيّر النمط — قد تتأثر دقة التوقع</Text></View>)}
      {nt.inRangeWindow && (
        <View style={[utStyles.rangeWindowBadge, { backgroundColor: color + '15', borderColor: color + '66' }]}>
          <Text style={[utStyles.rangeWindowText, { color }]}>🟠 {isNextOn ? 'بدأ نطاق التشغيل المتوقع' : 'بدأ نطاق الانطفاء المتوقع'}</Text>
          <Text style={[utStyles.rangeWindowSub, { color: color + 'aa' }]}>قد يحدث التغيير في أي لحظة</Text>
        </View>
      )}
      <Text style={[utStyles.rangeBoxLabel, { color: T.textSecondary }]}>{isNextOn ? 'يُرجَّح أن تشتغل الكهرباء خلال هذا النطاق:' : 'يُرجَّح أن تنطفئ الكهرباء خلال هذا النطاق:'}</Text>
      <View style={utStyles.rangeTimesRow}>
        <Text style={[utStyles.rangeTimeBig, { color }]}>{fmtTimeAr(nt.rangeStartIso) || (nt as any).earliestFormatted || '—'}</Text>
        <Text style={utStyles.rangeTo}>إلى</Text>
        <Text style={[utStyles.rangeTimeBig, { color }]}>{fmtTimeAr(nt.rangeEndIso) || (nt as any).latestFormatted || '—'}</Text>
      </View>
      {!nt.inRangeWindow && (
        <View style={utStyles.countdownSection}>
          <Text style={utStyles.countdownLabel}>يبدأ النطاق بعد حوالي</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginBottom: 12 }}>
            {h > 0 && (<><View style={utStyles.cdUnit}><Text style={[utStyles.cdVal, { color }]}>{String(h).padStart(2, '0')}</Text><Text style={utStyles.cdSub}>س</Text></View><Text style={[utStyles.cdColon, { color }]}>:</Text></>)}
            <View style={utStyles.cdUnit}><Text style={[utStyles.cdVal, { color }]}>{String(m).padStart(2, '0')}</Text><Text style={utStyles.cdSub}>د</Text></View>
            <Text style={[utStyles.cdColon, { color }]}>:</Text>
            <View style={utStyles.cdUnit}><Text style={[utStyles.cdVal, { color }]}>{String(s).padStart(2, '0')}</Text><Text style={utStyles.cdSub}>ث</Text></View>
          </View>
          <View style={utStyles.progressTrack}>
            <Animated.View style={[utStyles.progressFill, { backgroundColor: color, width: animProg.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
          </View>
          <View style={utStyles.progressLabelsRow}>
            <Text style={[utStyles.progressEdge, { color: color + 'cc' }]}>نطاق التوقع</Text>
            <Text style={utStyles.progressEdge}>الآن</Text>
          </View>
        </View>
      )}
      {afterNext && afterNext.endIso && (
        <View style={utStyles.afterNextBox}>
          <View style={utStyles.afterNextHeaderRow}>
            <View style={[utStyles.afterNextDot, { backgroundColor: afterNext.state === 'ON' ? T.success : T.danger }]} />
            <Text style={utStyles.afterNextLabel}>{afterNext.state === 'ON' ? 'التشغيل التالي المتوقع' : 'الانقطاع التالي المتوقع'}</Text>
          </View>
          <Text style={[utStyles.afterNextVal, { color: afterNext.state === 'ON' ? T.success : T.danger }]}>حوالي {fmtTimeAr(afterNext.startIso)} — {fmtTimeAr(afterNext.endIso)}</Text>
        </View>
      )}
      {cycles > 0 && (
        <Text style={utStyles.footerNote}>التوقع مبني على تحليل {cycles} دورة خلال آخر {windowDays} يوماً. قد تتقدّم الكهرباء أو تتأخّر عن هذا النطاق، فلا تعتمد عليه في الأمور الحرجة.</Text>
      )}
    </View>
  );
}
const utStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 26, padding: 20, marginBottom: 14, borderWidth: 1.5, borderStyle: 'dashed' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: T.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  confBadge: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1 },
  confText: { fontSize: 13, fontWeight: '700' },
  approxPill: { alignSelf: 'flex-start', backgroundColor: TINT.warningBg, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.warning + '55', marginBottom: 14 },
  approxPillText: { color: T.warning, fontSize: 11.5, fontWeight: '800' },
  rangeWindowBadge: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1.5, marginBottom: 14, alignItems: 'center' },
  rangeWindowText: { fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  rangeWindowSub: { fontSize: 12.5, textAlign: 'center' },
  rangeBox: { backgroundColor: T.elevated, borderRadius: 18, padding: 20, marginTop: 12, borderWidth: 1, borderColor: T.border, alignItems: 'center' },
  rangeBoxLabel: { fontSize: 13.5, fontWeight: '600', marginBottom: 12, textAlign: 'center' },
  rangeTimeStack: { alignItems: 'center', gap: 8 },
  rangeTime: { fontSize: 32, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5, writingDirection: 'ltr' },
  rangeTimesRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 18 },
  rangeTimeBig: { fontSize: 34, fontWeight: '900', letterSpacing: -0.5, writingDirection: 'ltr' },
  rangeTo: { color: T.textMuted, fontSize: 15, fontWeight: '700' },
  rangeSep: { fontSize: 14, fontWeight: '600', color: T.textMuted },
  countdownSection: { alignItems: 'center', marginBottom: 6 },
  countdownLabel: { color: T.textMuted, fontSize: 12.5, fontWeight: '600', marginBottom: 10 },
  cdUnit: { alignItems: 'center', minWidth: 44 },
  cdVal: { fontSize: 34, fontWeight: '900', letterSpacing: -1 },
  cdSub: { color: T.textMuted, fontSize: 11.5, marginTop: -2 },
  cdColon: { fontSize: 30, fontWeight: '900', marginBottom: 8 },
  progressTrack: { width: '100%', height: 5, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 5, borderRadius: 3 },
  progressLabelsRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', width: '100%', marginTop: 6 },
  progressEdge: { color: T.textMuted, fontSize: 10.5, fontWeight: '700' },
  afterNextBox: { backgroundColor: T.elevated, borderRadius: 14, padding: 13, marginTop: 10, borderWidth: 1, borderColor: T.border },
  afterNextHeaderRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 7, marginBottom: 5 },
  afterNextDot: { width: 8, height: 8, borderRadius: 4 },
  afterNextLabel: { color: T.textSecondary, fontSize: 12.5, fontWeight: '700' },
  afterNextVal: { fontSize: 16.5, fontWeight: '800', textAlign: 'right' },
  footerNote: { color: T.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 14 },
  holdBox: { flexDirection: 'row-reverse', gap: 12, alignItems: 'flex-start', backgroundColor: T.elevated, borderRadius: 16, padding: 14, marginTop: 4 },
  holdTitle: { fontSize: 16, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  holdBody: { color: T.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'right' },
  communityPrioBox: { backgroundColor: TINT.accentBg, borderRadius: 12, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPrioText: { color: T.accent, fontSize: 12.5, fontWeight: '600', textAlign: 'right' },
  crisisAwareChip: { backgroundColor: TINT.warningBg, borderRadius: 12, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: T.warning + '44' },
  crisisAwareChipText: { color: T.warning, fontSize: 12.5, fontWeight: '600', textAlign: 'right', lineHeight: 18 },
});

// ─────────────────────────────────────────────────────────────────────────────
// COMMUNITY ACTIVITY
// ─────────────────────────────────────────────────────────────────────────────
function CommunityActivity({ pendingAlerts, onViewAll, userId, onReporterPress }: { pendingAlerts: number; onViewAll: () => void; userId?: string; onReporterPress?: (reporterId: string) => void }) {
  const [recentReports, setRecentReports] = useState<any[]>([]);
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const { data: follows } = await supabase.from('follows').select('target_id').eq('requester_id', userId).eq('status', 'accepted').limit(10);
        if (!follows || follows.length === 0) return;
        const targetIds = follows.map((f: any) => f.target_id);
        const { data: reports } = await supabase.from('utility_reports').select('id, reported_state, created_at, reporter_id, reporter:user_profiles!utility_reports_reporter_id_fkey(username)').in('reporter_id', targetIds).order('created_at', { ascending: false }).limit(4);
        if (reports) {
          const reportIds = reports.map((r: any) => r.id);
          const { data: responses } = await supabase.from('resync_responses').select('report_id, response').in('report_id', reportIds).eq('response', 'yes');
          const yesCounts: Record<number, number> = {};
          (responses ?? []).forEach((r: any) => { yesCounts[r.report_id] = (yesCounts[r.report_id] ?? 0) + 1; });
          setRecentReports(reports.map((r: any) => ({ ...r, yesCount: yesCounts[r.id] ?? 0, username: (r.reporter as any)?.username ?? 'مجهول' })));
        }
      } catch (_) {}
    })();
  }, [userId]);
  return (
    <View style={caStyles.card}>
      <View style={caStyles.header}>
        <TouchableOpacity onPress={onViewAll} activeOpacity={0.8}><Text style={caStyles.openBtn}>فتح →</Text></TouchableOpacity>
        <Text style={caStyles.title}>🌐 نشاط المجتمع</Text>
      </View>
      {pendingAlerts > 0 && (
        <TouchableOpacity style={caStyles.alertBanner} onPress={onViewAll} activeOpacity={0.85}>
          <Text style={caStyles.alertArrow}>←</Text>
          <Text style={caStyles.alertText}><Text style={{ color: T.accent, fontWeight: '800' }}>{pendingAlerts}</Text>{' '}تنبيه بانتظار ردّك من شخص تتابعه</Text>
          <View style={caStyles.alertDot} />
        </TouchableOpacity>
      )}
      {recentReports.length > 0 ? recentReports.map((r, i) => {
        const isOn = r.reported_state === 'UTILITY_ON'; const color = isOn ? T.success : T.danger;
        const minutesAgo = Math.round((serverNowMs() - new Date(r.created_at).getTime()) / 60000);
        const timeLabel = minutesAgo < 60 ? `منذ ${minutesAgo} دقيقة` : `منذ ${Math.round(minutesAgo / 60)} ساعة`;
        return (
          <View key={r.id} style={caStyles.reportRow}>
            <View style={caStyles.reportMeta}>{r.yesCount > 0 && <Text style={caStyles.yesCount}>✓ {r.yesCount} موافقة</Text>}<Text style={caStyles.timeAgo}>{timeLabel}</Text></View>
            <View style={caStyles.reportLeft}>
              <Text style={[caStyles.reportState, { color }]}>{isOn ? '⚡ اشتغلت الكهرباء' : '🔴 طفت الكهرباء'}</Text>
              <TouchableOpacity onPress={() => onReporterPress?.(r.reporter_id)} activeOpacity={0.7} disabled={!onReporterPress}>
                <Text style={caStyles.reportUser}>أفاد <Text style={{ color: T.accent, fontWeight: '700' }}>{r.username}</Text></Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      }) : <Text style={caStyles.emptyText}>تابع جيرانك لرؤية بلاغاتهم هنا</Text>}
    </View>
  );
}
const caStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 22, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: T.textMuted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  openBtn: { color: T.accent, fontSize: 14, fontWeight: '700' },
  alertBanner: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: TINT.accentBg, borderRadius: 12, padding: 12, marginBottom: 12, gap: 8, borderWidth: 1, borderColor: T.accent + '44' },
  alertDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  alertText: { color: T.textSecondary, fontSize: 13, flex: 1, textAlign: 'right' },
  alertArrow: { color: T.accent, fontWeight: '700' },
  reportRow: { flexDirection: 'row-reverse', alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.elevated, gap: 10 },
  reportLeft: { flex: 1 },
  reportState: { fontSize: 15, fontWeight: '700', textAlign: 'right', marginBottom: 3 },
  reportUser: { color: T.textMuted, fontSize: 12.5, textAlign: 'right' },
  reportMeta: { alignItems: 'flex-end', gap: 3 },
  timeAgo: { color: T.textMuted, fontSize: 11.5 },
  yesCount: { color: T.success, fontSize: 11.5, fontWeight: '600' },
  emptyText: { color: T.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: 8 },
});

function ParticipationNudge({ userId }: { userId?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const cyclesAgo = new Date(serverNowMs() - 36 * 60 * 60 * 1000).toISOString();
        const { count } = await supabase.from('utility_reports').select('*', { count: 'exact', head: true }).eq('reporter_id', userId).gte('created_at', cyclesAgo);
        if ((count ?? 0) === 0) setShow(true);
      } catch (_) {}
    })();
  }, [userId]);
  if (!show) return null;
  return (
    <View style={pnStyles.banner}>
      <View style={{ flex: 1 }}>
        <Text style={pnStyles.title}>🤝 شارك المجتمع!</Text>
        <Text style={pnStyles.body}>لم تُبلّغ عن أي تغيير منذ فترة. عند تغيّر الكهرباء في حيّك — اضغط{' '}<Text style={{ fontWeight: '800', color: T.accent }}>"الإبلاغ عن تغيير"</Text>{' '}لتُحسّن دقة توقعاتك وتساعد جيرانك. 🎯</Text>
      </View>
      <TouchableOpacity onPress={() => setShow(false)} style={pnStyles.dismissBtn}><Text style={pnStyles.dismissText}>✕</Text></TouchableOpacity>
    </View>
  );
}
const pnStyles = StyleSheet.create({
  banner: { backgroundColor: TINT.accentBg, borderRadius: 18, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.accent + '44', flexDirection: 'row-reverse', gap: 10 },
  title: { color: T.accent, fontSize: 14.5, fontWeight: '800', textAlign: 'right', marginBottom: 6 },
  body: { color: T.textSecondary, fontSize: 13, lineHeight: 21, textAlign: 'right' },
  dismissBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dismissText: { color: T.textMuted, fontSize: 13 },
});

function StabilityBar({ score, label }: { score: number; label: string }) {
  const color = score >= 75 ? T.success : score >= 45 ? T.warning : T.danger;
  const animW = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.timing(animW, { toValue: score, duration: 800, useNativeDriver: false }).start(); }, [score]);
  const arabicLabel = label === 'Stable' ? 'مستقر' : label === 'Slightly Unstable' ? 'غير مستقر نسبياً' : 'غير مستقر';
  return (
    <View style={sbStyles.wrap}>
      <View style={sbStyles.row}><Text style={[sbStyles.score, { color }]}>{score}%  {arabicLabel}</Text><Text style={sbStyles.label}>استقرار النمط</Text></View>
      <View style={sbStyles.track}><Animated.View style={[sbStyles.fill, { backgroundColor: color, width: animW.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]} /></View>
    </View>
  );
}
const sbStyles = StyleSheet.create({
  wrap: { backgroundColor: T.surface, borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 8 },
  label: { color: T.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  score: { fontSize: 13.5, fontWeight: '700' },
  track: { height: 5, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
});

function useStableNextTransition(nt: UserPrediction['nextTransition'] | null | undefined) {
  const ref = useRef<{ key: string; rangeStartIso: string; rangeEndIso: string; rangeLabel: string } | null>(null);
  if (!nt) { ref.current = null; return nt ?? null; }
  const roundedStart = Math.round(new Date(nt.rangeStartIso).getTime() / (5 * 60_000));
  const key = `${nt.type}|${roundedStart}`;
  if (!ref.current || ref.current.key !== key) {
    ref.current = { key, rangeStartIso: nt.rangeStartIso, rangeEndIso: nt.rangeEndIso, rangeLabel: nt.rangeLabel };
  }
  return { ...nt, rangeStartIso: ref.current.rangeStartIso, rangeEndIso: ref.current.rangeEndIso, rangeLabel: ref.current.rangeLabel };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, profile, signOut } = useAuth();
  const { offset, loading: offsetLoading, pendingDSD, clearPendingDSD, saveOffset } = useUserOffset();
  const { resyncPoint, clearResync, applyResync, registerSnapshotCallback } = useResync();
  const { anchor } = useStateAnchor();

  // SPEC-FIX (F13): single shared engine instance — provider lives in
  // (user)/_layout.tsx and also wires the community-offset save callback.
  const { userPrediction, loading: predLoading } = useSharedUserPrediction();
  const { pendingCount } = useResyncNotifications();
  const { score: myScore } = useMyReliability(profile?.id);
  const [refreshing, setRefreshing] = useState(false);
  const [growattOnToastVisible, setGrowattOnToastVisible] = useState(false);

  // ── Growatt ON toast subscription ──────────────────────────────────────────
  // Show 3-second toast when a UTILITY_ON power_event arrives while the user
  // is in UNCERTAIN_ZONE/WAITING_FOR_GROWATT (negative offset), confirming
  // that the immediate ON flip logic has fired.
  useEffect(() => {
    const channel = supabase
      .channel(`growatt_on_toast_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'power_events' }, (payload: any) => {
        const row = payload.new as { event_type?: string };
        if (row.event_type !== 'UTILITY_ON') return;
        const currentMode = userPrediction?.atc?.mode;
        const isNeg = (offset?.offset_minutes ?? 0) < 0;
        if (isNeg && (currentMode === 'UNCERTAIN_ZONE' || currentMode === 'WAITING_FOR_GROWATT')) {
          setGrowattOnToastVisible(true);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userPrediction?.atc?.mode, offset?.offset_minutes]);

  // ── Status Snapshot system ────────────────────────────────────────────────
  const { snapshot, hasSnapshot, captureSnapshot, clearSnapshot } = useStatusSnapshot();
  useEffect(() => {
    registerSnapshotCallback(async (_point) => {
      // F-18: snapshot the full offset semantics so revert restores state +
      // value, not just the numeric minutes. Read from the source of truth:
      // the raw offset_minutes column is a 0 placeholder for PENDING rows,
      // and hook state can be stale right after a realtime echo.
      const pre = user?.id
        ? await readPreActionStateForSnapshot(user.id)
        : { offsetMinutes: offset?.offset_minutes ?? 0, offsetState: (offset as any)?.offset_state ?? null, offsetValue: (offset as any)?.offset_value ?? null, resyncPoint: null };
      await captureSnapshot(
        userPrediction?.currentState ?? 'OFF',
        userPrediction?.currentStateStartIso ?? null,
        pre.offsetMinutes,
        resyncPoint ?? pre.resyncPoint,
        'community_confirm',
        {
          offsetState: pre.offsetState,
          offsetValue: pre.offsetValue,
        },
      );
    });
    return () => registerSnapshotCallback(null);
  }, [registerSnapshotCallback, captureSnapshot, userPrediction, offset, resyncPoint, user?.id]);

  const handleRestoreSnapshot = useCallback(async () => {
    if (!snapshot) return;
    try {
      // ISSUE-FIX (revert-to-neutral): restore the EFFECTIVE offset, not the
      // raw numeric column. For PENDING_NEGATIVE the numeric column is a 0
      // placeholder and the real semantics live in state/value; restoring
      // the raw 0 while keeping a POSITIVE/NEGATIVE state (or restoring a
      // bare 0) made the engine re-derive NEUTRAL 0 — the user saw "revert
      // to neutral" instead of their true previous offset.
      const prevVal = snapshot.previousOffsetValue;
      const prevValNum = prevVal != null && prevVal !== 'PENDING' ? Number(prevVal) : NaN;
      const isPending = snapshot.previousOffsetState === 'PENDING_NEGATIVE' || prevVal === 'PENDING';
      const targetOffset = isPending
        ? 0 // pending keeps the numeric 0 placeholder — resolver fills it at Growatt ON
        : Number.isFinite(prevValNum) ? prevValNum : snapshot.previousOffsetMinutes;
      // AUDIT-FIX (F-18): restore the FULL offset semantics — a bare numeric
      // restore cannot represent NEUTRAL-with-value or PENDING_NEGATIVE and
      // would silently re-derive the wrong offset_state from the sign.
      if (snapshot.previousOffsetState) {
        await saveOffset(targetOffset, {
          state: snapshot.previousOffsetState,
          value: prevVal ?? targetOffset,
        });
      } else {
        await saveOffset(targetOffset);
      }
      try {
        // AUDIT-FIX (F-17): mark EXACTLY the resync_history row recorded in
        // the snapshot. The old code marked the LATEST row — if any newer
        // resync landed after the snapshot, the wrong row got reverted and
        // the row created by this action stayed live.
        let targetRowId: number | null = snapshot.resyncHistoryRowId ?? null;
        if (targetRowId == null) {
          const { data: lastRow } = await supabase.from('resync_history').select('id').eq('user_id', profile?.id ?? '').order('confirmed_at', { ascending: false }).limit(1).maybeSingle();
          targetRowId = lastRow?.id ?? null;
        }
        if (targetRowId != null) {
          const { error: softErr } = await supabase.from('resync_history').update({ reverted_at: new Date().toISOString() }).eq('id', targetRowId);
          if (softErr && (softErr.message.includes('reverted_at') || softErr.message.includes('column'))) {
            await supabase.from('resync_history').delete().eq('id', targetRowId);
          }
        }
      } catch (e) { console.warn('[handleRestoreSnapshot] Failed to revert resync_history row:', e); }
      try { await AsyncStorage.removeItem('tmms_uncertain_zone_entry_iso'); } catch (_) {}
      const oldSyncedAt = resyncPoint?.syncedAtIso ?? snapshot.previousResyncPoint?.syncedAtIso;
      if (oldSyncedAt) {
        try {
          await Promise.all([
            AsyncStorage.removeItem(`tmms_frozen_community_offset_${oldSyncedAt}`),
            AsyncStorage.removeItem(`tmms_frozen_offset_state_${oldSyncedAt}`),
            AsyncStorage.removeItem(`tmms_frozen_alignment_${oldSyncedAt}`),
          ]);
        } catch (_) {}
      }
      // ISSUE-FIX (revert completeness, spec §28): "Revert to Previous
      // State" must restore the state that existed BEFORE the action — if a
      // previous resync branch was active (e.g. an earlier self-report or
      // community clone), revert returns to THAT branch instead of wiping
      // the resync altogether (which dropped the user to the plain Growatt
      // timeline). The snapshot callback that applyResync fires is wiped by
      // the clearSnapshot() right after, so revert stays one-shot.
      if (snapshot.previousResyncPoint) {
        await applyResync(snapshot.previousResyncPoint);
      } else {
        await clearResync();
      }
      await clearSnapshot();
      if (Platform.OS !== 'web') { Alert.alert('تمت العملية', 'تم استعادة حالتك السابقة بالكامل — الجدول، الخط الزمني، والفارق.'); }
    } catch (error) { console.error('خطأ أثناء محاولة استعادة الحالة الأصلية والـ offset:', error); }
  }, [snapshot, saveOffset, clearResync, applyResync, clearSnapshot, profile?.id, resyncPoint?.syncedAtIso]);

  const offsetMs = (offset?.offset_minutes ?? 0) * 60_000;
  const anchorStartIso = (() => {
    if ((userPrediction as any)?.reconciledCycleStartIso) return (userPrediction as any).reconciledCycleStartIso as string;
    // SPEC-FIX B1: only anchor "منذ" on the resync timestamp when the resync
    // actually established the CURRENT ON state (COMMUNITY_SYNCED + ON).
    // Otherwise resyncedAtIso (the moment the community confirmed) is not the
    // user's real state start and the elapsed counter reads wrong.
    const isSyncedOnCurrent = userPrediction?.atc?.mode === 'COMMUNITY_SYNCED' && userPrediction?.currentState === 'ON';
    if (isSyncedOnCurrent && userPrediction?.isResynced && userPrediction.resyncedAtIso) return userPrediction.resyncedAtIso;
    const atcMode = userPrediction?.atc?.mode;
    if (atcMode === 'POSITIVE_OFFSET_PENDING') return userPrediction?.currentStateStartIso ?? null;
    // ISSUE-FIX (منذ after a Generated ON ends): the raw-Growatt anchor is
    // only meaningful for a PLAIN manual-offset user. When a personal
    // timeline is active (community resync / Generated ON), the engine's
    // currentStateStartIso already carries the correct personal start —
    // per spec §16 the OFF begins exactly where the Generated ON ended.
    // Shifting the RAW Growatt anchor here (which matches the displayed
    // state whenever Growatt happens to be in the same ON/OFF state)
    // restarted "منذ" from the real sensor transition — hours off in both
    // directions (Growatt OFF with Generated ON already ended, and Growatt
    // ON with Generated ON already ended).
    const hasPersonalTimeline =
      !!resyncPoint ||
      !!(userPrediction as any)?.generatedOnInfo ||
      !!(userPrediction as any)?.isResynced;
    if (!hasPersonalTimeline && anchor && userPrediction && anchor.state === userPrediction.currentState) return new Date(new Date(anchor.startIso).getTime() + offsetMs).toISOString();
    return userPrediction?.currentStateStartIso ?? null;
  })();

  const stableNextTransition = useStableNextTransition(userPrediction?.nextTransition);
  const stablePrediction = userPrediction ? { ...userPrediction, nextTransition: stableNextTransition } : null;
  const onRefresh = useCallback(() => { setRefreshing(true); setTimeout(() => setRefreshing(false), 1200); }, []);
  const loading = offsetLoading || predLoading;

  // ISSUE-FIX (no-snapshot revert): "العودة إلى Growatt" must actually return
  // the user to the plain Growatt timeline. The old path only cleared the
  // resync point and left the cloned offset in user_offsets, so the engine
  // kept shifting the schedule by the clone's value — the sync was NOT
  // really cancelled. Reset the offset to NEUTRAL 0, mark the active
  // community clone row reverted, and clear the frozen-offset keys.
  const handleRevertToGrowatt = useCallback(async () => {
    try {
      await saveOffset(0, { state: 'NEUTRAL', value: 0 });
      try {
        const uid = user?.id ?? profile?.id ?? '';
        if (uid) {
          const { data: lastRow } = await supabase
            .from('resync_history')
            .select('id')
            .eq('user_id', uid)
            .eq('source', 'community_resync')
            .is('reverted_at', null)
            .order('confirmed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (lastRow?.id != null) {
            await supabase.from('resync_history').update({ reverted_at: new Date().toISOString() }).eq('id', lastRow.id);
          }
        }
      } catch (e) { console.warn('[handleRevertToGrowatt] history revert failed:', e); }
      const oldSyncedAt = resyncPoint?.syncedAtIso;
      if (oldSyncedAt) {
        try {
          await Promise.all([
            AsyncStorage.removeItem(`tmms_frozen_community_offset_${oldSyncedAt}`),
            AsyncStorage.removeItem(`tmms_frozen_offset_state_${oldSyncedAt}`),
            AsyncStorage.removeItem(`tmms_frozen_alignment_${oldSyncedAt}`),
          ]);
        } catch (_) {}
      }
      try { await AsyncStorage.removeItem('tmms_uncertain_zone_entry_iso'); } catch (_) {}
      await clearResync();
      if (Platform.OS !== 'web') { Alert.alert('تمت العملية', 'تم إلغاء المزامنة المجتمعية والعودة إلى جدول الحساس الرئيسي .'); }
    } catch (error) { console.error('خطأ أثناء العودة إلى جدول الحساس الرئيسي :', error); }
  }, [saveOffset, clearResync, user?.id, profile?.id, resyncPoint?.syncedAtIso]);

  const handleRevert = useCallback(() => {
    const confirmMsg = hasSnapshot
      ? 'هل تريد العودة إلى الحالة الأصلية قبل هذا البلاغ؟ سيتم استعادة جدولك وفارق التوقيت (Offset) السابق تماماً.'
      : 'هل تريد العودة إلى جدول الحساس الرئيسي ؟ سيتم إلغاء المزامنة المجتمعية الحالية.';
    const doRestore = hasSnapshot ? handleRestoreSnapshot : handleRevertToGrowatt;
    if (Platform.OS === 'web') { doRestore(); } else {
      Alert.alert(
        hasSnapshot ? 'العودة إلى الحالة الأصلية' : 'العودة إلى الحساس الرئيسي ',
        confirmMsg,
        [{ text: 'إلغاء', style: 'cancel' }, { text: 'تأكيد العودة والاستعادة', style: 'destructive', onPress: () => doRestore() }],
      );
    }
  }, [hasSnapshot, handleRestoreSnapshot, handleRevertToGrowatt]);

  const displayName = profile?.username ?? profile?.email?.split('@')[0] ?? '';

  if (loading && !userPrediction) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={{ color: T.textMuted, marginTop: 12, fontSize: 14 }}>جارٍ تحميل توقيتك…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Toast overlays the ScrollView via absolute positioning */}
      <GrowattOnToast visible={growattOnToastVisible} onDismiss={() => setGrowattOnToastVisible(false)} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
      >
        {/* Header — title right, actions left */}
        <View style={styles.header}>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle}>⚡ حالة الكهرباء</Text>
            <Text style={styles.headerSub}>أهلاً، {displayName} 👋 · {new Date().toLocaleDateString('ar-SA', { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
          </View>
          <View style={styles.headerBtns}>
            {myScore && (
              <View style={styles.reliabilityPill}>
                <Text style={[styles.reliabilityText, { color: getReliabilityBadge(myScore.reliability_score).color }]}>{myScore.reliability_score}%</Text>
              </View>
            )}
            <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/(user)/settings')}>
              <Text style={styles.iconBtnText}>⚙️</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.signOutBtn} onPress={() => signOut()} activeOpacity={0.8}>
              <Text style={styles.signOutIcon}>⏻</Text>
            </TouchableOpacity>
          </View>
        </View>

        {userPrediction?.crisisMode && userPrediction.crisisReason ? (
          <View style={styles.crisisBanner}>
            <View style={styles.crisisIconWrap}><Text style={{ fontSize: 20 }}>⚠️</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.crisisTitle}>محرك التوقع يتكيّف مع نمط متغيّر</Text>
              <Text style={styles.crisisBody}>{translateCrisisReason(userPrediction.crisisReason)}</Text>
            </View>
          </View>
        ) : null}

        {(() => {
          const filtered = (userPrediction as any)?.apppe?.historyDiagnostics?.clientRowsFiltered;
          if (!filtered || filtered === 0) return null;
          return (<View style={styles.historyDiagBadge}><Text style={styles.historyDiagText}>🛡️ تم تجاهل {filtered} صفّاً ملوّثاً من سجلّ الدقّة لمحرك التوقّع</Text></View>);
        })()}

        <ParticipationNudge userId={profile?.id} />
        <PositiveOffsetPendingBanner prediction={stablePrediction} />
        <ValidationWindowToast prediction={stablePrediction} />
        <PersonalStatusCard prediction={stablePrediction} anchorStartIso={anchorStartIso} onRevertToGrowatt={handleRevert} hasSnapshot={hasSnapshot} reasoningLine={stablePrediction?.reasoning?.[0] ?? undefined} />
        <UpcomingTransitionCard prediction={stablePrediction} />
        {stablePrediction && (<StabilityBar score={stablePrediction.stabilityScore} label={stablePrediction.stabilityLabel} />)}
        <CommunityActivity pendingAlerts={pendingCount} onViewAll={() => router.push('/(user)/community')} userId={profile?.id} onReporterPress={(rid) => router.push(`/(user)/reporter/${rid}` as any)} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16 },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, gap: 10 },
  headerTitleWrap: { flex: 1 },
  headerTitle: { color: T.textPrimary, fontSize: 22, fontWeight: '900', textAlign: 'right' },
  headerSub: { color: T.textMuted, fontSize: 12, marginTop: 4, textAlign: 'right' },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2 },
  reliabilityPill: { backgroundColor: T.elevated, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  reliabilityText: { fontSize: 12, fontWeight: '800' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  iconBtnText: { fontSize: 18 },
  signOutBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: TINT.dangerBg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.danger + '30' },
  signOutIcon: { fontSize: 14, color: T.danger },
  crisisBanner: { backgroundColor: TINT.warningBg, borderRadius: 16, padding: 14, marginBottom: 14, flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, borderWidth: 1.5, borderColor: '#92400e' },
  crisisIconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#451a03', alignItems: 'center', justifyContent: 'center' },
  crisisTitle: { color: T.warning, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4, textAlign: 'right' },
  crisisBody: { color: '#fbbf24', fontSize: 12, lineHeight: 19, textAlign: 'right' },
  historyDiagBadge: { backgroundColor: TINT.accentBg, borderRadius: 12, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: T.accent + '55' },
  historyDiagText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right', lineHeight: 16 },
});
