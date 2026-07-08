import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, Animated, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, ShiftedScheduleSlot, ScheduleStateMode } from '../../hooks/useUserPredictions';
import { useTransitionMode } from '../../hooks/useTransitionMode';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useResync } from '../../contexts/ResyncContext';
import { useStateAnchor } from '../../hooks/useStateAnchor';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';

const T = {
  bg: '#0a0f1e', surface: '#0f172a', elevated: '#1e293b',
  border: '#334155', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', warning: '#f59e0b', danger: '#ef4444',
};

function parseFormattedTime(label: string): number | null {
  try {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const m24 = label.match(/(\d{1,2}):(\d{2})/);
    if (m24) {
      base.setHours(parseInt(m24[1], 10), parseInt(m24[2], 10), 0, 0);
      return base.getTime();
    }
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule Block
// ─────────────────────────────────────────────────────────────────────────────
function ScheduleBlock({ slot, index, resyncEvents, isActive, atcMode, isHolding, stableStartFormatted, stableEndFormatted, isPendingNegative }: {
  slot: ShiftedScheduleSlot;
  index: number;
  resyncEvents: any[];
  isActive?: boolean;
  atcMode?: ScheduleStateMode;
  isHolding?: boolean;
  stableStartFormatted?: string;
  stableEndFormatted?: string;
  // V2.1: passed down so future ON slots can be marked "Estimated (Pending Offset)"
  // when the user's Offset State is PendingNegative (PDF §"Pending Negative").
  isPendingNegative?: boolean;
}) {
  const isOn = slot.state === 'ON';
  const color = isOn ? T.success : T.danger;
  const startTime = stableStartFormatted ?? slot.shiftedStartFormatted ?? slot.startFormatted;
  const endTime = stableEndFormatted ?? slot.shiftedEndFormatted ?? slot.endFormatted;
  const zoneAr = (AR as any)[slot.zone] ?? slot.zone;

  // V2.1: read the slot-level V2.1 flags (set by useUserPredictions).
  // - isGeneratedOn: this slot is a Generated ON event (a permanent timeline
  //   event created from a community ON report). Renders a green "⚡ مُولّدة" badge.
  // - isEstimatedPendingOffset: this is a FUTURE ON slot whose precise start
  //   time is unknown because the user's offset is PendingNegative.
  //   Renders an amber "تقديري معلَّق" badge.
  const isGeneratedOn = (slot as any).isGeneratedOn === true;
  const isEstimatedPendingOffset = (slot as any).isEstimatedPendingOffset === true;

  const slotStartMs = startTime ? parseFormattedTime(startTime) : null;
  const slotEndMs = endTime ? parseFormattedTime(endTime) : null;

  const resyncMatch = resyncEvents.find(ev => {
    if (slotStartMs === null) return false;
    const evMs = new Date(ev.effective_transition_at).getTime();
    const windowStart = slotStartMs - 15 * 60 * 1000;
    const windowEnd = slotEndMs ? slotEndMs + 15 * 60 * 1000 : slotStartMs + 60 * 60 * 1000;
    return evMs >= windowStart && evMs <= windowEnd;
  });

  return (
    <View style={[sbStyles.row, index === 0 && sbStyles.firstRow]}>
      <View style={[sbStyles.block,
        { borderRightColor: color, borderRightWidth: 3 },
        resyncMatch ? sbStyles.resyncBlock : undefined,
        isActive ? [sbStyles.activeBlock, { borderColor: color }] : undefined,
      ]}>
        <View style={sbStyles.blockHeader}>
          {resyncMatch && (
            <View style={sbStyles.resyncBadge}>
              <Text style={sbStyles.resyncBadgeText}>👥 مزامنة مجتمعية</Text>
            </View>
          )}
          {isActive && isHolding && atcMode && atcMode !== 'NORMAL' && atcMode !== 'COMMUNITY_SYNCED' && (() => {
            const atcCfg: Record<string, { label: string; bg: string; border: string; color: string }> = {
              UNCERTAIN_ZONE:        { label: '⚠ بانتظار تأكيد', bg: '#1a0e00', border: '#f59e0b66', color: '#f59e0b' },
              WAITING_FOR_GROWATT:   { label: '⏳ بانتظار Growatt', bg: '#001020', border: '#38bdf866', color: '#38bdf8' },
              PREDICTION_RANGE:      { label: '🔮 نطاق التوقع نشط', bg: '#001020', border: '#38bdf844', color: '#38bdf8' },
              GRACE_MODE:            { label: '⏳ تأخر غير معتاد — مهلة المزامنة', bg: '#1a0e00', border: '#f9731666', color: '#f97316' },
              POSITIVE_OFFSET_PENDING: { label: '⏰ تغيير تلقائي مجدول', bg: '#001a2e', border: '#38bdf866', color: '#38bdf8' },
            };
            const cfg = atcCfg[atcMode];
            if (!cfg) return null;
            return (
              <View style={[sbStyles.atcBadge, { backgroundColor: cfg.bg, borderColor: cfg.border }]}>
                <Text style={[sbStyles.atcBadgeText, { color: cfg.color }]}>{cfg.label}</Text>
              </View>
            );
          })()}
          <View style={[sbStyles.zoneBadge, { backgroundColor: isOn ? T.success + '18' : T.danger + '18' }]}>
            <Text style={[sbStyles.zoneText, { color }]}>{zoneAr}</Text>
          </View>
          {slot.isEstimated && (
            <View style={sbStyles.estBadge}><Text style={sbStyles.estText}>{AR.estBadge}</Text></View>
          )}
          {/* V2.1: Generated ON badge — permanently marks slots that were
              created as a Generated ON event. PDF §"GENERATED ON IS A REAL
              TIMELINE EVENT": "Never delete Generated ON later. Never replace
              it. Never hide it." The badge makes this visible in the schedule. */}
          {isGeneratedOn && (
            <View style={sbStyles.genOnBadge}>
              <Text style={sbStyles.genOnBadgeText}>⚡ مُولّدة</Text>
            </View>
          )}
          {/* V2.1: Estimated (Pending Offset) badge — marks future ON slots
              whose precise start time is unknown because the user's offset
              is PendingNegative. PDF §"Pending Negative": "Future ON
              predictions must be displayed as: Estimated (Pending Offset)". */}
          {isEstimatedPendingOffset && (
            <View style={sbStyles.pendingOffsetBadge}>
              <Text style={sbStyles.pendingOffsetBadgeText}>تقديري معلَّق</Text>
            </View>
          )}
          {isActive && (
            <View style={[sbStyles.nowBadge, { backgroundColor: color + '22', borderColor: color + '88' }]}>
              <Text style={[sbStyles.nowBadgeText, { color }]}>{AR.nowBadge}</Text>
            </View>
          )}
          <Text style={[sbStyles.state, { color }]}>{isOn ? AR.gridOn : AR.gridOff}</Text>
        </View>

        {/* V2.1: Generated ON info panel — only for Generated ON slots.
            Shows that this slot is a permanent timeline event created from
            a community ON report. Mirrors the HistoryCard's genOnRow. */}
        {isGeneratedOn && (
          <View style={sbStyles.genOnInfo}>
            <Text style={sbStyles.genOnInfoText}>
              ⚡ حدث تشغيل مُولّدة — دائم في الخطّ الزمني، لا يُحذف ولا يُستبدل.
            </Text>
          </View>
        )}

        <View style={sbStyles.timeRow}>
          {!endTime && <Text style={sbStyles.ongoing}>{AR.ongoing}</Text>}
          {endTime && (
            <>
              <Text style={sbStyles.endTime}>{endTime}</Text>
              <Text style={sbStyles.arrow}>←</Text>
            </>
          )}
          <Text style={sbStyles.startTime}>{startTime}</Text>
        </View>

        {slot.durationLabel && (
          <Text style={[sbStyles.duration, { color: color + 'cc' }]}>{slot.durationLabel}</Text>
        )}

        {resyncMatch && (
          <View style={sbStyles.resyncInfo}>
            <Text style={sbStyles.resyncInfoText}>
              👥 تم الضبط عبر بلاغ مجتمعي من{' '}
              <Text style={{ fontWeight: '700' }}>{resyncMatch.reporter_username ?? 'جار'}</Text>
              {' '}في{' '}
              {new Date(resyncMatch.effective_transition_at).toLocaleString('ar-SA', {
                timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit',
              })}
            </Text>
          </View>
        )}
      </View>

      <View style={sbStyles.timeline}>
        <View style={[sbStyles.line, { backgroundColor: isOn ? T.success + '33' : T.danger + '33' }]} />
        <View style={[sbStyles.dot, { backgroundColor: color }]} />
      </View>
    </View>
  );
}

const sbStyles = StyleSheet.create({
  row: { flexDirection: 'row-reverse', gap: 12, marginBottom: 4 },
  firstRow: {},
  timeline: { width: 20, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 14, zIndex: 1 },
  line: { flex: 1, width: 2, marginTop: 2 },
  block: { flex: 1, backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 8 },
  blockHeader: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  state: { fontSize: 16, fontWeight: '800', flex: 1, textAlign: 'right' },
  estBadge: { backgroundColor: T.elevated, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  estText: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  zoneBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  zoneText: { fontSize: 10, fontWeight: '600' },
  timeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginBottom: 4 },
  startTime: { color: T.textPrimary, fontSize: 15, fontWeight: '700' },
  arrow: { color: T.textMuted, fontSize: 13 },
  endTime: { color: T.textSecondary, fontSize: 15, fontWeight: '600' },
  ongoing: { color: T.textMuted, fontSize: 13 },
  duration: { fontSize: 12, fontWeight: '600', textAlign: 'right' },
  activeBlock: { borderWidth: 1.5, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 4 },
  nowBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  nowBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  resyncBlock: { borderColor: '#1e3a5a', backgroundColor: '#0a1929' },
  resyncBadge: { backgroundColor: '#001a2e', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: '#38bdf844' },
  resyncBadgeText: { color: '#38bdf8', fontSize: 9, fontWeight: '700' },
  resyncInfo: { marginTop: 8, backgroundColor: '#001a2e', borderRadius: 8, padding: 8, borderWidth: 1, borderColor: '#38bdf822' },
  resyncInfoText: { color: '#38bdf8', fontSize: 11, lineHeight: 16, textAlign: 'right' },
  atcBadge: { borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4, borderWidth: 1, marginTop: 2 },
  atcBadgeText: { fontSize: 10, fontWeight: '700' },
});

// ─────────────────────────────────────────────────────────────────────────────
// DSD Chip — V2.1 upgraded
// ─────────────────────────────────────────────────────────────────────────────
// TMMS V2.1: the DSD chip now also surfaces the Offset STATE (Positive /
// Negative / Neutral / PendingNegative), not just the numeric value. When
// the state is PendingNegative, the numeric value displays as "معلَّق"
// (pending) and the pulse animation runs — matching the visual language of
// the existing pendingDSD indicator.
function DSDChip({ offsetMinutes, isPending, offsetState }: {
  offsetMinutes: number;
  isPending: boolean;
  offsetState?: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE' | null;
}) {
  // V2.1: derive display color from the Offset State when available, falling
  // back to the legacy sign-based color logic for backwards compatibility.
  const stateColor = offsetState === 'PENDING_NEGATIVE'
    ? T.warning
    : offsetState === 'POSITIVE'
      ? T.success
      : offsetState === 'NEGATIVE'
        ? T.warning
        : offsetState === 'NEUTRAL'
          ? T.textMuted
          : (offsetMinutes < 0 ? '#f97316' : offsetMinutes > 0 ? '#22c55e' : '#94a3b8');

  // V2.1: when PendingNegative, show "معلَّق" instead of a number.
  const label = (offsetState === 'PENDING_NEGATIVE' || isPending)
    ? 'معلَّق'
    : `${offsetMinutes > 0 ? '+' : ''}${offsetMinutes}د`;

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isPending && offsetState !== 'PENDING_NEGATIVE') { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isPending, offsetState]);

  // V2.1: short state label under the value
  const stateLabel = offsetState === 'POSITIVE'
    ? 'إيجابي'
    : offsetState === 'NEGATIVE'
      ? 'سلبي'
      : offsetState === 'NEUTRAL'
        ? 'محايد'
        : offsetState === 'PENDING_NEGATIVE'
          ? 'معلَّق'
          : 'الفارق';

  return (
    <View style={[dsdStyles.wrap, { borderColor: stateColor + '44', backgroundColor: stateColor + '12' }]}>
      {(isPending || offsetState === 'PENDING_NEGATIVE') && (
        <Animated.View style={[dsdStyles.pendingDot, { opacity: pulseAnim, backgroundColor: stateColor }]} />
      )}
      <Text style={[dsdStyles.value, { color: stateColor }]}>{label}</Text>
      <Text style={dsdStyles.label}>{stateLabel}</Text>
    </View>
  );
}

