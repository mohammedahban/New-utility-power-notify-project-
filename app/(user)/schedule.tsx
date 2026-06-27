import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, Animated,
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
function ScheduleBlock({ slot, index, resyncEvents, isActive, atcMode, isHolding, stableStartFormatted, stableEndFormatted }: {
  slot: ShiftedScheduleSlot;
  index: number;
  resyncEvents: any[];
  isActive?: boolean;
  atcMode?: ScheduleStateMode;
  isHolding?: boolean;
  stableStartFormatted?: string;
  stableEndFormatted?: string;
}) {
  const isOn = slot.state === 'ON';
  const color = isOn ? T.success : T.danger;
  const startTime = stableStartFormatted ?? slot.shiftedStartFormatted ?? slot.startFormatted;
  const endTime = stableEndFormatted ?? slot.shiftedEndFormatted ?? slot.endFormatted;
  const zoneAr = (AR as any)[slot.zone] ?? slot.zone;

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
          {isActive && (
            <View style={[sbStyles.nowBadge, { backgroundColor: color + '22', borderColor: color + '88' }]}>
              <Text style={[sbStyles.nowBadgeText, { color }]}>{AR.nowBadge}</Text>
            </View>
          )}
          <Text style={[sbStyles.state, { color }]}>{isOn ? AR.gridOn : AR.gridOff}</Text>
        </View>

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
// POWER EVENTS HISTORY — with duration badges
// Shows past real power transition events from power_events table.
// The "مدة" badge on each event shows how long the PREVIOUS state lasted
// (= time from this event back to the one before it).
// ─────────────────────────────────────────────────────────────────────────────
interface PowerEvent {
  id: number;
  event_type: 'UTILITY_ON' | 'UTILITY_OFF';
  occurred_at: string;
  durationLabel?: string;
}

function usePowerEventsHistory(limit = 20) {
  const [events, setEvents] = useState<PowerEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('power_events')
      .select('id, event_type, occurred_at')
      .order('occurred_at', { ascending: false })
      .limit(limit + 1)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const withDuration: PowerEvent[] = data.slice(0, limit).map((ev: any, i: number) => {
          // data is sorted newest-first.
          // data[i-1] is the event that occurred AFTER ev (more recent),
          // meaning it marks when THIS state ended — so the duration is:
          //   data[i-1].occurred_at − ev.occurred_at
          // This shows "how long did THIS state last" on the badge.
          const endEv = data[i - 1];
          let durationLabel: string | undefined;
          if (endEv) {
            const endMs  = new Date(endEv.occurred_at).getTime();
            const startMs = new Date(ev.occurred_at).getTime();
            const durMin = Math.round(Math.abs(endMs - startMs) / 60_000);
            const h = Math.floor(durMin / 60);
            const m = durMin % 60;
            if (h === 0) durationLabel = `${m} دقيقة`;
            else if (m === 0) durationLabel = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
            else durationLabel = `${h}س ${m}د`;
          }
          return { ...ev, durationLabel };
        });
        setEvents(withDuration);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [limit]);

  return { events, loading };
}

function fmtEventTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function EventsHistorySection() {
  const { events, loading } = usePowerEventsHistory(20);

  return (
    <View style={ehStyles.container}>
      <Text style={ehStyles.sectionTitle}>📋 سجل الأحداث الفعلية</Text>
      <Text style={ehStyles.sectionSub}>الأحداث الحقيقية المسجَّلة من الحساس الرئيسي</Text>

      {loading ? (
        <ActivityIndicator color={T.accent} size="small" style={{ marginVertical: 16 }} />
      ) : events.length === 0 ? (
        <Text style={ehStyles.emptyText}>لا توجد أحداث مسجَّلة بعد</Text>
      ) : (
        events.map((ev, i) => {
          const isOn = ev.event_type === 'UTILITY_ON';
          const color = isOn ? T.success : T.danger;
          const icon  = isOn ? '⚡' : '🔴';
          const label = isOn ? 'اشتغلت الكهرباء' : 'طفت الكهرباء';
          return (
            <View key={ev.id} style={[ehStyles.row, i < events.length - 1 && ehStyles.rowBorder]}>
              {/* Duration badge */}
              <View style={ehStyles.badgeCol}>
                {ev.durationLabel ? (
                  <View style={[ehStyles.durBadge, { borderColor: color + '44', backgroundColor: color + '10' }]}>
                    <Text style={[ehStyles.durBadgeText, { color }]}>{ev.durationLabel}</Text>
                    <Text style={ehStyles.durBadgeSub}>مدة</Text>
                  </View>
                ) : (
                  <View style={[ehStyles.durBadge, { borderColor: T.border, backgroundColor: T.elevated }]}>
                    <Text style={[ehStyles.durBadgeText, { color: T.textMuted }]}>—</Text>
                  </View>
                )}
              </View>

              {/* Event info */}
              <View style={ehStyles.details}>
                <Text style={[ehStyles.eventLabel, { color }]}>{icon} {label}</Text>
                <Text style={ehStyles.eventTime}>{fmtEventTime(ev.occurred_at)}</Text>
              </View>

              {/* Color stripe */}
              <View style={[ehStyles.colorBar, { backgroundColor: color }]} />
            </View>
          );
        })
      )}
    </View>
  );
}

