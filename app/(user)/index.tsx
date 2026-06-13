
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

// ─────────────────────────────────────────────────────────────────────────────
// TRANSITION MODE TOGGLE — TMMS
// Placed at the top of the Home screen (spec: §TRANSITION MODES).
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

// ── Format time — Western numerals + Arabic AM/PM suffix, always LTR (spec §20) ──
function fmtTimeAr(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE OFFSET PENDING BANNER (User B)
// Shows when Growatt has already transitioned but user's scheduled time is future.
// Spec §POSITIVE OFFSET BEHAVIOR: "سيتم تغيير حالتك تلقائياً في الساعة [HH:MM]"
// ─────────────────────────────────────────────────────────────────────────────
function PositiveOffsetPendingBanner({ prediction }: { prediction: UserPrediction | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const atcMode = prediction?.atc?.mode;
  const scheduledIso = prediction?.atc?.scheduledAutoTransitionIso;
  if (atcMode !== 'POSITIVE_OFFSET_PENDING' || !scheduledIso) return null;

  const scheduledMs = new Date(scheduledIso).getTime();
  const minutesLeft = Math.max(0, Math.round((scheduledMs - Date.now()) / 60_000));
  const isOn = prediction?.currentState === 'ON';
  const nextStateLabel = isOn ? ' طافية ' : ' شغالة ';
  const nextStateEmoji = isOn ? ' 🔴 ' : ' ⚡ ';
  
  // حساب الوقت الحقيقي لتغير الحساس (بدلاً من طباعة قيمة الأوفست الثابتة)
  const offsetMs = (prediction?.offsetMinutes ?? 0) * 60_000;
  const growattTransitionMs = scheduledMs - offsetMs;
  const growattAgoMin = Math.max(0, Math.round((Date.now() - growattTransitionMs) / 60_000));

  const scheduledTimeLabel = new Date(scheduledIso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص ').replace('PM', ' م ');

  return (
    <View style={popStyles.banner}>
      <View style={popStyles.iconWrap}>
        <Text style={{ fontSize: 22 }}> ⏰ </Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={popStyles.title}> تغيير   تلقائي   مجدول </Text>
        <Text style={popStyles.body}>
           سيتم   تغيير   حالتك   إلى {' '}
          <Text style={{ fontWeight: '800', color: isOn ? T.danger : T.success }}>
            {nextStateEmoji} {nextStateLabel}
          </Text>
          {' '} تلقائياً   في   الساعة {' '}
          <Text style={{ fontWeight: '800', color: T.accent }}>{scheduledTimeLabel}</Text>
          {minutesLeft > 0 ? ` ·  بعد  ${minutesLeft}  دقيقة ` : ' ·  الآن '}
        </Text>
        <Text style={popStyles.sub}> الحساس   الرئيسي   حوّل   حالته   منذ  {growattAgoMin}  دقيقة </Text>
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
  body: { color: T.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'right', marginBottom: 4 },
  sub: { color: T.textMuted, fontSize: 10, textAlign: 'right' },
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
// Spec §17/§21: shows PERSONAL current state, duration, range, why, waiting.
// Spec §22: community sync card with reporter name + reliability always shown.
// Spec §23: typical durations in human-friendly Arabic.
// TMMS: UNCERTAIN_ZONE shows overrun + accumulation message.
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

  // Elapsed — driven by persistent anchor, never resets on prediction refresh
  const elapsed = useElapsedFromIso(anchorStartIso);

  // Community sync elapsed — unconditional (Rules of Hooks)
  const meta = prediction?.communitySyncMeta;
  const syncElapsed = useElapsedFromIso(meta?.syncedAtIso ?? null);

  // Remaining time from schedule
  const currentSlot = (() => {
    const slots = prediction?.daySchedule ?? [];
    const nowMs = Date.now();
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
      // Native Alert is handled by Home screen's handleRevert (passed via onRevertToGrowatt)
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

  // ── Typical durations (spec §23) ─────────────────────────────────────────
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

  // ── Reasoning (spec §21) ──────────────────────────────────────────────────
  const ReasoningBlock = reasoningLine ? (
    <View style={psStyles.reasoningBox}>
      <Text style={psStyles.reasoningText}>💡 {reasoningLine}</Text>
    </View>
  ) : null;

  // ── COMMUNITY_SYNCED branch (spec §22) ────────────────────────────────────
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

  // ── NORMAL / ATC modes ────────────────────────────────────────────────────
  const icon = isOn ? '⚡' : '🔴';
  const statusText = isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية';
  const showATCBadge = atcMode !== 'NORMAL';
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  const tMode = prediction?.atc?.transitionMode ?? 'AUTO';

  return (
    <View style={[psStyles.card, { borderColor: color + '30' }]}>
      <Text style={psStyles.cardTitle}>⚡ حالتي الكهربائية</Text>
      <View style={psStyles.statusRow}>
        <Animated.Text style={[psStyles.statusIcon, { opacity: pulseOpacity }]}>{icon}</Animated.Text>
        <Text style={[psStyles.statusText, { color }]}>{statusText}</Text>
      </View>
      <View style={psStyles.timeRow}>
        {elapsed ? (
          <View style={psStyles.timeBlock}>
            <Text style={psStyles.timeLabel}>منذ:</Text>
            <Text style={[psStyles.timeValue, { color: color + 'cc' }]}>{elapsed}</Text>
          </View>
        ) : null}
        {remainLabel && !showATCBadge ? (
          <View style={[psStyles.timeBlock, { borderColor: color + '30', borderWidth: 1 }]}>
            <Text style={psStyles.timeLabel}>متبقي تقريباً:</Text>
            <Text style={[psStyles.timeValue, { color }]}>{remainLabel}</Text>
          </View>
        ) : null}
      </View>

      {/* ATC mode badge with TMMS-aware messages (spec §16/§UNCERTAIN_ZONE) */}
      {showATCBadge && (() => {
        const configs: Record<string, { icon: string; bg: string; border: string; textColor: string; body?: string }> = {
          PREDICTION_RANGE: { icon: '🔮', bg: '#0a1a2e', border: T.accent + '55', textColor: T.accent },
          UNCERTAIN_ZONE: {
            icon: '⚠',  bg: '#1a0e00', border: T.warning + '55', textColor: T.warning,
            body: overrunMin > 0
              ? `تجاوزت المدة المتوقعة بـ ${overrunMin} دقيقة — وقت الانتظار سيُجمع إلى المدة الفعلية`
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
// Spec §19: range PRIMARY — stacked layout. Spec §20: LTR Western numerals.
// TMMS: UNCERTAIN_ZONE shows overrun + accumulation message.
// ─────────────────────────────────────────────────────────────────────────────
function UpcomingTransitionCard({ prediction }: { prediction: UserPrediction | null }) {
  const nt = prediction?.nextTransition ?? null;
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const overrunMin = Math.ceil(prediction?.atc?.overrunMinutes ?? 0);
  const midMin = nt ? (nt.minFromNowMin + nt.maxFromNowMin) / 2 : null;
  const { h, m, s, total } = useCountdownSec(midMin);
  const maxSec = midMin ? midMin * 60 : 1;
  const progress = Math.max(0, Math.min(1, total / Math.max(maxSec, 1)));

  const animProg = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(animProg, { toValue: progress, duration: 600, useNativeDriver: false }).start();
  }, [progress]);

  if (!prediction) return null;

  // ATC hold card
  if (isHolding && atcMode !== 'NORMAL' && atcMode !== 'COMMUNITY_SYNCED') {
    const isCurrentOn = prediction.currentState === 'ON';
    const tMode = prediction.atc.transitionMode ?? 'AUTO';
    const modeConfigs: Record<string, { icon: string; title: string; body: string; borderColor: string; iconColor: string }> = {
      UNCERTAIN_ZONE: {
        icon: '⚠️', title: 'استمرار غير معتاد',
        body: overrunMin > 0
          ? `تجاوزت المدة المتوقعة بـ ${overrunMin} دقيقة — هذا الوقت سيُجمع إلى المدة الفعلية للدورة`
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
        icon: '⏰', title: 'تغيير تلقائي مجدول',
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
        {nt && (
          <View style={utStyles.rangeBox}>
            <Text style={[utStyles.rangeBoxLabel, { color: isCurrentOn ? T.danger : T.success }]}>
              {nt.type === 'UTILITY_ON' ? 'من المتوقع أن تشتغل الكهرباء بين:' : 'من المتوقع أن تنطفئ الكهرباء بين:'}
            </Text>
            <View style={utStyles.rangeTimeStack} dir="ltr">
              <Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(nt.rangeStartIso)}</Text>
              <Text style={utStyles.rangeSep}>و</Text>
              <Text style={[utStyles.rangeTime, { color: isCurrentOn ? T.danger : T.success }]}>{fmtTimeAr(nt.rangeEndIso)}</Text>
            </View>
          </View>
        )}
      </View>
    );
  }

  if (prediction.isUnstable || !nt) {
    return (
      <View style={[utStyles.card, { borderColor: T.warning + '44' }]}>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
        <View style={utStyles.holdBox}>
          <Text style={utStyles.holdTitle}>⚠️ النمط غير مستقر مؤقتاً</Text>
          <Text style={utStyles.holdBody}>لا توجد توقعات موثوقة حالياً. يستمر التطبيق في التعلم.</Text>
        </View>
      </View>
    );
  }

  const isNextOn = nt.type === 'UTILITY_ON';
  const color = isNextOn ? T.success : T.danger;
  const confPct = prediction.confidence;
  const confText = confPct >= 80 ? 'ثقة مرتفعة' : confPct >= 55 ? 'ثقة متوسطة' : 'ثقة منخفضة';
  const confColor = confPct >= 80 ? T.success : confPct >= 55 ? T.warning : T.danger;

  const slots = prediction.daySchedule ?? [];
  const nextIdx = slots.findIndex(s => {
    const state: 'ON' | 'OFF' = isNextOn ? 'ON' : 'OFF';
    return s.state === state && new Date(s.startIso).getTime() > Date.now();
  });
  const afterNext = nextIdx >= 0 && nextIdx + 1 < slots.length ? slots[nextIdx + 1] : null;

  return (
    <View style={[utStyles.card, { borderColor: color + '30' }]}>
      <View style={utStyles.headerRow}>
        <View style={[utStyles.confBadge, { backgroundColor: confColor + '20', borderColor: confColor + '44' }]}>
          <Text style={[utStyles.confText, { color: confColor }]}>{confText}</Text>
        </View>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
      </View>

      {nt.inRangeWindow && (
        <View style={[utStyles.rangeWindowBadge, { backgroundColor: color + '15', borderColor: color + '66' }]}>
          <Text style={[utStyles.rangeWindowText, { color }]}>
            🟠 {isNextOn ? 'بدأ نطاق التشغيل المتوقع' : 'بدأ نطاق الانطفاء المتوقع'}
          </Text>
          <Text style={[utStyles.rangeWindowSub, { color: color + 'aa' }]}>قد يحدث التغيير في أي لحظة</Text>
        </View>
      )}

      {/* PRIMARY: stacked range (spec §19), LTR (spec §20) */}
      <View style={[utStyles.rangeBox, { borderColor: color + '25' }]}>
        <Text style={[utStyles.rangeBoxLabel, { color }]}>
          {isNextOn ? 'من المتوقع أن تشتغل الكهرباء بين:' : 'من المتوقع أن تنطفئ الكهرباء بين:'}
        </Text>
        <View style={utStyles.rangeTimeStack} dir="ltr">
          <Text style={[utStyles.rangeTime, { color }]}>{fmtTimeAr(nt.rangeStartIso)}</Text>
          <Text style={[utStyles.rangeSep, { color: color + '88' }]}>و</Text>
          <Text style={[utStyles.rangeTime, { color }]}>{fmtTimeAr(nt.rangeEndIso)}</Text>
        </View>
      </View>

      {/* SECONDARY: countdown (spec §20) */}
      {!nt.inRangeWindow && (
        <View style={utStyles.countdownSection}>
          <Text style={utStyles.countdownLabel}>⏳ يبدأ نطاق التوقع بعد</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4, marginBottom: 10 }}>
            {h > 0 && (
              <>
                <View style={utStyles.cdUnit}>
                  <Text style={[utStyles.cdVal, { color }]}>{String(h).padStart(2, '0')}</Text>
                  <Text style={utStyles.cdSub}>س</Text>
                </View>
                <Text style={[utStyles.cdColon, { color }]}>:</Text>
              </>
            )}
            <View style={utStyles.cdUnit}>
              <Text style={[utStyles.cdVal, { color }]}>{String(m).padStart(2, '0')}</Text>
              <Text style={utStyles.cdSub}>د</Text>
            </View>
            <Text style={[utStyles.cdColon, { color }]}>:</Text>
            <View style={utStyles.cdUnit}>
              <Text style={[utStyles.cdVal, { color }]}>{String(s).padStart(2, '0')}</Text>
              <Text style={utStyles.cdSub}>ث</Text>
            </View>
          </View>
          <View style={utStyles.progressTrack}>
            <Animated.View style={[utStyles.progressFill, {
              backgroundColor: color,
              width: animProg.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            }]} />
          </View>
        </View>
      )}

      {afterNext && afterNext.endIso && (
        <View style={utStyles.afterNextBox}>
          <Text style={utStyles.afterNextLabel}>التغيير المتوقع بعد ذلك</Text>
          <Text style={[utStyles.afterNextVal, { color: afterNext.state === 'ON' ? T.success : T.danger }]}>
            {afterNext.state === 'ON' ? '🟢 تشغيل الكهرباء' : '🔴 انقطاع الكهرباء'}
            {'  '}{fmtTimeAr(afterNext.startIso)} — {fmtTimeAr(afterNext.endIso)}
          </Text>
        </View>
      )}
    </View>
  );
}

const utStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 22, padding: 20, marginBottom: 14, borderWidth: 1.5 },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  cardTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  confBadge: { borderRadius: 20, paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1 },
  confText: { fontSize: 12, fontWeight: '700' },
  rangeWindowBadge: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1.5, marginBottom: 14, alignItems: 'center' },
  rangeWindowText: { fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 4 },
  rangeWindowSub: { fontSize: 11, textAlign: 'center' },
  rangeBox: { backgroundColor: T.elevated, borderRadius: 18, padding: 20, marginBottom: 16, borderWidth: 1, alignItems: 'center' },
  rangeBoxLabel: { fontSize: 14, fontWeight: '600', marginBottom: 14, textAlign: 'center' },
  rangeTimeStack: { alignItems: 'center', gap: 8 },
  rangeTime: { fontSize: 32, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5, writingDirection: 'ltr' },
  rangeSep: { fontSize: 14, fontWeight: '600', color: T.textMuted },
  countdownSection: { alignItems: 'center', marginBottom: 14 },
  countdownLabel: { color: T.textMuted, fontSize: 11, marginBottom: 10 },
  cdUnit: { alignItems: 'center', minWidth: 44 },
  cdVal: { fontSize: 34, fontWeight: '900', letterSpacing: -1 },
  cdSub: { color: T.textMuted, fontSize: 10, marginTop: -2 },
  cdColon: { fontSize: 30, fontWeight: '900', marginBottom: 8 },
  progressTrack: { width: '100%', height: 3, backgroundColor: T.elevated, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  afterNextBox: { backgroundColor: T.elevated, borderRadius: 12, padding: 12 },
  afterNextLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 6, textAlign: 'right' },
  afterNextVal: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
  holdBox: { flexDirection: 'row-reverse', gap: 12, alignItems: 'flex-start', backgroundColor: T.elevated, borderRadius: 14, padding: 14, marginBottom: 12 },
  holdTitle: { fontSize: 15, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  holdBody: { color: T.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'right' },
  communityPrioBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 8, borderWidth: 1, borderColor: T.accent + '44' },
  communityPrioText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Today's Timeline
// ─────────────────────────────────────────────────────────────────────────────
function TodayTimeline({ prediction, anchorStartIso }: {
  prediction: UserPrediction | null;
  anchorStartIso: string | null;
}) {
  const stableStartMapRef   = useRef<Record<string, string>>({});
  const stableEndMapRef     = useRef<Record<string, string>>({});
  const lastComputedAtRef   = useRef<string | null>(null);
  const lastOffsetRef       = useRef<number | null>(null);
  const lastResyncRef       = useRef<string | null>(null);

  const computedAt       = prediction?.computedAt ?? null;
  const currentOffset    = prediction?.offsetMinutes ?? 0;
  const currentResyncIso = prediction?.resyncedAtIso ?? null;

  if (computedAt && computedAt !== lastComputedAtRef.current) {
    stableStartMapRef.current = {};
    stableEndMapRef.current   = {};
    lastComputedAtRef.current = computedAt;
  }
  if (lastOffsetRef.current !== null && lastOffsetRef.current !== currentOffset) {
    stableStartMapRef.current = {};
    stableEndMapRef.current   = {};
  }
  lastOffsetRef.current = currentOffset;

  const resyncChanged = lastResyncRef.current !== currentResyncIso;
  if (resyncChanged) {
    stableStartMapRef.current = {};
    stableEndMapRef.current   = {};
    lastResyncRef.current     = currentResyncIso;
  }

  const slots = prediction?.daySchedule ?? [];
  const nowMs = Date.now();
  const activeIdx = slots.findIndex(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });
  const startIdx = activeIdx >= 0 ? activeIdx : slots.findIndex(s => new Date(s.startIso).getTime() > nowMs);
  const displaySlots = startIdx >= 0 ? slots.slice(startIdx, startIdx + 4) : slots.slice(0, 4);
  if (displaySlots.length === 0) return null;

  return (
    <View style={tlStyles.card}>
      <Text style={tlStyles.title}>جدول اليوم</Text>
      {displaySlots.map((slot, i) => {
        const isActive = i === 0 && activeIdx >= 0;
        const isOn = slot.state === 'ON';
        const color = isOn ? T.success : T.danger;
        const slotKey = `${slot.state}|${Math.round(new Date(slot.startIso).getTime() / 60_000)}`;
        const currentStartF = slot.shiftedStartFormatted ?? slot.startFormatted;
        if (!stableStartMapRef.current[slotKey] && currentStartF) {
          stableStartMapRef.current[slotKey] = currentStartF;
        }
        const startF = stableStartMapRef.current[slotKey] ?? currentStartF;
        const currentEndF = slot.shiftedEndFormatted ?? slot.endFormatted;
        if (!stableEndMapRef.current[slotKey] && currentEndF) {
          stableEndMapRef.current[slotKey] = currentEndF;
        }
        const endF = stableEndMapRef.current[slotKey] ?? currentEndF;
        const isFuture = new Date(slot.startIso).getTime() > nowMs;
        return (
          <View key={i} style={[tlStyles.row, i < displaySlots.length - 1 && tlStyles.rowBorder]}>
            <View style={tlStyles.timelineCol}>
              {i < displaySlots.length - 1 && (
                <View style={[tlStyles.line, { backgroundColor: color + '40' }]} />
              )}
              <View style={[tlStyles.dot, { backgroundColor: color, opacity: isFuture && !isActive ? 0.5 : 1 }]} />
            </View>
            <View style={[tlStyles.content, isFuture && !isActive && tlStyles.contentFaded]}>
              <View style={tlStyles.topRow}>
                {isActive && (
                  <View style={[tlStyles.nowChip, { backgroundColor: color + '20', borderColor: color + '66' }]}>
                    <Text style={[tlStyles.nowChipText, { color }]}>الآن</Text>
                  </View>
                )}
                {slot.isEstimated && !isActive && (
                  <View style={tlStyles.estChip}><Text style={tlStyles.estChipText}>تقديري</Text></View>
                )}
                {slot.isResynced && (
                  <View style={tlStyles.syncChip}><Text style={tlStyles.syncChipText}>👥</Text></View>
                )}
                <Text style={[tlStyles.stateText, { color }]}>
                  {isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية'}
                </Text>
              </View>
                            {/* تم التعديل: قمنا بحقن التوقيت المصحح داخل الـ Ref لمنع زحزحة الوقت للأمام */}
              {(() => {
                if (isActive && anchorStartIso && !stableStartMapRef.current[slotKey]) {
                  stableStartMapRef.current[slotKey] = new Date(anchorStartIso).toLocaleString('en-US', { 
                    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true 
                  }).replace('AM', 'ص').replace('PM', 'م');
                }
              })()}

              <Text style={tlStyles.timeText}>
                {isActive ? (stableStartMapRef.current[slotKey] ?? startF) : startF}
                {endF ? ` → ${endF}` : ' → …'}
              </Text>

              {slot.durationLabel && (
                <Text style={[tlStyles.durText, { color: color + 'aa' }]}>{slot.durationLabel}</Text>
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const tlStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 20, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  title: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 16, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', gap: 14, paddingBottom: 16, marginBottom: 16 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.elevated },
  timelineCol: { width: 16, alignItems: 'center', position: 'relative', paddingTop: 3 },
  dot: { width: 12, height: 12, borderRadius: 6, zIndex: 1 },
  line: { position: 'absolute', top: 14, bottom: -16, left: '50%', width: 2, marginLeft: -1 },
  content: { flex: 1 },
  contentFaded: { opacity: 0.65 },
  topRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 5, flexWrap: 'wrap' },
  stateText: { fontSize: 16, fontWeight: '800', flex: 1, textAlign: 'right' },
  nowChip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  nowChipText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  estChip: { backgroundColor: T.elevated, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  estChipText: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  syncChip: { backgroundColor: '#001a2e', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  syncChipText: { fontSize: 10 },
  timeText: { color: T.textSecondary, fontSize: 13, fontWeight: '600', textAlign: 'right', marginBottom: 2 },
  durText: { fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Community Activity
// ─────────────────────────────────────────────────────────────────────────────
function CommunityActivity({ pendingAlerts, onViewAll, userId, onReporterPress }: {
  pendingAlerts: number; onViewAll: () => void; userId?: string;
  onReporterPress?: (reporterId: string) => void;
}) {
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
        <TouchableOpacity onPress={onViewAll} activeOpacity={0.8}>
          <Text style={caStyles.openBtn}>فتح →</Text>
        </TouchableOpacity>
        <Text style={caStyles.title}>🌐 نشاط المجتمع</Text>
      </View>
      {pendingAlerts > 0 && (
        <TouchableOpacity style={caStyles.alertBanner} onPress={onViewAll} activeOpacity={0.85}>
          <Text style={caStyles.alertArrow}>←</Text>
          <Text style={caStyles.alertText}>
            <Text style={{ color: T.accent, fontWeight: '800' }}>{pendingAlerts}</Text>{' '}تنبيه بانتظار ردّك من شخص تتابعه
          </Text>
          <View style={caStyles.alertDot} />
        </TouchableOpacity>
      )}
      {recentReports.length > 0 ? recentReports.map((r, i) => {
        const isOn = r.reported_state === 'UTILITY_ON';
        const color = isOn ? T.success : T.danger;
        const minutesAgo = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
        const timeLabel = minutesAgo < 60 ? `منذ ${minutesAgo} دقيقة` : `منذ ${Math.round(minutesAgo / 60)} ساعة`;
        return (
          <View key={r.id} style={caStyles.reportRow}>
            <View style={caStyles.reportMeta}>
              {r.yesCount > 0 && <Text style={caStyles.yesCount}>✓ {r.yesCount} موافقة</Text>}
              <Text style={caStyles.timeAgo}>{timeLabel}</Text>
            </View>
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
  card: { backgroundColor: T.surface, borderRadius: 20, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  title: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  openBtn: { color: T.accent, fontSize: 13, fontWeight: '700' },
  alertBanner: { flexDirection: 'row-reverse', alignItems: 'center', backgroundColor: '#001a2e', borderRadius: 12, padding: 12, marginBottom: 12, gap: 8, borderWidth: 1, borderColor: T.accent + '44' },
  alertDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent },
  alertText: { color: T.textSecondary, fontSize: 12, flex: 1, textAlign: 'right' },
  alertArrow: { color: T.accent, fontWeight: '700' },
  reportRow: { flexDirection: 'row-reverse', alignItems: 'flex-start', paddingVertical: 10, borderTopWidth: 1, borderTopColor: T.elevated, gap: 10 },
  reportLeft: { flex: 1 },
  reportState: { fontSize: 14, fontWeight: '700', textAlign: 'right', marginBottom: 3 },
  reportUser: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  reportMeta: { alignItems: 'flex-end', gap: 3 },
  timeAgo: { color: T.textMuted, fontSize: 10 },
  yesCount: { color: T.success, fontSize: 10, fontWeight: '600' },
  emptyText: { color: T.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 8 },
});

// ─────────────────────────────────────────────────────────────────────────────
// PARTICIPATION NUDGE
// ─────────────────────────────────────────────────────────────────────────────
function ParticipationNudge({ userId }: { userId?: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!userId) return;
    (async () => {
      try {
        const cyclesAgo = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
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
        <Text style={pnStyles.body}>
          لم تُبلّغ عن أي تغيير منذ فترة. عند تغيّر الكهرباء في حيّك — اضغط{' '}
          <Text style={{ fontWeight: '800', color: T.accent }}>"الإبلاغ عن تغيير"</Text>{' '}لتُحسّن دقة توقعاتك وتساعد جيرانك. 🎯
        </Text>
      </View>
      <TouchableOpacity onPress={() => setShow(false)} style={pnStyles.dismissBtn}>
        <Text style={pnStyles.dismissText}>✕</Text>
      </TouchableOpacity>
    </View>
  );
}
const pnStyles = StyleSheet.create({
  banner: { backgroundColor: '#001a2e', borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: T.accent + '44', flexDirection: 'row-reverse', gap: 10 },
  title: { color: T.accent, fontSize: 13, fontWeight: '800', textAlign: 'right', marginBottom: 6 },
  body: { color: T.textSecondary, fontSize: 12, lineHeight: 20, textAlign: 'right' },
  dismissBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: T.elevated, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  dismissText: { color: T.textMuted, fontSize: 12 },
});

// ─────────────────────────────────────────────────────────────────────────────
// STABILITY BAR
// ─────────────────────────────────────────────────────────────────────────────
function StabilityBar({ score, label }: { score: number; label: string }) {
  const color = score >= 75 ? T.success : score >= 45 ? T.warning : T.danger;
  const animW = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(animW, { toValue: score, duration: 800, useNativeDriver: false }).start();
  }, [score]);
  const arabicLabel = label === 'Stable' ? 'مستقر' : label === 'Slightly Unstable' ? 'غير مستقر نسبياً' : 'غير مستقر';
  return (
    <View style={sbStyles.wrap}>
      <View style={sbStyles.row}>
        <Text style={[sbStyles.score, { color }]}>{score}%  {arabicLabel}</Text>
        <Text style={sbStyles.label}>استقرار النمط</Text>
      </View>
      <View style={sbStyles.track}>
        <Animated.View style={[sbStyles.fill, { backgroundColor: color, width: animW.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }) }]} />
      </View>
    </View>
  );
}
const sbStyles = StyleSheet.create({
  wrap: { backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: T.border },
  row: { flexDirection: 'row-reverse', justifyContent: 'space-between', marginBottom: 8 },
  label: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  score: { fontSize: 12, fontWeight: '700' },
  track: { height: 5, backgroundColor: T.elevated, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 5, borderRadius: 3 },
});

// ─────────────────────────────────────────────────────────────────────────────
// STABLE RANGE REF
// ─────────────────────────────────────────────────────────────────────────────
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
  const { profile, signOut } = useAuth();
  const { offset, loading: offsetLoading, pendingDSD, clearPendingDSD, saveOffset } = useUserOffset();
  const { resyncPoint, clearResync, registerSnapshotCallback } = useResync();
  const { mode: transitionMode, toggle: toggleTransitionMode } = useTransitionMode();
  const { anchor } = useStateAnchor();
  const { userPrediction, loading: predLoading } = useUserPredictions(
    offset?.offset_minutes ?? 0,
    resyncPoint,
    transitionMode,
    anchor?.startIso ?? null,
  );
  const { pendingCount } = useResyncNotifications();
  const { score: myScore } = useMyReliability(profile?.id);
  const [refreshing, setRefreshing] = useState(false);

  // ── Status Snapshot system ────────────────────────────────────────────────
  // Captures the full state (offset + resync + state start) before any
  // user report or community sync is applied so "العودة إلى الحالة الأصلية"
  // can restore it exactly.
  const { snapshot, hasSnapshot, captureSnapshot, clearSnapshot } = useStatusSnapshot();

  // Register the capture callback with ResyncContext so it fires automatically
  // before every applyResync() call (covers both reporter and YES-responder paths).
  // Also used directly by the report-submission flow.
  useEffect(() => {
    registerSnapshotCallback(async (_point) => {
      // _point is the incoming new resync — we capture the CURRENT state before it applies
      await captureSnapshot(
        userPrediction?.currentState ?? 'OFF',
        userPrediction?.currentStateStartIso ?? null,
        offset?.offset_minutes ?? 0,
        resyncPoint,
        'community_confirm',
      );
    });
    return () => registerSnapshotCallback(null);
  }, [registerSnapshotCallback, captureSnapshot, userPrediction, offset, resyncPoint]);

  // ── Restore from snapshot ────────────────────────────────────────────────
  
  // ── Restore from snapshot (مصحح ومضمون لإعادة الـ offset) ─────────────────
  const handleRestoreSnapshot = useCallback(async () => {
    if (!snapshot) return;
    try {
      // 1. استعادة الـ Offset مباشرة إلى قاعدة البيانات والحالة المحلية دون شروط مقيدة
      const targetOffset = snapshot.previousOffsetMinutes;
      await saveOffset(targetOffset);
      
      // 2. مسح المزامنة المجتمعية الحالية للعودة للحالة الأصلية
      await clearResync();
      
      // 3. مسح الـ لقطة (Snapshot) لتحديث واجهة المستخدم وإخفاء الزر
      await clearSnapshot();
      
      // تلميح اختياري للمستخدم للتأكيد
      if (Platform.OS !== 'web') {
        Alert.alert('تمت العملية', 'تم استعادة توازن الوقت والفارق بنجاح.');
      }
    } catch (error) {
      console.error('خطأ أثناء محاولة استعادة الحالة الأصلية والـ offset:', error);
    }
  }, [snapshot, saveOffset, clearResync, clearSnapshot]);

  // ── Elapsed-time source priority (spec §NEGATIVE OFFSET BEHAVIOR) ──────────
  // Priority 1: reconciledCycleStartIso — backdated via GrowattTransitionTime + Offset.
  //   e.g. Growatt OFF at 12:00, offset -60 → reconciledStart = 11:00 → "منذ ساعة"
  //   This MUST win over anchor.startIso which always holds raw Growatt time.
  // Priority 2: userPrediction.currentStateStartIso — schedule-derived start.
  // Priority 3: anchor.startIso — Growatt raw time (correct for neutral/positive offset
  //   users where no reconciliation is needed and schedule start = Growatt start).
    // تم التعديل: إعطاء الأولوية لـ anchor الثابت لحماية الوقت من التصفير التلقائي
    // ── Elapsed-time source priority (مصحح) ──────────
  // Priority 1: userPrediction.reconciledCycleStartIso (Backdated offset time / Sync time)
  // Priority 2: userPrediction.currentStateStartIso (Schedule-derived time)
  // Priority 3: anchor.startIso (Absolute fallback)
  const anchorStartIso =
    userPrediction?.reconciledCycleStartIso ??
    userPrediction?.currentStateStartIso ??
    anchor?.startIso ??
    null;
 

  const stableNextTransition = useStableNextTransition(userPrediction?.nextTransition);
  const stablePrediction = userPrediction
    ? { ...userPrediction, nextTransition: stableNextTransition }
    : null;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  const loading = offsetLoading || predLoading;

  // ── Revert handler (used by PersonalStatusCard) ──────────────────────────
  // If a snapshot exists: show "العودة إلى الحالة الأصلية" flow
  // Otherwise: plain clearResync (old Growatt-revert behaviour)
    // ── Revert handler (مصحح) ──────────────────────────────────────────
  const handleRevert = useCallback(() => {
    const confirmMsg = hasSnapshot
      ? 'هل تريد العودة إلى الحالة الأصلية قبل هذا البلاغ؟ سيتم استعادة جدولك وفارق التوقيت (Offset) السابق تماماً.'
      : 'هل تريد العودة إلى جدول Growatt؟ سيتم إلغاء المزامنة المجتمعية الحالية.';
      
    const doRestore = hasSnapshot ? handleRestoreSnapshot : clearResync;
    
    if (Platform.OS === 'web') {
      doRestore();
    } else {
      Alert.alert(
        hasSnapshot ? 'العودة إلى الحالة الأصلية' : 'العودة إلى Growatt',
        confirmMsg,
        [
          { text: 'إلغاء', style: 'cancel' },
          { text: 'تأكيد العودة والاستعادة', style: 'destructive', onPress: () => doRestore() },
        ],
      );
    }
  }, [hasSnapshot, handleRestoreSnapshot, clearResync]);

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
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 100 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerBtns}>
          <TouchableOpacity style={styles.signOutBtn} onPress={() => signOut()} activeOpacity={0.8}>
            <Text style={styles.signOutIcon}>⏻</Text>
            <Text style={styles.signOutLabel}>خروج</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/(user)/settings')}>
            <Text style={styles.iconBtnText}>⚙️</Text>
          </TouchableOpacity>
          {myScore && (
            <View style={styles.reliabilityPill}>
              <Text style={[styles.reliabilityText, { color: getReliabilityBadge(myScore.reliability_score).color }]}>
                {myScore.reliability_score}%
              </Text>
            </View>
          )}
        </View>
        <View>
          <Text style={styles.greeting}>أهلاً، {displayName} 👋</Text>
          <Text style={styles.date}>{new Date().toLocaleDateString('ar-SA', { weekday: 'long', month: 'long', day: 'numeric' })}</Text>
        </View>
      </View>

      {/* Crisis banner */}
      {userPrediction?.crisisMode && userPrediction.crisisReason ? (
        <View style={styles.crisisBanner}>
          <View style={styles.crisisIconWrap}><Text style={{ fontSize: 20 }}>⚠️</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.crisisTitle}>تغيّر في النمط</Text>
            <Text style={styles.crisisBody}>{userPrediction.crisisReason}</Text>
          </View>
        </View>
      ) : null}

      {/* TMMS toggle — at the top of home screen per spec */}
      <TransitionModeToggle mode={transitionMode} onToggle={toggleTransitionMode} />

      <ParticipationNudge userId={profile?.id} />
      <PendingDSDChip pendingDSD={pendingDSD} onCancel={clearPendingDSD} />
      <PositiveOffsetPendingBanner prediction={stablePrediction} />
      <ValidationWindowToast prediction={stablePrediction} />
      <PersonalStatusCard
        prediction={stablePrediction}
        anchorStartIso={anchorStartIso}
        onRevertToGrowatt={handleRevert}
        hasSnapshot={hasSnapshot}
        reasoningLine={stablePrediction?.reasoning?.[0] ?? undefined}
      />
      <UpcomingTransitionCard prediction={stablePrediction} />

      {stablePrediction && (
        <StabilityBar score={stablePrediction.stabilityScore} label={stablePrediction.stabilityLabel} />
      )}

      <TodayTimeline prediction={stablePrediction} anchorStartIso={anchorStartIso} />
      <CommunityActivity
        pendingAlerts={pendingCount}
        onViewAll={() => router.push('/(user)/community')}
        userId={profile?.id}
        onReporterPress={(rid) => router.push(`/(user)/reporter/${rid}` as any)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16 },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 },
  greeting: { color: T.textPrimary, fontSize: 20, fontWeight: '800', textAlign: 'right' },
  date: { color: T.textMuted, fontSize: 12, marginTop: 2, textAlign: 'right' },
  headerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reliabilityPill: { backgroundColor: T.elevated, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  reliabilityText: { fontSize: 12, fontWeight: '800' },
  iconBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: T.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: T.border },
  iconBtnText: { fontSize: 18 },
  signOutBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#1a0505', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: '#ef444430' },
  signOutIcon: { fontSize: 14 },
  signOutLabel: { color: '#ef4444', fontSize: 12, fontWeight: '700' },
  crisisBanner: { backgroundColor: '#1a0e00', borderRadius: 14, padding: 14, marginBottom: 14, flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, borderWidth: 1.5, borderColor: '#92400e' },
  crisisIconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#451a03', alignItems: 'center', justifyContent: 'center' },
  crisisTitle: { color: '#f59e0b', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4, textAlign: 'right' },
  crisisBody: { color: '#fbbf24', fontSize: 12, lineHeight: 19, textAlign: 'right' },
});
