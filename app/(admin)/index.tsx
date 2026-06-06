import React from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useInverterState } from '../../hooks/useInverterState';
import { usePowerEvents } from '../../hooks/usePowerEvents';
import StatusCard from '../../components/StatusCard';
import EventItem from '../../components/EventItem';
import LiveBadge from '../../components/LiveBadge';
import { usePredictions, Prediction } from '../../hooks/usePredictions';
import { useAdminResyncHistory, useUnreviewedConflictsCount } from '../../hooks/useResyncHistory';
import { AR } from '../../constants/arabic';

function CrisisBanner({ reason }: { reason: string }) {
  return (
    <View style={crisisStyles.banner}>
      <View style={{ flex: 1 }}>
        <Text style={crisisStyles.title}>{AR.patternShiftDetected}</Text>
        <Text style={crisisStyles.reason}>{reason}</Text>
      </View>
      <View style={crisisStyles.iconWrap}>
        <Text style={crisisStyles.icon}>⚠️</Text>
      </View>
    </View>
  );
}
const crisisStyles = StyleSheet.create({
  banner: { backgroundColor: '#1a0e00', borderRadius: 14, padding: 14, marginBottom: 14, flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, borderWidth: 1.5, borderColor: '#92400e' },
  iconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#451a03', alignItems: 'center', justifyContent: 'center' },
  icon: { fontSize: 18 },
  title: { color: '#f59e0b', fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 4, textAlign: 'right' },
  reason: { color: '#fbbf24', fontSize: 13, lineHeight: 19, textAlign: 'right' },
});

