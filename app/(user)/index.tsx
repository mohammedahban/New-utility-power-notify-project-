import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, Animated, Platform, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useTransitionMode } from '../../hooks/useTransitionMode';
import { useUserPredictions, UserPrediction, ScheduleStateMode } from '../../hooks/useUserPredictions';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';
import { useResync } from '../../contexts/ResyncContext';
import { useStatusSnapshot } from '../../hooks/useStatusSnapshot';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';
import type { PendingDSDCandidate } from '../../hooks/useUserOffset';
import type { TransitionMode } from '../../hooks/useTransitionMode';

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

// Translate APPPE v4 crisis reason from English to Arabic
function translateCrisisReason(reason: string): string {
  if (!reason) return reason;
  let r = reason;
  r = r.replace(/Outage durations increased by (\d+)% vs baseline/,
    'مدد الانقطاع ارتفعت بنسبة $1% مقارنةً بالأساس');
  r = r.replace(/possible fuel shortage or schedule change/,
    'ربما بسبب نقص وقود أو تغيير في الجدول');
  r = r.replace(/Prediction center shifted by ([^.]+)/,
    'تم ضبط مركز التوقع بمقدار $1');
  r = r.replace(/ON durations decreased by (\d+)% vs baseline/,
    'مدد التشغيل انخفضت بنسبة $1% مقارنةً بالأساس');
  r = r.replace(/possible generator capacity issue/,
    'ربما بسبب مشكلة في سعة المولد');
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSITION MODE TOGGLE — TMMS V2.2
// Placed at the top of the Home screen.
// AUTO:   Growatt + community + user reports all drive transitions.
// MANUAL: Only community confirmations and user reports drive transitions.
//         Growatt feeds APPPE learning only.
// ─────────────────────────────────────────────────────────────────────────────
function TransitionModeToggle({ mode, onToggle }: {
  mode: TransitionMode;
  onToggle: () => void;
}) {
  const isAuto = mode === 'AUTO';
  const bg       = isAuto ? '#001a2e' : '#1a0a00';
  const border   = isAuto ? T.accent + '55' : T.warning + '55';
  const iconColor = isAuto ? T.accent : T.warning;
  const label    = isAuto ? 'الانتقال التلقائي مفعَّل' : 'الانتقال اليدوي مفعَّل';
  const sub      = isAuto
    ? 'يعتمد على الحساس الرئيسي + التقارير الموثوقة'
    : 'يعتمد فقط على بلاغاتك وتأكيدات المجتمع';
  const icon     = isAuto ? '⚙️' : '✋';

  return (
    <TouchableOpacity
      style={[tmtStyles.wrap, { backgroundColor: bg, borderColor: border }]}
      onPress={onToggle}
      activeOpacity={0.8}
    >
      <View style={tmtStyles.left}>
        <Text style={[tmtStyles.switchLabel, { color: T.textMuted }]}>
          {isAuto ? 'تبديل إلى يدوي' : 'تبديل إلى تلقائي'}
        </Text>
        <View style={[tmtStyles.switchTrack, { backgroundColor: isAuto ? T.accent + '33' : T.warning + '33' }]}>
          <View style={[tmtStyles.switchThumb, {
            backgroundColor: iconColor,
            alignSelf: isAuto ? 'flex-end' : 'flex-start',
          }]} />
        </View>
      </View>
      <View style={{ flex: 1 }}>
        <View style={tmtStyles.labelRow}>
          <Text style={[tmtStyles.modeBadge, { backgroundColor: iconColor + '22', color: iconColor, borderColor: iconColor + '55' }]}>
            {icon}  {isAuto ? 'AUTO' : 'MANUAL'}
          </Text>
          <Text style={[tmtStyles.modeLabel, { color: iconColor }]}>{label}</Text>
        </View>
        <Text style={tmtStyles.modeSub}>{sub}</Text>
      </View>
    </TouchableOpacity>
  );
}

const tmtStyles = StyleSheet.create({
  wrap: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 12,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11,
    marginBottom: 12, borderWidth: 1.5,
  },
  labelRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 3 },
  modeLabel: { fontSize: 13, fontWeight: '800', textAlign: 'right', flex: 1 },
  modeBadge: {
    borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, fontSize: 10,
    fontWeight: '800', borderWidth: 1, overflow: 'hidden', flexShrink: 0,
  },
  modeSub: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  left: { alignItems: 'center', gap: 4 },
  switchLabel: { fontSize: 9, fontWeight: '600', textAlign: 'center', width: 48 },
  switchTrack: { width: 40, height: 22, borderRadius: 11, padding: 3, justifyContent: 'center' },
  switchThumb: { width: 16, height: 16, borderRadius: 8 },
});

// ── Stable elapsed timer ──────────────────────────────────────────────────────
function useElapsedFromIso(startIso: string | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!startIso) { setLabel(''); return; }
    const update = () => {
      const diff = Date.now() - new Date(startIso).getTime();
      const totalMin = Math.floor(diff / 60000);
      if (totalMin < 1) { setLabel('للتو'); return; }
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
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

// ── Countdown hook ────────────────────────────────────────────────────────────
function useCountdownSec(targetMinutes: number | null) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!targetMinutes || targetMinutes <= 0) return { h: 0, m: 0, s: 0, total: 0 };
  const total = Math.max(0, Math.round(targetMinutes * 60) - tick);
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60, total };
}