const ehStyles = StyleSheet.create({
  container: {
    backgroundColor: T.surface, borderRadius: 20, padding: 18,
    marginTop: 8, marginBottom: 16, borderWidth: 1, borderColor: T.border,
  },
  sectionTitle: { color: T.textPrimary, fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  sectionSub: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginBottom: 16, letterSpacing: 0.3 },
  emptyText: { color: T.textMuted, fontSize: 12, textAlign: 'center', paddingVertical: 16 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: T.elevated },
  colorBar: { width: 3, borderRadius: 2, alignSelf: 'stretch', minHeight: 36, flexShrink: 0 },
  details: { flex: 1 },
  eventLabel: { fontSize: 14, fontWeight: '800', textAlign: 'right', marginBottom: 4 },
  eventTime: { color: T.textMuted, fontSize: 11, textAlign: 'right' },
  badgeCol: { alignItems: 'center', width: 64, flexShrink: 0 },
  durBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 6, borderWidth: 1, alignItems: 'center', minWidth: 58 },
  durBadgeText: { fontSize: 13, fontWeight: '800', textAlign: 'center' },
  durBadgeSub: { color: T.textMuted, fontSize: 8, fontWeight: '600', marginTop: 2, letterSpacing: 1 },
});

// ─────────────────────────────────────────────────────────────────────────────
// DSD Chip
// ─────────────────────────────────────────────────────────────────────────────
function DSDChip({ offsetMinutes, isPending }: { offsetMinutes: number; isPending: boolean }) {
  const isNeg = offsetMinutes < 0;
  const color = isNeg ? '#f97316' : offsetMinutes > 0 ? '#22c55e' : '#94a3b8';
  const label = `${offsetMinutes > 0 ? '+' : ''}${offsetMinutes}د`;

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!isPending) { pulseAnim.setValue(1); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [isPending]);

  return (
    <View style={[dsdStyles.wrap, { borderColor: color + '44', backgroundColor: color + '12' }]}>
      {isPending && (
        <Animated.View style={[dsdStyles.pendingDot, { opacity: pulseAnim, backgroundColor: color }]} />
      )}
      <Text style={[dsdStyles.value, { color }]}>{label}</Text>
      <Text style={dsdStyles.label}>الفارق</Text>
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
  const { userPrediction, loading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint, transitionMode);
  const { history: resyncHistory } = useResyncNotifications();
  const { anchor } = useStateAnchor();

  const stableStartMapRef   = useRef<Record<string, string>>({});
  const stableEndMapRef     = useRef<Record<string, string>>({});
  const lastOffsetRef       = useRef<number | null>(null);
  const lastResyncRef       = useRef<string | null>(null);

  const currentOffset   = offset?.offset_minutes ?? 0;
  const offsetMs = currentOffset * 60_000;
  const atcMode = userPrediction?.atc?.mode;
  const isPositiveOffsetPending = atcMode === 'POSITIVE_OFFSET_PENDING';

  // For POSITIVE_OFFSET_PENDING: use currentStateStartIso as the actual start
  // For others: use anchor + offset or resync
  const mathematicalActiveStartIso = (() => {
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

  // For POSITIVE_OFFSET_PENDING: the synthetic slot (at index 0) is the active slot
  const activeIdx = (() => {
    if (isPositiveOffsetPending && allSlots.length > 0) return 0;
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
        <DSDChip offsetMinutes={offset?.offset_minutes ?? 0} isPending={!!pendingDSD} />
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

            // Active start: use mathematicalActiveStartIso for the active slot
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
            // For active POSITIVE_OFFSET_PENDING slot always show fresh anchor time
            const stableStart = (isActive && isPositiveOffsetPending && activeStartFormatted)
              ? activeStartFormatted
              : (stableStartMapRef.current[slotKey] ?? currentFormatted);

            const currentEndFormatted = slot.shiftedEndFormatted ?? slot.endFormatted;
            if (!stableEndMapRef.current[slotKey] && currentEndFormatted) {
              stableEndMapRef.current[slotKey] = currentEndFormatted;
            }
            const stableEnd = stableEndMapRef.current[slotKey] ?? currentEndFormatted;

            return (
              <ScheduleBlock
                key={i} slot={slot} index={i}
                resyncEvents={resyncHistory}
                isActive={isActive}
                atcMode={atcMode}
                isHolding={userPrediction?.isHoldingState}
                stableStartFormatted={stableStart}
                stableEndFormatted={stableEnd}
              />
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

      {/* ── Power Events History ── */}
      <EventsHistorySection />

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
});