function PredictionWidget({ prediction, onPress }: { prediction: Prediction; onPress: () => void }) {
  const { nextTransition, confidence, confidenceLabel, isUnstable } = prediction;
  const confColor = confidence >= 88 ? '#22c55e' : confidence >= 72 ? '#38bdf8' : confidence >= 52 ? '#f59e0b' : '#ef4444';

  const fmtWait = (min: number) => {
    if (min <= 0) return 'قريباً';
    const h = Math.floor(min / 60), m = min % 60;
    if (h === 0) return `~${m}د`;
    if (m === 0) return `~${h}س`;
    return `~${h}س ${m}د`;
  };

  return (
    <TouchableOpacity style={pwStyles.card} onPress={onPress} activeOpacity={0.75}>
      <View style={pwStyles.header}>
        <View style={[pwStyles.confBadge, { backgroundColor: confColor + '22', borderColor: confColor + '55' }]}>
          <Text style={[pwStyles.confText, { color: confColor }]}>{confidence}% {confidenceLabel}</Text>
        </View>
        <Text style={pwStyles.headerLabel}>{AR.smartPrediction}</Text>
      </View>
      {isUnstable || !nextTransition ? (
        <Text style={pwStyles.unstableText}>{AR.unstableNotEnoughData}</Text>
      ) : (
        <View style={pwStyles.body}>
          <View style={pwStyles.waitBox}>
            <Text style={pwStyles.waitLabel}>{AR.in}</Text>
            <Text style={pwStyles.waitFrom}>{fmtWait(nextTransition.minFromNowMin)}</Text>
            <Text style={pwStyles.waitSep}>←</Text>
            <Text style={pwStyles.waitTo}>{fmtWait(nextTransition.maxFromNowMin)}</Text>
          </View>
          <View style={pwStyles.transitionBox}>
            <Text style={pwStyles.transLabel}>{AR.nextTransitionLabel2}</Text>
            <Text style={[pwStyles.transValue, { color: nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444' }]}>
              {nextTransition.type === 'UTILITY_ON' ? '⚡ ' + AR.gridOn : '🔴 ' + AR.gridOff}
            </Text>
            <Text style={pwStyles.transRange}>{nextTransition.rangeLabel}</Text>
          </View>
        </View>
      )}
      <Text style={pwStyles.tapHint}>‹ {AR.tapForFullAnalysis}</Text>
    </TouchableOpacity>
  );
}

const pwStyles = StyleSheet.create({
  card: { backgroundColor: '#1a1035', borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: '#4c1d95' },
  header: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  headerLabel: { color: '#a78bfa', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  confBadge: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  confText: { fontSize: 11, fontWeight: '700' },
  body: { flexDirection: 'row-reverse', gap: 10, alignItems: 'center' },
  transitionBox: { flex: 1, backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12 },
  transLabel: { color: '#64748b', fontSize: 10, marginBottom: 4, textAlign: 'right' },
  transValue: { fontSize: 16, fontWeight: '800', marginBottom: 2, textAlign: 'right' },
  transRange: { color: '#94a3b8', fontSize: 11, fontWeight: '600', textAlign: 'right' },
  waitBox: { alignItems: 'center', backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12, minWidth: 72 },
  waitLabel: { color: '#64748b', fontSize: 10, marginBottom: 4 },
  waitFrom: { color: '#c4b5fd', fontSize: 15, fontWeight: '800' },
  waitSep: { color: '#475569', fontSize: 11, marginVertical: 2 },
  waitTo: { color: '#c4b5fd', fontSize: 15, fontWeight: '800' },
  unstableText: { color: '#78716c', fontSize: 12, lineHeight: 18, backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12, textAlign: 'right' },
  tapHint: { color: '#4c1d95', fontSize: 11, textAlign: 'left', marginTop: 10, fontWeight: '600' },
});

function ResyncTimeline({ onViewConflicts, conflictsCount }: { onViewConflicts: () => void; conflictsCount: number }) {
  const { events, loading } = useAdminResyncHistory(8);

  if (loading) {
    return (
      <View style={rtStyles.card}>
        <Text style={rtStyles.header}>{AR.communityResync}</Text>
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
          <Text style={{ color: '#475569', fontSize: 12 }}>{AR.loading}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={rtStyles.card}>
      <View style={rtStyles.headerRow}>
        <TouchableOpacity onPress={onViewConflicts} style={rtStyles.conflictBtn} activeOpacity={0.8}>
          <Text style={rtStyles.conflictBtnText}>
            {conflictsCount > 0 ? AR.conflictBtn.replace('{n}', String(conflictsCount)) : AR.conflictsBtn}
          </Text>
        </TouchableOpacity>
        <Text style={rtStyles.header}>{AR.communityResync}</Text>
      </View>

      {events.length === 0 ? (
        <View style={rtStyles.empty}>
          <Text style={rtStyles.emptyText}>{AR.noResyncYet}</Text>
        </View>
      ) : (
        events.map((ev, i) => {
          const isOn = ev.reported_state === 'UTILITY_ON';
          const color = isOn ? '#22c55e' : '#ef4444';
          const effectiveTime = new Date(ev.effective_transition_at).toLocaleString('en-US', {
            timeZone: 'Asia/Aden', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          });
          return (
            <View key={ev.id} style={[rtStyles.row, i < events.length - 1 && rtStyles.rowBorder]}>
              <View style={rtStyles.rowContent}>
                <View style={rtStyles.rowTop}>
                  {ev.reporter_reliability !== null && ev.reporter_reliability !== undefined && (
                    <View style={rtStyles.relBadge}>
                      <Text style={rtStyles.relText}>{ev.reporter_reliability}% {AR.reliability}</Text>
                    </View>
                  )}
                  {ev.yes_count !== undefined && ev.yes_count > 0 && (
                    <View style={rtStyles.yesBadge}>
                      <Text style={rtStyles.yesText}>✅ {ev.yes_count} {AR.confirmed}</Text>
                    </View>
                  )}
                  <Text style={[rtStyles.state, { color }]}>
                    {isOn ? '⚡ ' + AR.gridOn : '🔴 ' + AR.gridOff}
                  </Text>
                </View>
                <Text style={rtStyles.meta}>
                  {effectiveTime} · {ev.reporter_username ?? '?'} → {ev.recipient_username ?? '?'}
                </Text>
              </View>
              <View style={[rtStyles.dot, { backgroundColor: color }]} />
            </View>
          );
        })
      )}
    </View>
  );
}

const rtStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: '#334155' },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  header: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  conflictBtn: { backgroundColor: '#1a0e00', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#92400e' },
  conflictBtnText: { color: '#f59e0b', fontSize: 11, fontWeight: '700' },
  empty: { paddingVertical: 12 },
  emptyText: { color: '#475569', fontSize: 12, lineHeight: 18, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 10, paddingVertical: 9 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
  rowContent: { flex: 1 },
  rowTop: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' },
  state: { fontSize: 14, fontWeight: '800' },
  yesBadge: { backgroundColor: '#052e16', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: '#166534' },
  yesText: { color: '#22c55e', fontSize: 10, fontWeight: '700' },
  relBadge: { backgroundColor: '#0f172a', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  relText: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  meta: { color: '#475569', fontSize: 11, lineHeight: 16, textAlign: 'right' },
});

export default function AdminDashboard() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { state, loading: stateLoading } = useInverterState();
  const { events, loading: eventsLoading } = usePowerEvents(5);
  const { prediction } = usePredictions();
  const { count: conflictsCount } = useUnreviewedConflictsCount();
  const [refreshing, setRefreshing] = React.useState(false);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 1200);
  }, []);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#38bdf8" />}
    >
      <View style={styles.headerRow}>
        <LiveBadge />
        <View>
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>{AR.adminBadge}</Text>
          </View>
          <Text style={styles.headerTitle}>{AR.growattMonitor}</Text>
          <Text style={styles.headerSub}>{AR.growattSub}</Text>
        </View>
      </View>

      <StatusCard state={state} loading={stateLoading} />

      {prediction?.apppe?.crisisMode && prediction.apppe.crisisReason ? (
        <CrisisBanner reason={prediction.apppe.crisisReason} />
      ) : null}

      <View style={styles.pillRow}>
        <View style={styles.pill}><Text style={styles.pillLabel}>{AR.pollsEvery5}</Text></View>
        <View style={styles.pill}><Text style={styles.pillLabel}>{AR.solarBattery}</Text></View>
      </View>

      {prediction ? (
        <PredictionWidget prediction={prediction} onPress={() => router.push('/(admin)/predictions')} />
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          {!eventsLoading && events.length > 0 && (
            <Text style={styles.sectionCount}>{events.length} {AR.total}</Text>
          )}
          <Text style={styles.sectionTitle}>{AR.recentEvents}</Text>
        </View>
        {eventsLoading ? (
          <View style={styles.emptyBox}><Text style={styles.emptyText}>{AR.loadingEvents}</Text></View>
        ) : events.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyIcon}>🕐</Text>
            <Text style={styles.emptyTitle}>{AR.noEventsYet}</Text>
            <Text style={styles.emptyText}>{AR.noEventsSub}</Text>
          </View>
        ) : (
          events.slice(0, 5).map((e) => <EventItem key={e.id} event={e} />)
        )}
      </View>

      <ResyncTimeline conflictsCount={conflictsCount} onViewConflicts={() => router.push('/(admin)/conflicts')} />

      <View style={styles.navRow}>
        <TouchableOpacity style={[styles.navBtn, { flex: 1 }]} onPress={() => router.push('/(admin)/settings')} activeOpacity={0.75}>
          <Text style={styles.navBtnText}>{AR.settingsNav}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navBtn, styles.navBtnAccent, { flex: 1 }]} onPress={() => router.push('/(admin)/predictions')} activeOpacity={0.75}>
          <Text style={[styles.navBtnText, { color: '#a78bfa' }]}>{AR.predictionsNav}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navBtn, { flex: 1 }]} onPress={() => router.push('/(admin)/history')} activeOpacity={0.75}>
          <Text style={styles.navBtnText}>{AR.historyNav}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16, paddingTop: 12 },
  headerRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  adminBadge: { backgroundColor: '#1e293b', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-end', marginBottom: 4, borderWidth: 1, borderColor: '#334155' },
  adminBadgeText: { color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  headerTitle: { color: '#f1f5f9', fontSize: 22, fontWeight: '800', textAlign: 'right' },
  headerSub: { color: '#64748b', fontSize: 12, marginTop: 2, textAlign: 'right' },
  pillRow: { flexDirection: 'row-reverse', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  pill: { backgroundColor: '#1e293b', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  pillLabel: { color: '#64748b', fontSize: 12, fontWeight: '500' },
  section: { marginTop: 28 },
  sectionHeader: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  sectionCount: { color: '#475569', fontSize: 12 },
  emptyBox: { backgroundColor: '#1e293b', borderRadius: 16, padding: 32, alignItems: 'center' },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyTitle: { color: '#94a3b8', fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  emptyText: { color: '#475569', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  navRow: { marginTop: 20, flexDirection: 'row-reverse', gap: 8 },
  navBtn: { backgroundColor: '#1e293b', padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  navBtnAccent: { borderColor: '#4c1d95', backgroundColor: '#1a1035' },
  navBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 14 },
});
