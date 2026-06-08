
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  RefreshControl, ActivityIndicator, Animated,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../../contexts/AuthContext';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, UserPrediction, ScheduleStateMode } from '../../hooks/useUserPredictions';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useMyReliability, getReliabilityBadge } from '../../hooks/useReliability';
import { useResync } from '../../contexts/ResyncContext';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';

const T = {
  bg: '#060d1a', surface: '#0d1526', elevated: '#162035',
  border: '#1e2d45', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#4a5e7a',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

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

// ── Elapsed since ISO ─────────────────────────────────────────────────────────
function useElapsed(sinceIso: string | null): string {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!sinceIso) { setLabel(''); return; }
    const update = () => {
      const diff = Date.now() - new Date(sinceIso).getTime();
      const totalMin = Math.floor(diff / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      if (h === 0 && m === 0) setLabel('للتو');
      else if (h === 0) setLabel(`${m} دقيقة`);
      else if (m === 0) setLabel(h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`);
      else setLabel(`${h} س و ${m} د`);
    };
    update();
    const id = setInterval(update, 15000);
    return () => clearInterval(id);
  }, [sinceIso]);
  return label;
}

// ── Format Arabic time from ISO ───────────────────────────────────────────────
function fmtTimeAr(iso: string): string {
  return new Date(iso).toLocaleString('ar-SA', {
    timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

// ── Confidence to Arabic label ────────────────────────────────────────────────
function confLabel(pct: number): { text: string; color: string; emoji: string } {
  if (pct >= 80) return { text: 'ثقة مرتفعة', color: T.success, emoji: '🟢' };
  if (pct >= 55) return { text: 'ثقة متوسطة', color: T.warning, emoji: '🟡' };
  return { text: 'ثقة منخفضة', color: T.danger, emoji: '🔴' };
}

// ── ATC status badge ─────────────────────────────────────────────────────────
function ATCBadge({ mode, statusLine, isOn }: {
  mode: ScheduleStateMode;
  statusLine: string | null;
  isOn: boolean;
}) {
  if (mode === 'NORMAL' || mode === 'COMMUNITY_SYNCED') return null;

  const configs: Record<Exclude<ScheduleStateMode, 'NORMAL' | 'COMMUNITY_SYNCED'>, {
    icon: string; bg: string; border: string; textColor: string;
  }> = {
    PREDICTION_RANGE: { icon: '🔮', bg: '#0a1a2e', border: T.accent + '55', textColor: T.accent },
    UNCERTAIN_ZONE:   { icon: '⚠', bg: '#1a0e00', border: T.warning + '55', textColor: T.warning },
    WAITING_FOR_GROWATT: { icon: '⏳', bg: '#0a1a2e', border: T.accent + '44', textColor: T.accent },
  };
  const cfg = configs[mode as Exclude<ScheduleStateMode, 'NORMAL' | 'COMMUNITY_SYNCED'>];
  if (!cfg) return null;

  return (
    <View style={[atcStyles.badge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
      <Text style={[atcStyles.badgeLine, { color: cfg.textColor }]}>
        {cfg.icon}  {statusLine ?? mode}
      </Text>
      {(mode === 'UNCERTAIN_ZONE' || mode === 'WAITING_FOR_GROWATT') && (
        <Text style={atcStyles.subLine}>👥 بلاغات المجتمع ذات أولوية مرتفعة الآن</Text>
      )}
    </View>
  );
}

const atcStyles = StyleSheet.create({
  badge: { borderRadius: 12, padding: 12, marginTop: 12, borderWidth: 1 },
  badgeLine: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
  subLine: { color: T.accent, fontSize: 11, marginTop: 5, textAlign: 'right' },
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Personal Utility Status Hero Card
// ─────────────────────────────────────────────────────────────────────────────
function PersonalStatusCard({ prediction }: { prediction: UserPrediction | null }) {
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;

  // When ATC is holding, find the last slot that started (not necessarily still active)
  // Otherwise find the slot that contains now
  const currentSlot = (() => {
    const slots = prediction?.daySchedule ?? [];
    const nowMs = Date.now();
    if (isHolding) {
      // Return the last slot whose startIso <= now (the held state)
      let best = null;
      for (const s of slots) {
        if (new Date(s.startIso).getTime() <= nowMs) best = s;
        else break;
      }
      return best;
    }
    return slots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    }) ?? null;
  })();

  const isOn = prediction?.currentState === 'ON';
  const color = isOn ? T.success : T.danger;
  const icon = atcMode === 'COMMUNITY_SYNCED' ? '🔄' : isOn ? '⚡' : '🔴';
  const statusText = atcMode === 'COMMUNITY_SYNCED'
    ? 'تمت مزامنة الحالة عبر المجتمع'
    : isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية';

  // Elapsed since current slot started
  const slotStartIso = currentSlot?.startIso ?? null;
  const elapsed = useElapsed(slotStartIso);

  // Remaining time: only show when ATC is NOT holding
  const slotEndIso = !isHolding ? (currentSlot?.endIso ?? null) : null;
  const remainMinutes = slotEndIso
    ? Math.max(0, (new Date(slotEndIso).getTime() - Date.now()) / 60000)
    : null;
  const remainH = remainMinutes !== null ? Math.floor(remainMinutes / 60) : 0;
  const remainM = remainMinutes !== null ? Math.round(remainMinutes % 60) : 0;

  const remainLabel = remainMinutes === null ? null
    : remainH === 0 ? `${remainM} دقيقة`
    : remainM === 0 ? (remainH === 1 ? 'ساعة' : `${remainH} ساعات`)
    : `${remainH} س و ${remainM} د`;

  const animColor = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(animColor, { toValue: 1, duration: 1500, useNativeDriver: false }),
        Animated.timing(animColor, { toValue: 0, duration: 1500, useNativeDriver: false }),
      ])
    ).start();
  }, []);

  const pulseOpacity = animColor.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });

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
        {remainLabel ? (
          <View style={[psStyles.timeBlock, psStyles.timeBlockRight]}>
            <Text style={psStyles.timeLabel}>متبقي تقريباً:</Text>
            <Text style={[psStyles.timeValue, { color }]}>{remainLabel}</Text>
          </View>
        ) : null}
      </View>

      {/* ATC state badge */}
      <ATCBadge mode={atcMode} statusLine={prediction?.atc?.statusLine ?? null} isOn={isOn} />

      {/* Typical durations row */}
      {(prediction?.expectedOnDurationLabel || prediction?.expectedOffDurationLabel) && (
        <View style={psStyles.durRow}>
          {prediction?.expectedOnDurationLabel && (
            <View style={[psStyles.durChip, { borderColor: T.success + '44' }]}>
              <Text style={psStyles.durChipIcon}>🟢</Text>
              <View>
                <Text style={psStyles.durChipLabel}>مدة التشغيل المعتادة</Text>
                <Text style={[psStyles.durChipValue, { color: T.success }]}>{prediction.expectedOnDurationLabel}</Text>
              </View>
            </View>
          )}
          {prediction?.expectedOffDurationLabel && (
            <View style={[psStyles.durChip, { borderColor: T.danger + '44' }]}>
              <Text style={psStyles.durChipIcon}>🔴</Text>
              <View>
                <Text style={psStyles.durChipLabel}>مدة الانقطاع المعتادة</Text>
                <Text style={[psStyles.durChipValue, { color: T.danger }]}>{prediction.expectedOffDurationLabel}</Text>
              </View>
            </View>
          )}
        </View>
      )}

      {prediction?.isResynced && (
        <View style={psStyles.syncBadge}>
          <Text style={psStyles.syncText}>👥 تم مزامنة الجدول مجتمعياً</Text>
        </View>
      )}
    </View>
  );
}

const psStyles = StyleSheet.create({
  card: { backgroundColor: T.surface, borderRadius: 22, padding: 20, marginBottom: 14, borderWidth: 1.5 },
  cardTitle: { color: T.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, marginBottom: 16, textAlign: 'right' },
  statusRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14, marginBottom: 18 },
  statusIcon: { fontSize: 44 },
  statusText: { fontSize: 30, fontWeight: '900', flex: 1, textAlign: 'right' },
  timeRow: { flexDirection: 'row-reverse', gap: 10, marginBottom: 16 },
  timeBlock: { flex: 1, backgroundColor: T.elevated, borderRadius: 14, padding: 14 },
  timeBlockRight: {},
  timeLabel: { color: T.textMuted, fontSize: 10, fontWeight: '600', textAlign: 'right', marginBottom: 5 },
  timeValue: { fontSize: 18, fontWeight: '800', textAlign: 'right' },
  durRow: { flexDirection: 'row-reverse', gap: 8 },
  durChip: { flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 8, backgroundColor: T.elevated, borderRadius: 12, padding: 10, borderWidth: 1 },
  durChipIcon: { fontSize: 16 },
  durChipLabel: { color: T.textMuted, fontSize: 9, fontWeight: '600', marginBottom: 2, textAlign: 'right' },
  durChipValue: { fontSize: 12, fontWeight: '800', textAlign: 'right' },
  syncBadge: { marginTop: 10, backgroundColor: '#001a2e', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#38bdf844' },
  syncText: { color: '#38bdf8', fontSize: 11, fontWeight: '600', textAlign: 'right' },
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Upcoming Expected Transition Hero Card
// ─────────────────────────────────────────────────────────────────────────────
function UpcomingTransitionCard({ prediction }: { prediction: UserPrediction | null }) {
  const nt = prediction?.nextTransition ?? null;
  const atcMode = prediction?.atc?.mode ?? 'NORMAL';
  const isHolding = prediction?.isHoldingState ?? false;
  const midMin = nt ? (nt.minFromNowMin + nt.maxFromNowMin) / 2 : null;
  const { h, m, s, total } = useCountdownSec(midMin);
  const maxSec = midMin ? midMin * 60 : 1;
  const progress = Math.max(0, Math.min(1, total / maxSec));

  const animProg = useRef(new Animated.Value(progress)).current;
  useEffect(() => {
    Animated.timing(animProg, { toValue: progress, duration: 600, useNativeDriver: false }).start();
  }, [progress]);

  if (!prediction) return null;

  // ATC holding state — show appropriate message instead of normal card
  if (isHolding && atcMode !== 'NORMAL' && atcMode !== 'COMMUNITY_SYNCED') {
    const isCurrentOn = prediction.currentState === 'ON';
    const holdColor = isCurrentOn ? T.success : T.danger;
    const modeConfigs = {
      UNCERTAIN_ZONE: {
        icon: '⚠️',
        title: 'استمرار غير معتاد',
        body: 'لا يزال التغيير متوقعاً — النمط الحالي ممتد بشكل غير معتاد',
        borderColor: T.warning + '44',
        iconColor: T.warning,
      },
      WAITING_FOR_GROWATT: {
        icon: '⏳',
        title: 'بانتظار تأكيد الحساس الرئيسي',
        body: 'تم تجاوز نطاق التوقع. بانتظار تأكيد بلاغ مجتمعي أو تحديث حساس Growatt',
        borderColor: T.accent + '44',
        iconColor: T.accent,
      },
      PREDICTION_RANGE: {
        icon: '🔮',
        title: 'نطاق التوقع نشط',
        body: 'التغيير محتمل خلال هذا النطاق. بانتظار تأكيد.',
        borderColor: T.accent + '33',
        iconColor: T.accent,
      },
    };
    const cfg = modeConfigs[atcMode as keyof typeof modeConfigs] ?? modeConfigs.UNCERTAIN_ZONE;

    return (
      <View style={[utStyles.card, { borderColor: cfg.borderColor }]}>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
        <View style={utStyles.unstableBox}>
          <Text style={utStyles.unstableIcon}>{cfg.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={[utStyles.unstableTitle, { color: cfg.iconColor }]}>{cfg.title}</Text>
            <Text style={utStyles.unstableBody}>{cfg.body}</Text>
          </View>
        </View>
        {prediction.atc.communityElevated && (
          <View style={utStyles.communityPriorityBox}>
            <Text style={utStyles.communityPriorityText}>👥 بلاغات المجتمع ذات أولوية مرتفعة الآن — شارك بملاحظاتك لمساعدة المجتمع</Text>
          </View>
        )}
        {nt && (
          <View style={[utStyles.mainBox, { borderColor: holdColor + '25', marginTop: 12 }]}>
            <Text style={[utStyles.transitionLabel, { color: holdColor }]}>
              {nt.type === 'UTILITY_ON' ? '🟢 توقع تشغيل الكهرباء' : '🔴 توقع انقطاع الكهرباء'}
            </Text>
            <Text style={[utStyles.rangeText, { color: holdColor, fontSize: 18 }]}>
              {nt.rangeLabel.replace('→', 'إلى')}
            </Text>
          </View>
        )}
      </View>
    );
  }

  if (prediction.isUnstable || !nt) {
    return (
      <View style={[utStyles.card, { borderColor: T.warning + '44' }]}>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
        <View style={utStyles.unstableBox}>
          <Text style={utStyles.unstableIcon}>⚠️</Text>
          <View style={{ flex: 1 }}>
            <Text style={utStyles.unstableTitle}>النمط غير مستقر مؤقتاً</Text>
            <Text style={utStyles.unstableBody}>لا توجد توقعات موثوقة حالياً. يستمر التطبيق في التعلم.</Text>
          </View>
        </View>
      </View>
    );
  }

  const isNextOn = nt.type === 'UTILITY_ON';
  const color = isNextOn ? T.success : T.danger;
  const conf = confLabel(prediction.confidence);

  // Parse range from nt.rangeLabel — format: "HH:MM AM → HH:MM AM"
  // We store the raw slot times via nt.rangeLabel already formatted
  const rangeText = nt.rangeLabel; // e.g. "3:30 م → 4:00 م"

  // Next-next transition: find the slot after the next transition
  const slots = prediction.daySchedule ?? [];
  const nextIdx = slots.findIndex(s => {
    const state: 'ON' | 'OFF' = isNextOn ? 'ON' : 'OFF';
    return s.state === state && new Date(s.startIso).getTime() > Date.now();
  });
  const afterNext = nextIdx >= 0 && nextIdx + 1 < slots.length ? slots[nextIdx + 1] : null;

  // Delayed prediction: if we're past the expected transition window
  const rangeEndMs = nt.maxFromNowMin > 0 ? Date.now() + nt.maxFromNowMin * 60000 : null;
  const isDelayed = rangeEndMs !== null && Date.now() > rangeEndMs;

  return (
    <View style={[utStyles.card, { borderColor: color + '30' }]}>
      <View style={utStyles.headerRow}>
        <View style={[utStyles.confBadge, { backgroundColor: conf.color + '20', borderColor: conf.color + '44' }]}>
          <Text style={[utStyles.confText, { color: conf.color }]}>{conf.emoji} {conf.text}</Text>
        </View>
        <Text style={utStyles.cardTitle}>⚡ التغيير المتوقع القادم</Text>
      </View>

      {isDelayed ? (
        <View style={utStyles.delayBox}>
          <Text style={utStyles.delayText}>⚠ لا يزال التغيير متوقعاً — النمط الحالي ممتد بشكل غير معتاد</Text>
        </View>
      ) : null}

      {/* Main transition display */}
      <View style={[utStyles.mainBox, { borderColor: color + '25' }]}>
        <Text style={[utStyles.transitionLabel, { color }]}>
          {isNextOn ? '🟢 متوقع تشغيل الكهرباء' : '🔴 متوقع انقطاع الكهرباء'}
        </Text>
        <Text style={[utStyles.rangeText, { color }]}>
          {rangeText.replace('→', 'إلى')}
        </Text>
      </View>

      {/* Countdown — secondary */}
      <View style={utStyles.countdownSection}>
        <Text style={utStyles.countdownLabel}>⏳ يبدأ نطاق التوقع بعد</Text>
        <View style={[utStyles.countdownRow, { direction: 'ltr' as any }]}>
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

      {/* After-next transition preview */}
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
  mainBox: { backgroundColor: T.elevated, borderRadius: 16, padding: 18, marginBottom: 16, borderWidth: 1, alignItems: 'center' },
  transitionLabel: { fontSize: 16, fontWeight: '700', marginBottom: 10, textAlign: 'center' },
  rangeText: { fontSize: 28, fontWeight: '900', textAlign: 'center', letterSpacing: -0.5 },
  countdownSection: { alignItems: 'center', marginBottom: 14 },
  countdownLabel: { color: T.textMuted, fontSize: 11, marginBottom: 10 },
  countdownRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginBottom: 12 },
  cdUnit: { alignItems: 'center', minWidth: 48 },
  cdVal: { fontSize: 38, fontWeight: '900', letterSpacing: -1 },
  cdSub: { color: T.textMuted, fontSize: 10, marginTop: -2 },
  cdColon: { fontSize: 34, fontWeight: '900', marginBottom: 8 },
  progressTrack: { width: '100%', height: 3, backgroundColor: T.elevated, borderRadius: 2, overflow: 'hidden' },
  progressFill: { height: 3, borderRadius: 2 },
  afterNextBox: { backgroundColor: T.elevated, borderRadius: 12, padding: 12 },
  afterNextLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 6, textAlign: 'right' },
  afterNextVal: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
  unstableBox: { flexDirection: 'row-reverse', gap: 12, alignItems: 'flex-start', backgroundColor: T.elevated, borderRadius: 14, padding: 14 },
  unstableIcon: { fontSize: 28 },
  unstableTitle: { color: T.warning, fontSize: 15, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  unstableBody: { color: T.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'right' },
  delayBox: { backgroundColor: '#1a0e00', borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#92400e' },
  delayText: { color: '#f59e0b', fontSize: 12, textAlign: 'right' },
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Today's Timeline (4 upcoming slots)
// ─────────────────────────────────────────────────────────────────────────────
function TodayTimeline({ prediction }: { prediction: UserPrediction | null }) {
  const slots = prediction?.daySchedule ?? [];
  const nowMs = Date.now();

  // Find current active slot index
  const activeIdx = slots.findIndex(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  // Show current slot + 3 next slots (total 4)
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
        const startF = slot.shiftedStartFormatted ?? slot.startFormatted;
        const endF = slot.shiftedEndFormatted ?? slot.endFormatted;
        const isFuture = new Date(slot.startIso).getTime() > nowMs;

        return (
          <View key={i} style={[tlStyles.row, i < displaySlots.length - 1 && tlStyles.rowBorder]}>
            {/* Timeline line + dot */}
            <View style={tlStyles.timelineCol}>
              {i < displaySlots.length - 1 && (
                <View style={[tlStyles.line, { backgroundColor: color + '40' }]} />
              )}
              <View style={[tlStyles.dot, { backgroundColor: color, opacity: isFuture && !isActive ? 0.5 : 1 }]} />
            </View>

            {/* Content */}
            <View style={[tlStyles.content, isFuture && !isActive && tlStyles.contentFaded]}>
              <View style={tlStyles.topRow}>
                {isActive && (
                  <View style={[tlStyles.nowChip, { backgroundColor: color + '20', borderColor: color + '66' }]}>
                    <Text style={[tlStyles.nowChipText, { color }]}>الآن</Text>
                  </View>
                )}
                {slot.isEstimated && !isActive && (
                  <View style={tlStyles.estChip}>
                    <Text style={tlStyles.estChipText}>تقديري</Text>
                  </View>
                )}
                {slot.isResynced && (
                  <View style={tlStyles.syncChip}>
                    <Text style={tlStyles.syncChipText}>👥</Text>
                  </View>
                )}
                <Text style={[tlStyles.stateText, { color }]}>
                  {isOn ? 'الكهرباء شغالة' : 'الكهرباء طافية'}
                </Text>
              </View>
              <Text style={tlStyles.timeText}>
                {startF}{endF ? ` → ${endF}` : ' →  …'}
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
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Community Activity
// ─────────────────────────────────────────────────────────────────────────────
function CommunityActivity({ pendingAlerts, onViewAll, userId }: {
  pendingAlerts: number;
  onViewAll: () => void;
  userId?: string;
}) {
  const [recentReports, setRecentReports] = useState<any[]>([]);

  useEffect(() => {
    if (!userId) return;
    // Fetch recent confirmed resync history items from followed users
    (async () => {
      try {
        // Get followed users
        const { data: follows } = await supabase
          .from('follows')
          .select('target_id')
          .eq('requester_id', userId)
          .eq('status', 'accepted')
          .limit(10);

        if (!follows || follows.length === 0) return;

        const targetIds = follows.map((f: any) => f.target_id);
        const { data: reports } = await supabase
          .from('utility_reports')
          .select('id, reported_state, created_at, reporter_id, reporter:user_profiles!utility_reports_reporter_id_fkey(username)')
          .in('reporter_id', targetIds)
          .order('created_at', { ascending: false })
          .limit(4);

        if (reports) {
          // Get response counts
          const reportIds = reports.map((r: any) => r.id);
          const { data: responses } = await supabase
            .from('resync_responses')
            .select('report_id, response')
            .in('report_id', reportIds)
            .eq('response', 'yes');

          const yesCounts: Record<number, number> = {};
          (responses ?? []).forEach((r: any) => {
            yesCounts[r.report_id] = (yesCounts[r.report_id] ?? 0) + 1;
          });

          setRecentReports(reports.map((r: any) => ({
            ...r,
            yesCount: yesCounts[r.id] ?? 0,
            username: (r.reporter as any)?.username ?? 'مجهول',
          })));
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
            <Text style={{ color: T.accent, fontWeight: '800' }}>{pendingAlerts}</Text>
            {' '}تنبيه بانتظار ردّك من شخص تتابعه
          </Text>
          <View style={caStyles.alertDot} />
        </TouchableOpacity>
      )}

      {recentReports.length > 0 ? (
        recentReports.map((r, i) => {
          const isOn = r.reported_state === 'UTILITY_ON';
          const color = isOn ? T.success : T.danger;
          const minutesAgo = Math.round((Date.now() - new Date(r.created_at).getTime()) / 60000);
          const timeLabel = minutesAgo < 60 ? `منذ ${minutesAgo} دقيقة`
            : `منذ ${Math.round(minutesAgo / 60)} ساعة`;
          return (
            <View key={r.id} style={caStyles.reportRow}>
              <View style={caStyles.reportMeta}>
                {r.yesCount > 0 && (
                  <Text style={caStyles.yesCount}>✓ {r.yesCount} موافقة</Text>
                )}
                <Text style={caStyles.timeAgo}>{timeLabel}</Text>
              </View>
              <View style={caStyles.reportLeft}>
                <Text style={[caStyles.reportState, { color }]}>
                  {isOn ? '⚡ اشتغلت الكهرباء' : '🔴 طفت الكهرباء'}
                </Text>
                <Text style={caStyles.reportUser}>أفاد {r.username}</Text>
              </View>
            </View>
          );
        })
      ) : (
        <Text style={caStyles.emptyText}>تابع جيرانك لرؤية بلاغاتهم هنا</Text>
      )}
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
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
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
        // Check if user has reported in the last 3 expected cycles (~3×avg cycle duration)
        const cyclesAgo = new Date(Date.now() - 3 * 12 * 60 * 60 * 1000).toISOString(); // ~3 cycles (36h)
        const { count } = await supabase
          .from('utility_reports')
          .select('*', { count: 'exact', head: true })
          .eq('reporter_id', userId)
          .gte('created_at', cyclesAgo);

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
          لم تُبلّغ عن أي تغيير في الكهرباء منذ فترة. عند تغيّر الكهرباء في حيّك — سواء اشتغلت أو طفت — اضغط زر{' '}
          <Text style={{ fontWeight: '800', color: T.accent }}>"الإبلاغ عن تغيير"</Text>{' '}
          لتُخبر متابعيك وتُحسّن دقة توقعاتك. كلما شاركت، كلما استفدت أكثر! 🎯
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
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// STABILITY GAUGE (compact)
// ─────────────────────────────────────────────────────────────────────────────
function StabilityBar({ score, label }: { score: number; label: string }) {
  const color = score >= 75 ? T.success : score >= 45 ? T.warning : T.danger;
  const animW = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(animW, { toValue: score, duration: 800, useNativeDriver: false }).start();
  }, [score]);
  const arabicLabel = label === 'Stable' ? 'مستقر'
    : label === 'Slightly Unstable' ? 'غير مستقر نسبياً' : 'غير مستقر';
  return (
    <View style={sbStyles.wrap}>
      <View style={sbStyles.row}>
        <Text style={[sbStyles.score, { color }]}>{score}%  {arabicLabel}</Text>
        <Text style={sbStyles.label}>استقرار النمط</Text>
      </View>
      <View style={sbStyles.track}>
        <Animated.View style={[sbStyles.fill, {
          backgroundColor: color,
          width: animW.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }]} />
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
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HOME SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function Home() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { profile, signOut } = useAuth();
  const { offset, loading: offsetLoading } = useUserOffset();
  const { resyncPoint } = useResync();
  const { userPrediction, loading: predLoading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint);
  const { pendingCount } = useResyncNotifications();
  const { score: myScore } = useMyReliability(profile?.id);

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  const loading = offsetLoading || predLoading;
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
          <TouchableOpacity
            style={styles.signOutBtn}
            onPress={() => signOut()}
            activeOpacity={0.8}
          >
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

      {/* Participation nudge */}
      <ParticipationNudge userId={profile?.id} />

      {/* Section 1: Personal status */}
      <PersonalStatusCard prediction={userPrediction} />

      {/* Section 2: Upcoming transition */}
      <UpcomingTransitionCard prediction={userPrediction} />

      {/* Stability bar */}
      {userPrediction && (
        <StabilityBar score={userPrediction.stabilityScore} label={userPrediction.stabilityLabel} />
      )}

      {/* Section 3: Today's timeline */}
      <TodayTimeline prediction={userPrediction} />

      {/* Section 4: Community activity */}
      <CommunityActivity
        pendingAlerts={pendingCount}
        onViewAll={() => router.push('/(user)/community')}
        userId={profile?.id}
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
  communityPriorityBox: { backgroundColor: '#001a2e', borderRadius: 10, padding: 10, marginTop: 10, borderWidth: 1, borderColor: T.accent + '44' },
  communityPriorityText: { color: T.accent, fontSize: 11, fontWeight: '600', textAlign: 'right' },
});