const dsdStyles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 4, borderWidth: 1, gap: 2 },
  value: { fontSize: 15, fontWeight: '800' },
  label: { color: '#64748b', fontSize: 8, fontWeight: '700', letterSpacing: 1, marginTop: 2 },
  pendingDot: { width: 6, height: 6, borderRadius: 3, position: 'absolute', top: 5, left: 6 },
});

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCREEN
// ─────────────────────────────────────────────────────────────────────────────
export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { offset, pendingDSD } = useUserOffset();
  const { resyncPoint } = useResync();
  const { mode: transitionMode } = useTransitionMode();
  // FIX: useStateAnchor() must be declared BEFORE it is consumed by
  // useUserPredictions — previously `anchor` was referenced in its
  // temporal dead zone, crashing/nullifying the anchor on this screen.
  const { anchor } = useStateAnchor();
  const { userPrediction, loading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint, transitionMode, anchor?.startIso ?? null);
  const { history: resyncHistory } = useResyncNotifications();

  const stableStartMapRef   = useRef<Record<string, string>>({});
  const stableEndMapRef     = useRef<Record<string, string>>({});
  const lastOffsetRef       = useRef<number | null>(null);
  const lastResyncRef       = useRef<string | null>(null);

  const currentOffset   = offset?.offset_minutes ?? 0;
  const offsetMs = currentOffset * 60_000;
  const atcMode = userPrediction?.atc?.mode;
  const isPositiveOffsetPending = atcMode === 'POSITIVE_OFFSET_PENDING';

  // reconciledCycleStartIso: set when an UNCERTAIN_ZONE deduction backdates the ON cycle.
  // When present, it MUST be the start-time anchor so the schedule shows the
  // correct elapsed time (= wait duration) and remaining time (= predicted ON − wait).
  const reconciledStartIso = (userPrediction as any)?.reconciledCycleStartIso as string | null ?? null;
  const isReconciledFlip = !!reconciledStartIso && userPrediction?.atc?.mode === 'NORMAL' && userPrediction?.currentState === 'ON';

  // For POSITIVE_OFFSET_PENDING: use currentStateStartIso as the actual start
  // For reconciledCycleStartIso (immediate ON flip): use the backdated start
  // For others: use anchor + offset or resync
  const mathematicalActiveStartIso = (() => {
    if (isReconciledFlip) return reconciledStartIso;
    if (userPrediction?.isResynced && userPrediction.resyncedAtIso) {
      return userPrediction.resyncedAtIso;
    }
    if (isPositiveOffsetPending) {
      return userPrediction?.currentStateStartIso ?? null;
    }
    if (anchor && userPrediction && anchor.state === userPrediction.currentState) {
      return new Date(new Date(anchor.startIso).getTime() + offsetMs).toISOString();
    }
    return userPrediction?.currentStateStartIso ?? null;
  })();

  const currentResyncIso = resyncPoint?.syncedAtIso ?? null;

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

  const allSlots = userPrediction?.daySchedule ?? [];
  const nowMs = Date.now();

  // For POSITIVE_OFFSET_PENDING: the synthetic slot (at index 0) is the active slot.
  // For isReconciledFlip: the first ON slot in the schedule whose startIso is
  // closest to reconciledStartIso is the active slot (it may be at index 0 if
  // useUserPredictions injected the synthetic slot there).
  const activeIdx = (() => {
    if (isPositiveOffsetPending && allSlots.length > 0) return 0;
    if (isReconciledFlip && reconciledStartIso) {
      // Find the ON slot that best represents the reconciledCycleStartIso anchor.
      // The synthetic slot injected by useUserPredictions has startIso = reconciledStartIso,
      // so an exact match is ideal. Fall back to the first active ON slot.
      const reconMs = new Date(reconciledStartIso).getTime();
      const exactIdx = allSlots.findIndex(
        s => s.state === 'ON' && Math.abs(new Date(s.startIso).getTime() - reconMs) < 5 * 60_000,
      );
      if (exactIdx >= 0) return exactIdx;
      // Fall back: the ON slot that is currently active (now is inside it)
      return allSlots.findIndex(s => {
        if (s.state !== 'ON') return false;
        const start = new Date(s.startIso).getTime();
        const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
        return nowMs >= start && nowMs < end;
      });
    }
    return allSlots.findIndex(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    });
  })();

  const startIdx = activeIdx >= 0 ? activeIdx
    : allSlots.findIndex(s => new Date(s.startIso).getTime() > nowMs);
  const slots = startIdx > 0 ? allSlots.slice(startIdx) : allSlots;

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={{ color: T.textMuted, marginTop: 12, fontSize: 14 }}>{AR.loading}</Text>
      </View>
    );
  }

  const modeLabel = userPrediction?.learningMode === 'learned' ? AR.learned
    : userPrediction?.learningMode === 'hybrid' ? AR.hybrid : AR.estimated;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Info bar */}
      <View style={styles.infoBar}>
        <View style={styles.infoItem}>
          <Text style={styles.infoValue}>{modeLabel}</Text>
          <Text style={styles.infoLabel}>النوع</Text>
        </View>
        <View style={styles.infoDivider} />
        <View style={styles.infoItem}>
          <Text style={styles.infoValue}>{userPrediction?.confidence ?? 0}%</Text>
          <Text style={styles.infoLabel}>الثقة</Text>
        </View>
        <View style={styles.infoDivider} />
        <View style={styles.infoItem}>
          <Text style={[styles.infoValue, {
            color: (userPrediction?.stabilityScore ?? 0) >= 75 ? T.success
              : (userPrediction?.stabilityScore ?? 0) >= 45 ? T.warning : T.danger
          }]}>
            {userPrediction?.stabilityScore ?? 0}%
          </Text>
          <Text style={styles.infoLabel}>الاستقرار</Text>
        </View>
        <View style={styles.infoDivider} />
        <DSDChip
          offsetMinutes={offset?.offset_minutes ?? 0}
          isPending={!!pendingDSD}
          offsetState={(userPrediction as any)?.offsetState ?? null}
        />
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        {resyncHistory.length > 0 && (
          <View style={styles.legendItem}>
            <Text style={styles.legendText}>مجتمعي</Text>
            <View style={[styles.legendBadge, { borderColor: '#38bdf844', backgroundColor: '#001a2e' }]}>
              <Text style={[styles.legendBadgeText, { color: '#38bdf8' }]}>👥</Text>
            </View>
          </View>
        )}
        {/* V2.1: Generated ON legend entry */}
        <View style={styles.legendItem}>
          <Text style={styles.legendText}>مُولّدة</Text>
          <View style={[styles.legendBadge, { borderColor: T.success + '55', backgroundColor: '#052e16' }]}>
            <Text style={[styles.legendBadgeText, { color: T.success, fontStyle: 'normal', fontWeight: '700' }]}>⚡</Text>
          </View>
        </View>
        {/* V2.1: Estimated (Pending Offset) legend entry */}
        <View style={styles.legendItem}>
          <Text style={styles.legendText}>تقديري معلَّق</Text>
          <View style={[styles.legendBadge, { borderColor: T.warning + '55', backgroundColor: '#1a0e00' }]}>
            <Text style={[styles.legendBadgeText, { color: T.warning, fontStyle: 'normal', fontWeight: '700' }]}>⏳</Text>
          </View>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendText}>توقع</Text>
          <View style={[styles.legendBadge]}><Text style={styles.legendBadgeText}>{AR.estBadge}</Text></View>
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendText}>{AR.gridOff}</Text>
          <View style={[styles.legendDot, { backgroundColor: T.danger }]} />
        </View>
        <View style={styles.legendItem}>
          <Text style={styles.legendText}>{AR.gridOn}</Text>
          <View style={[styles.legendDot, { backgroundColor: T.success }]} />
        </View>
      </View>

      {/* Upcoming schedule */}
      {slots.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>📅</Text>
          <Text style={styles.emptyTitle}>{AR.noScheduleYet}</Text>
          <Text style={styles.emptySub}>{AR.noScheduleSub}</Text>
        </View>
      ) : (
        <View style={styles.timeline}>
          <Text style={styles.sectionLabel}>{AR.scheduleTitle}</Text>
          {slots.map((slot, i) => {
            const slotStartMs = new Date(slot.startIso).getTime();
            const slotEndMs = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
            // For POSITIVE_OFFSET_PENDING: first slot is always active
            const isActive = isPositiveOffsetPending ? i === 0 : (nowMs >= slotStartMs && nowMs < slotEndMs);
            const slotKey = `${slot.state}|${Math.round(slotStartMs / 60_000)}`;

            // Active start: use mathematicalActiveStartIso for the active slot.
            // For isReconciledFlip, this is reconciledCycleStartIso (the backdated start).
            let activeStartFormatted: string | undefined;
            if (isActive && mathematicalActiveStartIso) {
              activeStartFormatted = new Date(mathematicalActiveStartIso).toLocaleString('en-US', {
                timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
              }).replace('AM', ' ص').replace('PM', ' م');
            }

            const currentFormatted = activeStartFormatted ?? slot.shiftedStartFormatted ?? slot.startFormatted;
            if (!stableStartMapRef.current[slotKey] && currentFormatted) {
              stableStartMapRef.current[slotKey] = currentFormatted;
            }
            // For active POSITIVE_OFFSET_PENDING or reconciledFlip slot — always use the
            // live anchor time so it doesn't drift or get stale from the ref cache.
            const stableStart = (isActive && (isPositiveOffsetPending || isReconciledFlip) && activeStartFormatted)
              ? activeStartFormatted
              : (stableStartMapRef.current[slotKey] ?? currentFormatted);

            const currentEndFormatted = slot.shiftedEndFormatted ?? slot.endFormatted;
            if (!stableEndMapRef.current[slotKey] && currentEndFormatted) {
              stableEndMapRef.current[slotKey] = currentEndFormatted;
            }
            const stableEnd = stableEndMapRef.current[slotKey] ?? currentEndFormatted;

            // Deduction row: shown below the active ON slot when the immediate-ON
            // flip is active (reconciledCycleStartIso set, NORMAL mode, state ON).
            // Tells the user exactly how many minutes of wait time were deducted
            // from the current ON cycle so they understand why remaining time is shorter.
            const deductMinutes = isActive && isReconciledFlip && slot.state === 'ON'
              ? Math.abs(currentOffset)
              : 0;

            return (
              <React.Fragment key={i}>
                <ScheduleBlock
                  slot={slot} index={i}
                  resyncEvents={resyncHistory}
                  isActive={isActive}
                  atcMode={atcMode}
                  isHolding={userPrediction?.isHoldingState}
                  stableStartFormatted={stableStart}
                  stableEndFormatted={stableEnd}
                  isPendingNegative={(userPrediction as any)?.isPendingNegative ?? false}
                />
                {deductMinutes > 0 && (
                  <View style={styles.deductionRow}>
                    <Text style={styles.deductionText}>
                      {'⏱ خُصم من هذه الدورة: '}
                      <Text style={styles.deductionBold}>{deductMinutes} دقيقة</Text>
                      {' انتظار — سيُخصم من مدة التشغيل القادمة'}
                    </Text>
                  </View>
                )}
              </React.Fragment>
            );
          })}
          <View style={styles.endDot} />
        </View>
      )}

      {/* Cycle stats */}
      {slots.length >= 2 && (() => {
        const completedSlots = slots.filter(s => s.endIso);
        const onSlots = completedSlots.filter(s => s.state === 'ON');
        const offSlots = completedSlots.filter(s => s.state === 'OFF');
        if (onSlots.length === 0 && offSlots.length === 0) return null;
        const avgMin = (arr: ShiftedScheduleSlot[]) =>
          Math.round(arr.reduce((sum, s) => {
            const ms = new Date(s.endIso!).getTime() - new Date(s.startIso).getTime();
            return sum + ms / 60_000;
          }, 0) / arr.length);
        const fmtMin = (m: number) => {
          const h = Math.floor(m / 60);
          const mins = Math.round(m % 60);
          if (h === 0) return `${mins}د`;
          if (mins === 0) return h === 1 ? 'ساعة' : `${h}س`;
          return `${h}س ${mins}د`;
        };
        const onAvg = onSlots.length > 0 ? fmtMin(avgMin(onSlots)) : null;
        const offAvg = offSlots.length > 0 ? fmtMin(avgMin(offSlots)) : null;
        return (
          <View style={styles.statsRow}>
            <Text style={styles.statLabel}>{AR.perCycle}</Text>
            {offAvg && (
              <View style={styles.statItem}>
                <Text style={styles.statText}>~{offAvg} <Text style={{ color: T.danger, fontWeight: '700' }}>طافي</Text></Text>
                <View style={[styles.statDot, { backgroundColor: T.danger }]} />
              </View>
            )}
            {onAvg && offAvg && <Text style={styles.statSlash}>/</Text>}
            {onAvg && (
              <View style={styles.statItem}>
                <Text style={styles.statText}>~{onAvg} <Text style={{ color: T.success, fontWeight: '700' }}>شغّال</Text></Text>
                <View style={[styles.statDot, { backgroundColor: T.success }]} />
              </View>
            )}
          </View>
        );
      })()}

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
  content: { paddingHorizontal: 16, paddingTop: 12 },
  infoBar: {
    flexDirection: 'row-reverse', backgroundColor: T.surface, borderRadius: 14,
    paddingVertical: 14, paddingHorizontal: 8, marginBottom: 14,
    borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'space-evenly',
  },
  infoItem: { alignItems: 'center', flex: 1 },
  infoLabel: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1, marginTop: 4 },
  infoValue: { color: T.textPrimary, fontSize: 15, fontWeight: '800' },
  infoDivider: { width: 1, height: 28, backgroundColor: T.border },
  legend: { flexDirection: 'row-reverse', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: T.textMuted, fontSize: 11 },
  legendBadge: { backgroundColor: T.elevated, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1, borderColor: 'transparent' },
  legendBadgeText: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  sectionLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textTransform: 'uppercase', textAlign: 'center' },
  timeline: { marginBottom: 8 },
  endDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: T.border, marginRight: 4, marginTop: 4, alignSelf: 'flex-end' },
  emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: T.textSecondary, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 22 },
  computedAt: { color: T.textMuted, fontSize: 10, textAlign: 'center', marginTop: 8 },
  statsRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: T.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16,
    marginTop: 8, marginBottom: 4, borderWidth: 1, borderColor: T.border,
  },
  statItem: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5 },
  statDot: { width: 7, height: 7, borderRadius: 4 },
  statText: { color: T.textSecondary, fontSize: 13 },
  statSlash: { color: T.border, fontSize: 14, fontWeight: '300' },
  statLabel: { color: T.textMuted, fontSize: 11, marginRight: 2 },
  deductionRow: {
    backgroundColor: '#1a0e00', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 14,
    marginBottom: 8, marginLeft: 32, borderWidth: 1, borderColor: '#f59e0b66',
  },
  deductionText: { color: '#f59e0b', fontSize: 12, fontWeight: '600', textAlign: 'right', lineHeight: 20 },
  deductionBold: { fontWeight: '900' },
});