// ── Format time — Western numerals + Arabic AM/PM suffix, always LTR ──
function fmtTimeAr(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

// ─────────────────────────────────────────────────────────────────────────────
// TMMS V2.2: GENERATED ON BANNER
// When the user's current state is a Generated ON, the Home Screen surfaces
// this prominently. The banner shows: start time, duration, reference ON kind,
// and lifecycle inheritance status.
// ─────────────────────────────────────────────────────────────────────────────
function GeneratedOnBanner({ prediction }: { prediction: UserPrediction | null }) {
  const genOn = prediction?.generatedOnInfo;
  if (!genOn || !prediction?.isGeneratedOnCurrent) return null;

  const isOn = prediction.currentState === 'ON';
  const color = T.success;
  const startTime = new Date(genOn.startIso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
  const durationLabel = genOn.durationMin >= 60
    ? `${Math.floor(genOn.durationMin / 60)}س ${genOn.durationMin % 60}د`
    : `${genOn.durationMin}د`;
  const refTime = new Date(genOn.referenceIso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');

  return (
    <View style={goStyles.banner}>
      <View style={goStyles.iconWrap}>
        <Text style={{ fontSize: 22 }}>⚡</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={goStyles.title}>حالة تشغيل مُولّدة</Text>
        <Text style={goStyles.body}>
          بدأت في <Text style={{ fontWeight: '800', color: T.accent }}>{startTime}</Text>
          {' '}· المدّة المنسوخة من أقرب دورة تشغيل منطقية:{' '}
          <Text style={{ fontWeight: '800', color }}>{durationLabel}</Text>
        </Text>
        <Text style={goStyles.ref}>
          {genOn.referenceKind === 'active'
            ? `🔄 تتبّع دورة مرجعية نشطة (بدأت ${refTime}) — ستتوارث نافذة التحقق ومنطقة UNCERTAIN وإصلاح المدة تلقائياً`
            : `📍 مرجع مكتمل (دورة سابقة بدأت ${refTime}) — المدّة نهائية`}
        </Text>
        <Text style={goStyles.note}>
          ⚡ هذه الحالة حدث فعلي دائم في خطّك الزمني — لا يُحذف ولا يُستبدل.
        </Text>
      </View>
    </View>
  );
}

const goStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#052e16', borderRadius: 16, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.success + '66',
  },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.success, fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5 },
  body: { color: T.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'right', marginBottom: 6 },
  ref: { color: T.textMuted, fontSize: 10, lineHeight: 15, textAlign: 'right', marginBottom: 4 },
  note: { color: T.success + 'aa', fontSize: 10, fontStyle: 'italic', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// TMMS V2.2: PENDING NEGATIVE BANNER
// When the user's offset is PENDING_NEGATIVE (Period 2 report), the Home
// Screen surfaces this. Future ON predictions are marked "Estimated
// (Pending Offset)". The offset auto-resolves when Growatt turns ON.
// ─────────────────────────────────────────────────────────────────────────────
function PendingNegativeBanner({ prediction }: { prediction: UserPrediction | null }) {
  const isPending = prediction?.isPendingNegative ?? false;
  const resolutionIso = prediction?.pendingNegativeResolutionIso ?? null;
  if (!isPending) return null;

  // Countdown to expected Growatt ON
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  let countdownLabel = 'بانتظار تحوّل Growatt القادم';
  if (resolutionIso) {
    const ms = new Date(resolutionIso).getTime() - Date.now();
    if (ms > 0) {
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      countdownLabel = `≈ ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    } else {
      countdownLabel = 'الآن — بانتظار Growatt';
    }
  }

  return (
    <View style={pn2Styles.banner}>
      <View style={pn2Styles.iconWrap}>
        <Text style={{ fontSize: 22 }}>⏳</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={pn2Styles.title}>فارق معلَّق (Pending Negative)</Text>
        <Text style={pn2Styles.body}>
          بلاغك أو بلاغ المُبلِّغ وصل في النصف الثاني من فترة الانطفاء المتوقّعة
          (Period 2). الفارق الزمني سيُحسب تلقائياً بمجرد أن يتحوّل Growatt إلى تشغيل.
        </Text>
        <View style={pn2Styles.countdownRow}>
          <Text style={pn2Styles.countdownLabel}>توقّع الحل:</Text>
          <Text style={pn2Styles.countdownValue}>{countdownLabel}</Text>
        </View>
        <Text style={pn2Styles.note}>
          ⚠ تنبؤات التشغيل القادمة تُعرض كـ "تقديري (فارق معلّق)" حتى يُحلّ الفارق.
        </Text>
      </View>
    </View>
  );
}

const pn2Styles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#1a0e00', borderRadius: 16, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.warning + '66',
  },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.warning, fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5 },
  body: { color: T.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'right', marginBottom: 8 },
  countdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 6 },
  countdownLabel: { color: T.textMuted, fontSize: 10, fontWeight: '600' },
  countdownValue: { color: T.warning, fontSize: 16, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  note: { color: T.warning + 'aa', fontSize: 10, fontStyle: 'italic', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// TMMS V2.2: OFFSET STATE CHIP
// Renders a small chip showing the current OffsetState and OffsetValue.
// Used in the PersonalStatusCard for at-a-glance TMMS visibility.
// ─────────────────────────────────────────────────────────────────────────────
function OffsetStateChip({ prediction }: { prediction: UserPrediction | null }) {
  const state = prediction?.offsetState;
  const value = prediction?.offsetValue;
  if (!state) return null;

  const stateLabelAr: Record<string, string> = {
    POSITIVE: 'فارق إيجابي',
    NEGATIVE: 'فارق سلبي',
    NEUTRAL: 'فارق محايد',
    PENDING_NEGATIVE: 'فارق معلَّق',
  };
  const stateColor: Record<string, string> = {
    POSITIVE: T.success,
    NEGATIVE: T.warning,
    NEUTRAL: T.textMuted,
    PENDING_NEGATIVE: T.warning,
  };
  const color = stateColor[state] ?? T.textMuted;
  const label = stateLabelAr[state] ?? state;
  const valueLabel = value === 'PENDING' || state === 'PENDING_NEGATIVE'
    ? 'بانتظار Growatt'
    : (typeof value === 'number' ? `${value > 0 ? '+' : ''}${value}د` : '');

  return (
    <View style={[osStyles.chip, { borderColor: color + '55', backgroundColor: color + '12' }]}>
      <Text style={[osStyles.label, { color }]}>{label}</Text>
      {valueLabel ? <Text style={[osStyles.value, { color }]}>{valueLabel}</Text> : null}
    </View>
  );
}

const osStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    borderRadius: 10, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1,
    alignSelf: 'flex-start', marginBottom: 12,
  },
  label: { fontSize: 11, fontWeight: '700' },
  value: { fontSize: 13, fontWeight: '900' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Shows when Growatt has already transitioned but user's scheduled time is future.
// V2.2 Short Verification Window: Home Page shows OFF with countdown.
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

  const scheduledMs = new Date(scheduledIso).getTime();
  const nowMs = Date.now();
  const totalSecondsLeft = Math.max(0, Math.round((scheduledMs - nowMs) / 1000));
  const hLeft = Math.floor(totalSecondsLeft / 3600);
  const mLeft = Math.floor((totalSecondsLeft % 3600) / 60);
  const sLeft = totalSecondsLeft % 60;
  const countdownLabel = totalSecondsLeft > 0
    ? `${String(hLeft).padStart(2,'0')}:${String(mLeft).padStart(2,'0')}:${String(sLeft).padStart(2,'0')}`
    : 'الآن';

  const growattTransitionMs = scheduledMs - (prediction?.offsetMinutes ?? 0) * 60_000;
  const totalDurationMs = scheduledMs - growattTransitionMs;
  const elapsedMs = Math.max(0, nowMs - growattTransitionMs);
  const progressPct = totalDurationMs > 0 ? Math.min(1, elapsedMs / totalDurationMs) : 0;

  const isOn = prediction?.currentState === 'ON';
  const nextStateLabel = isOn ? 'طافية' : 'شغالة';
  const nextStateEmoji = isOn ? '🔴' : '⚡';

  const scheduledTimeLabel = new Date(scheduledIso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', 'ص').replace('PM', 'م');

  return (
    <View style={popStyles.banner}>
      <View style={popStyles.iconWrap}>
        <Text style={{ fontSize: 22 }}>⏰</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={popStyles.title}>نافذة التحقق القصيرة (Short Verification)</Text>
        <Text style={popStyles.body}>
          سيتم تغيير حالتك إلى{' '}
          <Text style={{ fontWeight: '800', color: isOn ? T.danger : T.success }}>
            {nextStateEmoji} {nextStateLabel}
          </Text>
          {' '}تلقائياً في الساعة{' '}
          <Text style={{ fontWeight: '800', color: T.accent }}>{scheduledTimeLabel}</Text>
        </Text>
        <View style={popStyles.countdownRow}>
          <Text style={popStyles.countdownLabel}>الوقت المتبقي:</Text>
          <Text style={popStyles.countdownValue}>{countdownLabel}</Text>
        </View>
        <View style={popStyles.progressTrack}>
          <View style={[popStyles.progressFill, { width: `${Math.round(progressPct * 100)}%` }]} />
        </View>
        <View style={popStyles.progressLabels}>
          <Text style={popStyles.progressLabelRight}>تحويل Growatt</Text>
          <Text style={popStyles.progressPct}>{Math.round(progressPct * 100)}%</Text>
          <Text style={popStyles.progressLabelLeft}>وقتك المجدول</Text>
        </View>
        <Text style={popStyles.sub}>الفارق الإيجابي: {prediction?.offsetMinutes ?? 0} دقيقة</Text>
      </View>
    </View>
  );
}

const popStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#001a2e', borderRadius: 16, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.accent + '66',
  },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.accent, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5 },
  body: { color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 8 },
  sub: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginTop: 6 },
  countdownRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 8 },
  countdownLabel: { color: T.textMuted, fontSize: 10, fontWeight: '600' },
  countdownValue: { color: T.accent, fontSize: 18, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  progressTrack: { height: 6, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: 6, backgroundColor: T.accent, borderRadius: 3 },
  progressLabels: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 },
  progressLabelRight: { color: T.textMuted, fontSize: 9 },
  progressLabelLeft: { color: T.accent + 'aa', fontSize: 9 },
  progressPct: { color: T.accent, fontSize: 10, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// V2.2: UNCERTAIN_ZONE BANNER
// Shows when Negative Offset user is waiting in UNCERTAIN_ZONE.
// Displays elapsed waiting time and ON duration deduction info.
// ─────────────────────────────────────────────────────────────────────────────
function UncertainZoneBanner({ prediction }: { prediction: UserPrediction | null }) {
  const atcMode = prediction?.atc?.mode;
  const isUncertain = atcMode === 'UNCERTAIN_ZONE' || prediction?.atc?.isInUncertainZone;
  const elapsedMin = prediction?.atc?.uncertainZoneElapsedMin ?? 0;
  const deductionMin = prediction?.atc?.onDurationDeductionMin ?? 0;

  if (!isUncertain && elapsedMin <= 0) return null;

  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const displayElapsedMin = elapsedMin + tick / 60;
  const h = Math.floor(displayElapsedMin / 60);
  const m = Math.floor(displayElapsedMin % 60);
  const elapsedLabel = h > 0 ? `${h}س ${m}د` : `${m} دقيقة`;

  return (
    <View style={uzStyles.banner}>
      <View style={uzStyles.iconWrap}>
        <Text style={{ fontSize: 22 }}>⚠️</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={uzStyles.title}>منطقة غير مؤكدة (UNCERTAIN_ZONE)</Text>
        <Text style={uzStyles.body}>
          الكهرباء طافية — بانتظار تحوّل Growatt إلى تشغيل...
        </Text>
        <View style={uzStyles.elapsedRow}>
          <Text style={uzStyles.elapsedLabel}>وقت الانتظار المنقضي:</Text>
          <Text style={uzStyles.elapsedValue}>{elapsedLabel}</Text>
        </View>
        {deductionMin > 0 && (
          <Text style={uzStyles.deduction}>
            ⏱ عند التشغيل القادم: سيتم خصم {deductionMin}د من مدة التشغيل
          </Text>
        )}
        <Text style={uzStyles.note}>
          ⚠ هذا الوقت سيُخصم تلقائياً من مدة التشغيل القادمة لحفظ توقيت الدورة.
        </Text>
      </View>
    </View>
  );
}

const uzStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#1a0e00', borderRadius: 16, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.warning + '66',
  },
  iconWrap: { width: 38, height: 38, borderRadius: 19, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  title: { color: T.warning, fontSize: 12, fontWeight: '800', letterSpacing: 0.5, textAlign: 'right', marginBottom: 5 },
  body: { color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 8 },
  elapsedRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 6 },
  elapsedLabel: { color: T.textMuted, fontSize: 10, fontWeight: '600' },
  elapsedValue: { color: T.warning, fontSize: 16, fontWeight: '900', letterSpacing: 1, fontVariant: ['tabular-nums'] },
  deduction: { color: T.accent, fontSize: 11, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  note: { color: T.warning + 'aa', fontSize: 10, fontStyle: 'italic', textAlign: 'right' },
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
        <Text style={vwStyles.body}>
          حالتك مزامَنة مجتمعياً وتظل كما هي. نافذة التحقق: {remaining} دقيقة متبقية.
        </Text>
      </View>
      <TouchableOpacity onPress={() => setDismissed(true)} style={vwStyles.close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={vwStyles.closeText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}

const vwStyles = StyleSheet.create({
  toast: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: '#1a0e00', borderRadius: 14, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.warning + '66',
  },
  title: { color: T.warning, fontSize: 12, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  body: { color: '#fbbf24aa', fontSize: 11, lineHeight: 17, textAlign: 'right' },
  close: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  closeText: { color: T.textMuted, fontSize: 11, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// PENDING DSD CHIP — spec §6.2/§15
// ─────────────────────────────────────────────────────────────────────────────
function PendingDSDChip({ pendingDSD, onCancel }: {
  pendingDSD: PendingDSDCandidate | null;
  onCancel: () => void;
}) {
  if (!pendingDSD) return null;
  const ageMin = Math.round((Date.now() - new Date(pendingDSD.createdAtIso).getTime()) / 60_000);
  const tentative = pendingDSD.tentativeDSD;
  const eventLabel = pendingDSD.eventType === 'UTILITY_ON' ? 'تشغيل' : 'انقطاع';
  return (
    <View style={pdcStyles.chip}>
      <TouchableOpacity onPress={onCancel} style={pdcStyles.cancelBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        <Text style={pdcStyles.cancelText}>✕</Text>
      </TouchableOpacity>
      <View style={{ flex: 1 }}>
        <Text style={pdcStyles.title}>⏳ معايرة DSD بانتظار Growatt</Text>
        <Text style={pdcStyles.body}>بلاغ {eventLabel} · فارق مؤقت: {tentative}د · منذ {ageMin} دقيقة</Text>
        <Text style={pdcStyles.sub}>سيتم تأكيد الفارق تلقائياً عند وصول إشارة Growatt</Text>
      </View>
      <View style={pdcStyles.dot} />
    </View>
  );
}

const pdcStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: '#0c1a0c', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11,
    marginBottom: 12, borderWidth: 1.5, borderColor: T.success + '44',
  },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.success, flexShrink: 0 },
  title: { color: T.success, fontSize: 11, fontWeight: '800', textAlign: 'right', marginBottom: 3 },
  body: { color: T.success + 'cc', fontSize: 11, textAlign: 'right' },
  sub: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginTop: 2 },
  cancelBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  cancelText: { color: T.textMuted, fontSize: 10, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Personal Utility Status Hero Card
// V2.2: shows PERSONAL current state, duration, range, why, waiting.
// V2.2: UNCERTAIN_ZONE shows elapsed waiting + ON duration deduction.
// ─────────────────────────────────────────────────────────────────────────────
function PersonalStatusCard({ prediction, anchorStartIso, onRevertToGrowatt, hasSnapshot, reasoningLine }: {
  prediction: UserPrediction | null;
  anchorStartIso: string | null;
  onRevertToGrowatt?: () => void;
  hasSnapshot?: boolean;
  reasoningLine?: string;
}) {
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const isOn = prediction?.currentState === 'ON';
  const color = isOn ? T.success : T.danger;

  const offsetStateChip = <OffsetStateChip prediction={prediction} />;

  // Elapsed — driven by persistent anchor
  const elapsed = useElapsedFromIso(anchorStartIso);

  // Community sync elapsed
  const meta = prediction?.communitySyncMeta;
  const syncElapsed = useElapsedFromIso(meta?.syncedAtIso ?? null);

  // Remaining time from schedule
  const currentSlot = (() => {
    const slots = prediction?.daySchedule ?? [];
    const nowMs = Date.now();
    if (atcMode === 'POSITIVE_OFFSET_PENDING' && slots.length > 0) {
      return slots[0];
    }
    if (isHolding) return null;
    return slots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    }) ?? null;
  })();

  const remainMinutes = currentSlot?.endIso
    ? Math.max(0, (new Date(currentSlot.endIso).getTime() - Date.now()) / 60000)
    : null;
  const remainH = remainMinutes !== null ? Math.floor(remainMinutes / 60) : 0;
  const remainM = remainMinutes !== null ? Math.round(remainMinutes % 60) : 0;
  const remainLabel = remainMinutes === null ? null
    : remainMinutes < 1 ? 'قريباً'
    : remainH === 0 ? `${remainM} دقيقة`
    : remainM === 0 ? (remainH === 1 ? 'ساعة' : `${remainH} ساعات`)
    : `${remainH} س و ${remainM} د`;

  // Revert confirmation (spec §10)
  const [revertConfirmVisible, setRevertConfirmVisible] = useState(false);
  const handleRevertPress = useCallback(() => {
    if (Platform.OS === 'web') {
      setRevertConfirmVisible(true);
    } else {
      onRevertToGrowatt?.();
    }
  }, [onRevertToGrowatt]);

  const animColor = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(animColor, { toValue: 1, duration: 1800, useNativeDriver: false }),
        Animated.timing(animColor, { toValue: 0, duration: 1800, useNativeDriver: false }),
      ])
    ).start();
  }, []);
  const pulseOpacity = animColor.interpolate({ inputRange: [0, 1], outputRange: [0.65, 1] });

  const RevertConfirmBanner = revertConfirmVisible ? (
    <View style={psStyles.revertConfirmBox}>
      <Text style={psStyles.revertConfirmText}>
        {hasSnapshot
          ? 'هل تريد العودة إلى الحالة الأصلية قبل هذا البلاغ؟ سيتم استعادة جدولك السابق تماماً.'
          : 'هل تريد العودة إلى جدول Growatt؟ سيتم إلغاء المزامنة المجتمعية الحالية.'}
      </Text>
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

  // ── Typical durations ───────────────────────────────────────────
  const DurationsBlock = (prediction?.expectedOnDurationLabel || prediction?.expectedOffDurationLabel) ? (
    <View style={psStyles.durRow}>
      {prediction?.expectedOnDurationLabel ? (
        <View style={[psStyles.durChip, { borderColor: T.success + '44' }]}>
          <View style={{ flex: 1 }}>
            <Text style={psStyles.durChipLabel}>عادةً تستمر الكهرباء:</Text>
            <Text style={[psStyles.durChipValue, { color: T.success }]}>{prediction.expectedOnDurationLabel}</Text>
          </View>
          <Text style={psStyles.durChipIcon}>🟢</Text>
        </View>
      ) : null}
      {prediction?.expectedOffDurationLabel ? (
        <View style={[psStyles.durChip, { borderColor: T.danger + '44' }]}>
          <View style={{ flex: 1 }}>
            <Text style={psStyles.durChipLabel}>عادةً يستمر الانقطاع:</Text>
            <Text style={[psStyles.durChipValue, { color: T.danger }]}>{prediction.expectedOffDurationLabel}</Text>
          </View>
          <Text style={psStyles.durChipIcon}>🔴</Text>
        </View>
      ) : null}
    </View>
  ) : null;

  // ── Reasoning ──────────────────────────────────────────────────
  const ReasoningBlock = reasoningLine ? (
    <View style={psStyles.reasoningBox}>
      <Text style={psStyles.reasoningText}>💡 {reasoningLine}</Text>
    </View>
  ) : null;

  // ── COMMUNITY_SYNCED branch ────────────────────────────────────
  if (atcMode === 'COMMUNITY_SYNCED') {
    const reporterName = meta?.reporterName ?? 'مجهول';
    const reporterRel = meta?.reporterReliability;
    return (
      <View style={[psStyles.card, { borderColor: color + '50' }]}>
        <Text style={psStyles.cardTitle}>⚡ حالتي الكهربائية</Text>
        <View style={psStyles.statusRow}>
          <Animated.Text style={[psStyles.statusIcon, { opacity: pulseOpacity }]}>{isOn ? '⚡' : '🔴'}</Animated.Text>
          <Text style={[psStyles.statusText, { color }]}>{isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية'}</Text>
        </View>
        {offsetStateChip}
        <View style={[psStyles.communityBanner, { borderColor: T.accent + '44' }]}>
          <View style={{ flex: 1 }}>
            <Text style={psStyles.communityBannerTitle}>تمت مزامنة الحالة عبر المجتمع 🤝</Text>
            <View style={psStyles.communityBannerRow}>
              {reporterRel !== null && (
                <View style={psStyles.reliabilityChip}>
                  <Text style={psStyles.reliabilityChipText}>موثوقية {reporterRel}%</Text>
                </View>
              )}
              <Text style={psStyles.communityBannerReporter}>
                المُبلِّغ: <Text style={{ color: T.accent, fontWeight: '800' }}>{reporterName}</Text>
              </Text>
            </View>
            {meta?.syncedAtIso && (
              <Text style={psStyles.communityBannerTime}>تم تأكيد هذه الحالة منذ: {syncElapsed || 'للتو'}</Text>
            )}
            <Text style={psStyles.communityBannerNote}>
              ⚠ تأكيدك لا يغيّر وقت البلاغ الأصلي ولا الفارق — يُؤثّر فقط على موثوقية المُبلِّغ.
            </Text>
          </View>
          <Text style={{ fontSize: 30 }}>👥</Text>
        </View>
        {RevertConfirmBanner}
        <TouchableOpacity style={psStyles.revertBtn} onPress={handleRevertPress} activeOpacity={0.75}>
          <Text style={psStyles.revertIcon}>↩</Text>
          <Text style={psStyles.revertLabel}>
            {hasSnapshot ? 'العودة إلى الحالة الأصلية' : 'العودة إلى Growatt'}
          </Text>
        </TouchableOpacity>
        <View style={psStyles.timeRow}>
          {elapsed ? (
            <View style={psStyles.timeBlock}>
              <Text style={psStyles.timeLabel}>منذ:</Text>
              <Text style={[psStyles.timeValue, { color: color + 'cc' }]}>{elapsed}</Text>
            </View>
          ) : null}
          {remainLabel ? (
            <View style={[psStyles.timeBlock, { borderColor: color + '30', borderWidth: 1 }]}>
              <Text style={psStyles.timeLabel}>الوقت المتوقع المتبقي:</Text>
              <Text style={[psStyles.timeValue, { color }]}>{remainLabel}</Text>
            </View>
          ) : null}
        </View>
        {DurationsBlock}
        {ReasoningBlock}
      </View>
    );
  }

  // ── NORMAL / ATC modes ─────────────────────────────────────────
  const icon = isOn ? '⚡' : '🔴';
  const statusText = isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية';
  const showATCBadge = atcMode !== 'NORMAL';
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  const tMode = prediction?.atc?.transitionMode ?? 'AUTO';
  const uncertainElapsed = prediction?.atc?.uncertainZoneElapsedMin ?? 0;
  const onDeduction = prediction?.atc?.onDurationDeductionMin ?? 0;

  return (
    <View style={[psStyles.card, { borderColor: color + '30' }]}>
      <Text style={psStyles.cardTitle}>⚡ حالتي الكهربائية</Text>
      <View style={psStyles.statusRow}>
        <Animated.Text style={[psStyles.statusIcon, { opacity: pulseOpacity }]}>{icon}</Animated.Text>
        <Text style={[psStyles.statusText, { color }]}>{statusText}</Text>
      </View>
      {offsetStateChip}

      <View style={psStyles.timeRow}>
        {elapsed ? (
          <View style={psStyles.timeBlock}>
            <Text style={psStyles.timeLabel}>منذ:</Text>
            <Text style={[psStyles.timeValue, { color: color + 'cc' }]}>{elapsed}</Text>
          </View>
        ) : null}
        {remainLabel ? (
          <View style={[psStyles.timeBlock, { borderColor: color + '30', borderWidth: 1 }]}>
            <Text style={psStyles.timeLabel}>متبقي تقريباً:</Text>
            <Text style={[psStyles.timeValue, { color }]}>{remainLabel}</Text>
          </View>
        ) : null}
      </View>

      {/* ATC mode badge with V2.2 TMMS-aware messages */}
      {showATCBadge && (() => {
        const configs: Record<string, { icon: string; bg: string; border: string; textColor: string; body?: string }> = {
          PREDICTION_RANGE: { icon: '🔮', bg: '#0a1a2e', border: T.accent + '55', textColor: T.accent },
          UNCERTAIN_ZONE: {
            icon: '⚠',  bg: '#1a0e00', border: T.warning + '55', textColor: T.warning,
            body: uncertainElapsed > 0
              ? `منطقة غير مؤكدة — وقت الانتظار: ${uncertainElapsed}د · خصم من التشغيل القادم: ${onDeduction}د`
              : undefined,
          },
          WAITING_FOR_GROWATT: {
            icon: '⏳', bg: '#0a1a2e', border: T.accent + '44', textColor: T.accent,
            body: tMode === 'MANUAL' ? 'وضع يدوي — بلاغك أو تأكيد مجتمعي ينهي الدورة' : undefined,
          },
          GRACE_MODE: { icon: '⏳', bg: '#0a1a2e', border: T.warning + '44', textColor: T.warning },
          POSITIVE_OFFSET_PENDING: { icon: '⏰', bg: '#001a2e', border: T.accent + '55', textColor: T.accent },
        };
        const cfg = configs[atcMode];
        if (!cfg) return null;
        return (
          <View style={[psStyles.atcBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
            <Text style={[psStyles.atcBadgeLine, { color: cfg.textColor }]}>
              {cfg.icon}  {prediction?.atc?.statusLine ?? atcMode}
            </Text>
            {cfg.body ? (
              <Text style={[psStyles.atcBodyLine, { color: cfg.textColor + 'aa' }]}>{cfg.body}</Text>
            ) : null}
            <Text style={psStyles.atcSubLine}>👥 بلاغات المجتمع ذات أولوية مرتفعة الآن</Text>
          </View>
        );
      })()}

      {DurationsBlock}
      {ReasoningBlock}
    </View>
  );
}

const psStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 22, padding: 20, marginBottom: 14, borderWidth: 1.5 },
  cardTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 16, textAlign: 'right' },
  statusRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14, marginBottom: 18 },
  statusIcon: { fontSize: 44 },
  statusText: { fontSize: 32, fontWeight: '900', flex: 1, textAlign: 'right', lineHeight: 40 },
  timeRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 14 },
  timeBlock: { flex: 1, backgroundColor: T.elevated, borderRadius: 14, padding: 14 },
  timeLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600', textAlign: 'right', marginBottom: 5 },
  timeValue: { fontSize: 17, fontWeight: '800', textAlign: 'right' },
  durRow: { flexDirection: 'row-reverse', gap: 8, marginTop: 4 },
  durChip: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 8, backgroundColor: T.elevated, borderRadius: 12, padding: 10, borderWidth: 1 },
  durChipIcon: { fontSize: 16, flexShrink: 0 },
  durChipLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600', marginBottom: 2, textAlign: 'right' },
  durChipValue: { fontSize: 12, fontWeight: '800', textAlign: 'right' },
  communityBanner: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, backgroundColor: '#001a2e', borderRadius: 16, padding: 14, marginBottom: 14, borderWidth: 1 },
  communityBannerTitle: { color: T.accent, fontSize: 12, fontWeight: '700', textAlign: 'right', marginBottom: 6 },
  communityBannerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 4 },
  communityBannerReporter: { color: T.textSecondary, fontSize: 13, textAlign: 'right' },
  communityBannerTime: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  communityBannerNote: { color: T.warning + 'aa', fontSize: 10, fontStyle: 'italic', marginTop: 6, textAlign: 'right', lineHeight: 15 },
  reliabilityChip: { backgroundColor: T.success + '20', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: T.success + '44' },
  reliabilityChipText: { color: T.success, fontSize: 10, fontWeight: '700' },
  revertBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center',
    gap: 7, backgroundColor: '#0f172a', borderRadius: 12, paddingVertical: 11,
    paddingHorizontal: 16, marginBottom: 14, borderWidth: 1.5, borderColor: T.accent + '55', alignSelf: 'stretch',
  },
  revertIcon: { color: T.accent, fontSize: 16, fontWeight: '700' },
  revertLabel: { color: T.accent, fontSize: 13, fontWeight: '700' },
  revertConfirmBox: { backgroundColor: '#0a1929', borderRadius: 14, padding: 14, marginBottom: 12, borderWidth: 1.5, borderColor: T.danger + '55' },
  revertConfirmText: { color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 12 },
  revertConfirmBtns: { flexDirection: 'row-reverse', gap: 10 },
  revertConfirmBtn: { flex: 1, borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1 },
  revertConfirmBtnCancel: { backgroundColor: T.elevated, borderColor: T.border },
  revertConfirmBtnCancelText: { color: T.textSecondary, fontSize: 13, fontWeight: '700' },
  revertConfirmBtnOk: { backgroundColor: '#1a0505', borderColor: T.danger + '55' },
  revertConfirmBtnOkText: { color: T.danger, fontSize: 13, fontWeight: '800' },
  atcBadge: { borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1 },
  atcBadgeLine: { fontSize: 13, fontWeight: '700', textAlign: 'right', marginBottom: 4 },
  atcBodyLine: { fontSize: 11, textAlign: 'right', marginBottom: 4, lineHeight: 16 },
  atcSubLine: { color: T.accent, fontSize: 11, textAlign: 'right' },
  reasoningBox: { backgroundColor: T.elevated, borderRadius: 10, padding: 10, marginTop: 8, borderWidth: 1, borderColor: T.border },
  reasoningText: { color: T.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Upcoming Expected Transition Hero Card
// V2.2: UNCERTAIN_ZONE shows overrun + ON duration deduction message.
// ─────────────────────────────────────────────────────────────────────────────
function UpcomingTransitionCard({ prediction }: { prediction: UserPrediction | null }) {
  const nt = prediction?.nextTransition ?? null;
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  const uncertainElapsed = prediction?.atc?.uncertainZoneElapsedMin ?? 0;
  const midMin = nt ? (nt.minFromNowMin + nt.maxFromNowMin) / 2 : null;
  const { h, m, s, total } = useCountdownSec(midMin);
  const maxSec = midMin ? midMin * 60 : 1;
  const progress = Math.max(0, Math.min(1, total / Math.max(maxSec, 1)));

  const animProg = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(animProg, { toValue: progress, duration: 600, useNativeDriver: false }).start();
  }, [progress]);

  if (!prediction) return null;

  // V2.2: effectiveNt — use the nextTransition from the engine.
  // The engine now provides rangeStartIso/rangeEndIso aliases, so we can
  // use them directly. The fallback for POSITIVE_OFFSET_PENDING constructs
  // a complete NextTransition-compatible object.
  const effectiveNt = (() => {
    if (
      isHolding &&
      atcMode === 'POSITIVE_OFFSET_PENDING' &&
      !nt &&
      prediction?.atc?.scheduledAutoTransitionIso
    ) {
      const scheduledIso = prediction.atc.scheduledAutoTransitionIso;
      const scheduledMs = new Date(scheduledIso).getTime();
      const minFromNow = Math.max(0, (scheduledMs - Date.now()) / 60_000);
      // V2.2: Return a complete NextTransition-compatible object
      return {
        type: (prediction.currentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON') as 'UTILITY_ON' | 'UTILITY_OFF',
        earliestTime: scheduledIso,
        latestTime: scheduledIso,
        earliestFormatted: fmtTimeAr(scheduledIso),
        latestFormatted: fmtTimeAr(scheduledIso),
        minFromNowMin: minFromNow,
        maxFromNowMin: minFromNow,
        rangeLabel: fmtTimeAr(scheduledIso),
        // V2.2 aliases
        rangeStartIso: scheduledIso,
        rangeEndIso: scheduledIso,
      };
    }
    return nt;
  })();

  // ATC hold card
  if (isHolding && atcMode !== 'NORMAL' && atcMode !== 'COMMUNITY_SYNCED') {
    const isCurrentOn = prediction.currentState === 'ON';
    const tMode = prediction.atc.transitionMode ?? 'AUTO';
    const modeConfigs: Record<string, { icon: string; title: string; body: string; borderColor: string; iconColor: string }> = {
      UNCERTAIN_ZONE: {
        icon: '⚠️', title: 'منطقة غير مؤكدة (UNCERTAIN_ZONE)',
        body: uncertainElapsed > 0
          ? `منطقة غير مؤكدة — وقت الانتظار: ${uncertainElapsed} دقيقة · سيتم خصم هذا الوقت من مدة التشغيل القادمة`
          : 'بانتظار تأكيد تغير الحالة — التغيير محتمل ولكن غير مؤكد',
        borderColor: T.warning + '44', iconColor: T.warning,
      },
      WAITING_FOR_GROWATT: {
        icon: '⏳', title: 'بانتظار تأكيد الحساس',
        body: tMode === 'MANUAL'
          ? 'وضع يدوي — بلاغك أو تأكيد مجتمعي ينهي الدورة'
          : 'تجاوزنا نطاق التوقع. بانتظار تأكيد مجتمعي أو Growatt',
        borderColor: T.accent + '44', iconColor: T.accent,
      },
      PREDICTION_RANGE: {
        icon: '🔮', title: 'نطاق التوقع نشط',
        body: 'التغيير محتمل الآن — بانتظار تأكيد',
        borderColor: T.accent + '33', iconColor: T.accent,
      },
      GRACE_MODE: {
        icon: '⏳', title: 'تأخر غير معتاد',
        body: 'لا يزال التشغيل مستمراً خارج النطاق المتوقع — سيتم المزامنة فور تغيير الحالة',
        borderColor: T.warning + '44', iconColor: T.warning,
      },
      POSITIVE_OFFSET_PENDING: {
        icon: '⏰', title: 'نافذة التحقق القصيرة',
        body: prediction?.atc?.statusLine ?? 'الحساس الرئيسي حوّل حالته — سيتم التحديث تلقائياً في الوقت المحدد',
        borderColor: T.accent + '44', iconColor: T.accent,
      },
    };
    const cfg = modeConfigs[atcMode] ?? modeConfigs.UNCERTAIN_ZONE;
    return (
      <View style={[utStyles.card, { borderColor: cfg.borderColor }]}>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
        <View style={utStyles.holdBox}>
          <View style={{ flex: 1 }}>
            <Text style={[utStyles.holdTitle, { color: cfg.iconColor }]}>{cfg.icon} {cfg.title}</Text>
            <Text style={utStyles.holdBody}>{cfg.body}</Text>
          </View>
        </View>
        {prediction.atc.communityElevated && (
          <View style={utStyles.communityPrioBox}>
            <Text style={utStyles.communityPrioText}>👥 بلاغات المجتمع ذات أولوية مرتفعة الآن — شارك بملاحظاتك</Text>
          </View>
        )}
        {effectiveNt && (
          <View style={utStyles.rangeBox}>
            <Text style={[utStyles.rangeBoxLabel, { color: isCurrentOn ? T.danger : T.success }]}>
              {effectiveNt.type === 'UTILITY_ON' ? 'من المتوقع أن تشتغل الكهرباء بين:' : 'من المتوقع أن تنطفئ الكهرباء بين:'}
            </Text>
            <View style={utStyles.rangeTimeStack} dir="ltr">
              {/* V2.2: Use earliestTime/latestTime (with rangeStartIso/rangeEndIso aliases) */}
              <Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(effectiveNt.rangeStartIso ?? effectiveNt.earliestTime)}</Text>
              {(effectiveNt.rangeStartIso ?? effectiveNt.earliestTime) !== (effectiveNt.rangeEndIso ?? effectiveNt.latestTime) && (
                <>
                  <Text style={utStyles.rangeSep}>و</Text>
                  <Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(effectiveNt.rangeEndIso ?? effectiveNt.latestTime)}</Text>
                </>
              )}
            </View>
          </View>
        )}
      </View>
    );
  }

  // No prediction available
  if (!nt) {
    return (
      <View style={[utStyles.card, { borderColor: T.warning + '44' }]}>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
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
  const confColor = confPct >= 80 ? T.success : confPct >= 55 ? T.warning : confPct < 55 ? T.danger : T.textMuted;

  const showCrisisAwareChip = prediction.isUnstable;

  const slots = prediction.daySchedule ?? [];
  const nextIdx = slots.findIndex(s => {
    const state: 'ON' | 'OFF' = isNextOn ? 'ON' : 'OFF';
    return s.state === state;
  });
  const showRangeSecondary = nextIdx >= 0 && slots[nextIdx]?.endIso;

  return (
    <View style={[utStyles.card, { borderColor: color + '44' }]}>
      <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>

      {showCrisisAwareChip && (
        <View style={utStyles.crisisChip}>
          <Text style={utStyles.crisisChipText}>⚠️ تنبؤ مُتكيّف — الأنماط غير مستقرة</Text>
        </View>
      )}

      {/* Countdown ring */}
      <View style={utStyles.countdownRing}>
        <View style={utStyles.countdownInner}>
          <Text style={[utStyles.countdownState, { color }]}>
            {isNextOn ? '⚡ تشغيل' : '🔴 انطفاء'}
          </Text>
          <Text style={utStyles.countdownTime}>
            {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}
          </Text>
          <Text style={utStyles.countdownLabel}>تقريباً</Text>
        </View>
        <View style={utStyles.ringTrack}>
          <Animated.View style={[
            utStyles.ringFill,
            {
              borderColor: color,
              transform: [{
                rotate: animProg.interpolate({
                  inputRange: [0, 1],
                  outputRange: ['0deg', '360deg'],
                }),
              }],
            },
          ]} />
        </View>
      </View>

      {/* Time range */}
      <View style={utStyles.rangeBox}>
        <Text style={[utStyles.rangeBoxLabel, { color }]}>
          {isNextOn ? 'من المتوقع أن تشتغل الكهرباء بين:' : 'من المتوقع أن تنطفئ الكهرباء بين:'}
        </Text>
        <View style={utStyles.rangeTimeStack} dir="ltr">
          {/* V2.2: Use rangeStartIso alias (or fallback to earliestTime) */}
          <Text style={[utStyles.rangeTime, { color }]}>{fmtTimeAr(nt.rangeStartIso ?? nt.earliestTime)}</Text>
          {(nt.rangeStartIso ?? nt.earliestTime) !== (nt.rangeEndIso ?? nt.latestTime) && (
            <>
              <Text style={utStyles.rangeSep}>و</Text>
              <Text style={[utStyles.rangeTime, { color }]}>{fmtTimeAr(nt.rangeEndIso ?? nt.latestTime)}</Text>
            </>
          )}
        </View>
        {showRangeSecondary && (
          <Text style={utStyles.rangeSecondary}>
            {isNextOn ? '⚡' : '🔴'} المتوقع {fmtTimeAr(slots[nextIdx].startIso)} → {fmtTimeAr(slots[nextIdx].endIso!)}
          </Text>
        )}
      </View>

      {/* Confidence bar */}
      <View style={utStyles.confBar}>
        <View style={[utStyles.confFill, { width: `${confPct}%`, backgroundColor: confColor }]} />
      </View>
      <Text style={[utStyles.confText, { color: confColor }]}>{confText} · {confPct}%</Text>
    </View>
  );
}

const utStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 22, padding: 20, marginBottom: 14, borderWidth: 1.5 },
  cardTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 16, textAlign: 'right' },
  countdownRing: { alignItems: 'center', marginBottom: 20 },
  countdownInner: { alignItems: 'center', zIndex: 1 },
  countdownState: { fontSize: 18, fontWeight: '800', marginBottom: 6 },
  countdownTime: { color: T.textPrimary, fontSize: 36, fontWeight: '900', fontVariant: ['tabular-nums'] },
  countdownLabel: { color: T.textMuted, fontSize: 11, marginTop: 4 },
  ringTrack: { position: 'absolute', width: 140, height: 140, borderRadius: 70, borderWidth: 4, borderColor: T.elevated, justifyContent: 'center', alignItems: 'center' },
  ringFill: { position: 'absolute', width: 140, height: 140, borderRadius: 70, borderWidth: 4, borderTopColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: 'transparent' },
  rangeBox: { backgroundColor: T.elevated, borderRadius: 14, padding: 14, marginBottom: 14 },
  rangeBoxLabel: { fontSize: 12, fontWeight: '700', textAlign: 'right', marginBottom: 8 },
  rangeTimeStack: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, justifyContent: 'center' },
  rangeTime: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rangeSep: { color: T.textMuted, fontSize: 13 },
  rangeSecondary: { color: T.textMuted, fontSize: 11, textAlign: 'center', marginTop: 8 },
  confBar: { height: 6, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden', marginBottom: 6 },
  confFill: { height: 6, borderRadius: 3 },
  confText: { fontSize: 11, fontWeight: '700', textAlign: 'right' },
  crisisChip: { backgroundColor: T.warning + '15', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, marginBottom: 12, borderWidth: 1, borderColor: T.warning + '33', alignSelf: 'flex-start' },
  crisisChipText: { color: T.warning, fontSize: 10, fontWeight: '700' },
  holdBox: { backgroundColor: T.elevated, borderRadius: 14, padding: 16, marginBottom: 14 },
  holdTitle: { fontSize: 15, fontWeight: '800', textAlign: 'right', marginBottom: 6 },
  holdBody: { color: T.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'right' },
  communityPrioBox: { backgroundColor: T.accent + '10', borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: T.accent + '33' },
  communityPrioText: { color: T.accent, fontSize: 11, fontWeight: '700', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);

  const { offset, pendingDSD, clearPendingDSD } = useUserOffset();
  const { mode: transitionMode, toggle: toggleTransitionMode } = useTransitionMode();
  const { resyncPoint, applyResync, clearResync } = useResync();
  const { captureSnapshot } = useStatusSnapshot();
  const { anchor } = useStateAnchor();

  const { userPrediction, loading } = useUserPredictions(
    offset?.offset_minutes ?? 0,
    resyncPoint,
    transitionMode,
    anchor?.startIso ?? null,
  );

  const { score: myScore } = useMyReliability(user?.id);

  // Check if a snapshot exists (for revert button label)
  useEffect(() => {
    setHasSnapshot(!!userPrediction?.isResynced);
  }, [userPrediction?.isResynced]);

  const handleRevertToGrowatt = useCallback(async () => {
    Alert.alert(
      'العودة إلى Growatt',
      'هل أنت متأكد؟ سيتم إلغاء المزامنة المجتمعية الحالية والعودة إلى جدول Growatt.',
      [
        { text: 'إلغاء', style: 'cancel' },
        {
          text: 'تأكيد',
          style: 'destructive',
          onPress: async () => {
            await clearResync();
          },
        },
      ]
    );
  }, [clearResync]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // The 30s tick in useUserPredictions will naturally refresh
    setTimeout(() => setRefreshing(false), 1000);
  }, []);

  // Crisis banner
  const crisisActive = userPrediction?.crisisMode ?? false;
  const crisisReason = userPrediction?.crisisReason ?? '';

  // Reasoning line (pick the first one)
  const reasoningLine = userPrediction?.reasoning?.[0] ?? '';

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
      showsVerticalScrollIndicator={false}
    >
      {/* Crisis banner */}
      {crisisActive && crisisReason && (
        <View style={styles.crisisBanner}>
          <Text style={styles.crisisTitle}>⚠️ أزمة كهرباء مكتشفة</Text>
          <Text style={styles.crisisBody}>{translateCrisisReason(crisisReason)}</Text>
        </View>
      )}

      {/* Transition mode toggle */}
      <TransitionModeToggle mode={transitionMode} onToggle={toggleTransitionMode} />

      {/* Pending DSD chip */}
      <PendingDSDChip pendingDSD={pendingDSD} onCancel={clearPendingDSD} />

      {/* V2.2: Generated ON banner */}
      <GeneratedOnBanner prediction={userPrediction} />

      {/* V2.2: Pending Negative banner */}
      <PendingNegativeBanner prediction={userPrediction} />

      {/* V2.2: UNCERTAIN_ZONE banner */}
      <UncertainZoneBanner prediction={userPrediction} />

      {/* V2.2: Positive Offset Pending banner */}
      <PositiveOffsetPendingBanner prediction={userPrediction} />

      {/* V2.2: Validation window toast */}
      <ValidationWindowToast prediction={userPrediction} />

      {/* Section 1: Personal Status Card */}
      <PersonalStatusCard
        prediction={userPrediction}
        anchorStartIso={anchor?.startIso ?? null}
        onRevertToGrowatt={handleRevertToGrowatt}
        hasSnapshot={hasSnapshot}
        reasoningLine={reasoningLine}
      />

      {/* Section 2: Upcoming Transition Card */}
      <UpcomingTransitionCard prediction={userPrediction} />

      {/* V2.2 info footer */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          TMMS V2.2 — نموذج استبدال الخطّ الزمني الشخصي
        </Text>
        <Text style={styles.footerSub}>
          {userPrediction?.offsetState
            ? `الفارق الحالي: ${userPrediction.offsetState} · ${typeof userPrediction.offsetValue === 'number' ? (userPrediction.offsetValue > 0 ? '+' : '') + userPrediction.offsetValue + 'د' : 'بانتظار Growatt'}`
            : 'الفارق: غير محدد'}
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  crisisBanner: {
    backgroundColor: '#2a0a0a', borderRadius: 14, padding: 14, marginBottom: 12,
    borderWidth: 1.5, borderColor: T.danger + '66',
  },
  crisisTitle: { color: T.danger, fontSize: 13, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  crisisBody: { color: T.danger + 'cc', fontSize: 11, lineHeight: 17, textAlign: 'right' },
  footer: { alignItems: 'center', marginTop: 8, marginBottom: 16 },
  footerText: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  footerSub: { color: T.textMuted + '88', fontSize: 9, marginTop: 2 },
});
