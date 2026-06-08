import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useUserPredictions, ShiftedScheduleSlot } from '../../hooks/useUserPredictions';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useResync } from '../../contexts/ResyncContext';
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
});

export default function ScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { offset } = useUserOffset();
  const { resyncPoint } = useResync();
  const { userPrediction, loading } = useUserPredictions(offset?.offset_minutes ?? 0, resyncPoint);
  const { history: resyncHistory } = useResyncNotifications();

  const allSlots = userPrediction?.daySchedule ?? [];
  const nowMs = Date.now();

  // Find the first slot where now falls inside it (user-offset-adjusted schedule)
  const activeIdx = allSlots.findIndex(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  // Start display from the active (current) slot, not slot[0]
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
        <View style={styles.infoItem}>
          <Text style={styles.infoValue}>
            {offset ? `${offset.offset_minutes > 0 ? '+' : ''}${offset.offset_minutes}د` : '0د'}
          </Text>
          <Text style={styles.infoLabel}>الفارق</Text>
        </View>
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
});
