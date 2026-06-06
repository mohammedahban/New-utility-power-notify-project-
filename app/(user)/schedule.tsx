import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, ShiftedScheduleSlot } from '../../hooks/useUserPredictions';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useResync } from '../../contexts/ResyncContext';

const T = {
  bg: '#0a0f1e',
  surface: '#0f172a',
  elevated: '#1e293b',
  border: '#334155',
  accent: '#38bdf8',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
};

/** Convert a "HH:MM" or "H:MM AM/PM" label to today's timestamp in ms */
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
  } catch {
    return null;
  }
}

function ScheduleBlock({ slot, index, resyncEvents, isActive }: {
  slot: ShiftedScheduleSlot;
  index: number;
  resyncEvents: any[];
  isActive?: boolean;
}) {
  const isOn = slot.state === 'ON';
  const color = isOn ? T.success : T.danger;
  const startTime = slot.shiftedStartFormatted ?? slot.startFormatted;
  const endTime = slot.shiftedEndFormatted ?? slot.endFormatted;

  // Check if any resync event falls within ±15 min of this slot's start time
  const slotStartMs = startTime ? parseFormattedTime(startTime) : null;
  const slotEndMs = endTime ? parseFormattedTime(endTime) : null;

  const resyncMatch = resyncEvents.find(ev => {
    if (slotStartMs === null) return false;
    const evMs = new Date(ev.effective_transition_at).getTime();
    const windowStart = slotStartMs - 15 * 60 * 1000;
    const windowEnd = slotEndMs
      ? slotEndMs + 15 * 60 * 1000
      : slotStartMs + 60 * 60 * 1000;
    return evMs >= windowStart && evMs <= windowEnd;
  });

  return (
    <View style={[sbStyles.row, index === 0 && sbStyles.firstRow]}>
      {/* Timeline dot & line */}
      <View style={sbStyles.timeline}>
        <View style={[sbStyles.dot, { backgroundColor: color }]} />
        <View style={[sbStyles.line, { backgroundColor: isOn ? T.success + '33' : T.danger + '33' }]} />
      </View>

      {/* Content block */}
      <View style={[
        sbStyles.block,
        { borderLeftColor: color, borderLeftWidth: 3 },
        resyncMatch ? sbStyles.resyncBlock : undefined,
        isActive ? [sbStyles.activeBlock, { borderColor: color }] : undefined,
      ]}>
        <View style={sbStyles.blockHeader}>
          <Text style={[sbStyles.state, { color }]}>Grid {slot.state}</Text>
          {isActive && (
            <View style={[sbStyles.nowBadge, { backgroundColor: color + '22', borderColor: color + '88' }]}>
              <Text style={[sbStyles.nowBadgeText, { color }]}>NOW</Text>
            </View>
          )}
          {slot.isEstimated && (
            <View style={sbStyles.estBadge}><Text style={sbStyles.estText}>estimated</Text></View>
          )}
          <View style={[sbStyles.zoneBadge, { backgroundColor: isOn ? T.success + '18' : T.danger + '18' }]}>
            <Text style={[sbStyles.zoneText, { color }]}>{slot.zone}</Text>
          </View>
          {resyncMatch && (
            <View style={sbStyles.resyncBadge}>
              <Text style={sbStyles.resyncBadgeText}>👥 Community Synced</Text>
            </View>
          )}
        </View>

        <View style={sbStyles.timeRow}>
          <Text style={sbStyles.startTime}>{startTime}</Text>
          {endTime && (
            <>
              <Text style={sbStyles.arrow}>→</Text>
              <Text style={sbStyles.endTime}>{endTime}</Text>
            </>
          )}
          {!endTime && <Text style={sbStyles.ongoing}>→  ongoing…</Text>}
        </View>

        {slot.durationLabel && (
          <Text style={[sbStyles.duration, { color: color + 'cc' }]}>{slot.durationLabel}</Text>
        )}

        {resyncMatch && (
          <View style={sbStyles.resyncInfo}>
            <Text style={sbStyles.resyncInfoText}>
              👥 Adjusted via community report from{' '}
              <Text style={{ fontWeight: '700' }}>{resyncMatch.reporter_username ?? 'a neighbor'}</Text>
              {' '}at{' '}
              {new Date(resyncMatch.effective_transition_at).toLocaleString('en-US', {
                timeZone: 'Asia/Aden', hour: '2-digit', minute: '2-digit',
              })}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const sbStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  firstRow: {},
  timeline: { width: 20, alignItems: 'center' },
  dot: { width: 12, height: 12, borderRadius: 6, marginTop: 14, zIndex: 1 },
  line: { flex: 1, width: 2, marginTop: 2 },
  block: { flex: 1, backgroundColor: T.surface, borderRadius: 14, padding: 14, marginBottom: 8 },
  blockHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  state: { fontSize: 16, fontWeight: '800', flex: 1 },
  estBadge: { backgroundColor: T.elevated, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3 },
  estText: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  zoneBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  zoneText: { fontSize: 10, fontWeight: '600' },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  startTime: { color: T.textPrimary, fontSize: 15, fontWeight: '700' },
  arrow: { color: T.textMuted, fontSize: 13 },
  endTime: { color: T.textSecondary, fontSize: 15, fontWeight: '600' },
  ongoing: { color: T.textMuted, fontSize: 13 },
  duration: { fontSize: 12, fontWeight: '600' },
  // Community resync styling
  activeBlock: { borderWidth: 1.5, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6, elevation: 4 },
  nowBadge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1 },
  nowBadgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  resyncBlock: { borderColor: '#1e3a5a', backgroundColor: '#0a1929' },
  resyncBadge: {
    backgroundColor: '#001a2e', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3,
    borderWidth: 1, borderColor: '#38bdf844',
  },
  resyncBadgeText: { color: '#38bdf8', fontSize: 9, fontWeight: '700' },
  resyncInfo: {
    marginTop: 8, backgroundColor: '#001a2e', borderRadius: 8, padding: 8,
    borderWidth: 1, borderColor: '#38bdf822',
  },
  resyncInfoText: { color: '#38bdf8', fontSize: 11, lineHeight: 16 },
});

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { offset } = useUserOffset();
  const { resyncPoint } = useResync();
  const { userPrediction, loading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint);
  const { history: resyncHistory } = useResyncNotifications();

  const slots = userPrediction?.daySchedule ?? [];

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color={T.accent} />
        <Text style={{ color: T.textMuted, marginTop: 12, fontSize: 14 }}>Loading schedule…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Header info */}
      <View style={styles.infoBar}>
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>YOUR OFFSET</Text>
          <Text style={styles.infoValue}>
            {offset ? `${offset.offset_minutes > 0 ? '+' : ''}${offset.offset_minutes}m` : '0m'}
          </Text>
        </View>
        <View style={styles.infoDivider} />
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>STABILITY</Text>
          <Text style={[styles.infoValue, {
            color: (userPrediction?.stabilityScore ?? 0) >= 75 ? T.success
              : (userPrediction?.stabilityScore ?? 0) >= 45 ? T.warning : T.danger
          }]}>
            {userPrediction?.stabilityScore ?? 0}%
          </Text>
        </View>
        <View style={styles.infoDivider} />
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>CONFIDENCE</Text>
          <Text style={styles.infoValue}>{userPrediction?.confidence ?? 0}%</Text>
        </View>
        <View style={styles.infoDivider} />
        <View style={styles.infoItem}>
          <Text style={styles.infoLabel}>MODE</Text>
          <Text style={styles.infoValue}>
            {userPrediction?.learningMode === 'learned' ? '🧠' : userPrediction?.learningMode === 'hybrid' ? '📊' : '📐'}
          </Text>
        </View>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: T.success }]} />
          <Text style={styles.legendText}>Grid ON</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: T.danger }]} />
          <Text style={styles.legendText}>Grid OFF</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendBadge]}><Text style={styles.legendBadgeText}>estimated</Text></View>
          <Text style={styles.legendText}>Predicted</Text>
        </View>
        {resyncHistory.length > 0 && (
          <View style={styles.legendItem}>
            <View style={[styles.legendBadge, { borderColor: '#38bdf844', backgroundColor: '#001a2e' }]}>
              <Text style={[styles.legendBadgeText, { color: '#38bdf8' }]}>👥 synced</Text>
            </View>
            <Text style={styles.legendText}>Community</Text>
          </View>
        )}
      </View>

      {slots.length === 0 ? (
        <View style={styles.emptyBox}>
          <Text style={{ fontSize: 48, marginBottom: 16 }}>📅</Text>
          <Text style={styles.emptyTitle}>No Schedule Yet</Text>
          <Text style={styles.emptySub}>
            The schedule generates once the system has collected enough power event data. Please check back after the next power cycle.
          </Text>
        </View>
      ) : (
        <View style={styles.timeline}>
          <Text style={styles.sectionLabel}>NEXT 24 HOURS (YEMEN TIME, UTC+3)</Text>
          {slots.map((slot, i) => {
            const nowMs = Date.now();
            const slotStartMs = new Date(slot.startIso).getTime();
            const slotEndMs = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
            const isActive = nowMs >= slotStartMs && nowMs < slotEndMs;
            return (
              <ScheduleBlock key={i} slot={slot} index={i} resyncEvents={resyncHistory} isActive={isActive} />
            );
          })}
          <View style={styles.endDot} />
        </View>
      )}

      {/* Cycle stats row */}
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
          if (h === 0) return `${mins}m`;
          if (mins === 0) return `${h}h`;
          return `${h}h ${mins}m`;
        };
        const onAvg = onSlots.length > 0 ? fmtMin(avgMin(onSlots)) : null;
        const offAvg = offSlots.length > 0 ? fmtMin(avgMin(offSlots)) : null;
        return (
          <View style={styles.statsRow}>
            {onAvg && (
              <View style={styles.statItem}>
                <View style={[styles.statDot, { backgroundColor: T.success }]} />
                <Text style={styles.statText}>~{onAvg} <Text style={{ color: T.success, fontWeight: '700' }}>ON</Text></Text>
              </View>
            )}
            {onAvg && offAvg && <Text style={styles.statSlash}>/</Text>}
            {offAvg && (
              <View style={styles.statItem}>
                <View style={[styles.statDot, { backgroundColor: T.danger }]} />
                <Text style={styles.statText}>~{offAvg} <Text style={{ color: T.danger, fontWeight: '700' }}>OFF</Text></Text>
              </View>
            )}
            <Text style={styles.statLabel}>per cycle</Text>
          </View>
        );
      })()}

      {userPrediction?.computedAt && (
        <Text style={styles.computedAt}>
          Schedule computed:{' '}
          {new Date(userPrediction.computedAt).toLocaleString('en-US', {
            timeZone: 'Asia/Aden', dateStyle: 'medium', timeStyle: 'short',
          })} (Yemen)
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  infoBar: {
    flexDirection: 'row', backgroundColor: T.surface, borderRadius: 14,
    paddingVertical: 14, paddingHorizontal: 8, marginBottom: 14,
    borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'space-evenly',
  },
  infoItem: { alignItems: 'center', flex: 1 },
  infoLabel: { color: T.textMuted, fontSize: 8, fontWeight: '700', letterSpacing: 1, marginBottom: 4 },
  infoValue: { color: T.textPrimary, fontSize: 15, fontWeight: '800' },
  infoDivider: { width: 1, height: 28, backgroundColor: T.border },
  legend: { flexDirection: 'row', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: T.textMuted, fontSize: 11 },
  legendBadge: { backgroundColor: T.elevated, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2, borderWidth: 1, borderColor: 'transparent' },
  legendBadgeText: { color: T.textMuted, fontSize: 9, fontStyle: 'italic' },
  sectionLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 12, textTransform: 'uppercase' },
  timeline: { marginBottom: 8 },
  endDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: T.border, marginLeft: 4, marginTop: 4 },
  emptyBox: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: T.textSecondary, fontSize: 20, fontWeight: '700', marginBottom: 12 },
  emptySub: { color: T.textMuted, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  computedAt: { color: T.textMuted, fontSize: 10, textAlign: 'center', marginTop: 8 },
  statsRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: T.surface, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16,
    marginTop: 8, marginBottom: 4, borderWidth: 1, borderColor: T.border,
  },
  statItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statDot: { width: 7, height: 7, borderRadius: 4 },
  statText: { color: T.textSecondary, fontSize: 13 },
  statSlash: { color: T.border, fontSize: 14, fontWeight: '300' },
  statLabel: { color: T.textMuted, fontSize: 11, marginLeft: 2 },
});
