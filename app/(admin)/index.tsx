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

// ── Crisis Banner ─────────────────────────────────────────────────────────────
function CrisisBanner({ reason }: { reason: string }) {
  return (
    <View style={crisisStyles.banner}>
      <View style={crisisStyles.iconWrap}>
        <Text style={crisisStyles.icon}>⚠️</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={crisisStyles.title}>PATTERN SHIFT DETECTED</Text>
        <Text style={crisisStyles.reason}>{reason}</Text>
      </View>
    </View>
  );
}
const crisisStyles = StyleSheet.create({
  banner: {
    backgroundColor: '#1a0e00',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: 1.5,
    borderColor: '#92400e',
  },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#451a03',
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: { fontSize: 18 },
  title: { color: '#f59e0b', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 4 },
  reason: { color: '#fbbf24', fontSize: 13, lineHeight: 19 },
});

// ── Compact Prediction Widget ─────────────────────────────────────────────────
function PredictionWidget({ prediction, onPress }: { prediction: Prediction; onPress: () => void }) {
  const { nextTransition, confidence, confidenceLabel, isUnstable } = prediction;
  const confColor = confidence >= 88 ? '#22c55e' : confidence >= 72 ? '#38bdf8' : confidence >= 52 ? '#f59e0b' : '#ef4444';

  const fmtWait = (min: number) => {
    if (min <= 0) return 'soon';
    const h = Math.floor(min / 60), m = min % 60;
    if (h === 0) return `~${m}m`;
    if (m === 0) return `~${h}h`;
    return `~${h}h ${m}m`;
  };

  return (
    <TouchableOpacity style={pwStyles.card} onPress={onPress} activeOpacity={0.75}>
      <View style={pwStyles.header}>
        <Text style={pwStyles.headerLabel}>🔮  SMART PREDICTION</Text>
        <View style={[pwStyles.confBadge, { backgroundColor: confColor + '22', borderColor: confColor + '55' }]}>
          <Text style={[pwStyles.confText, { color: confColor }]}>{confidence}% {confidenceLabel}</Text>
        </View>
      </View>
      {isUnstable || !nextTransition ? (
        <Text style={pwStyles.unstableText}>⚠️  Pattern unstable — not enough data</Text>
      ) : (
        <View style={pwStyles.body}>
          <View style={pwStyles.transitionBox}>
            <Text style={pwStyles.transLabel}>Next transition</Text>
            <Text style={[pwStyles.transValue, { color: nextTransition.type === 'UTILITY_ON' ? '#22c55e' : '#ef4444' }]}>
              {nextTransition.type === 'UTILITY_ON' ? '⚡ Grid ON' : '🔴 Grid OFF'}
            </Text>
            <Text style={pwStyles.transRange}>{nextTransition.rangeLabel}</Text>
          </View>
          <View style={pwStyles.waitBox}>
            <Text style={pwStyles.waitLabel}>In</Text>
            <Text style={pwStyles.waitFrom}>{fmtWait(nextTransition.minFromNowMin)}</Text>
            <Text style={pwStyles.waitSep}>→</Text>
            <Text style={pwStyles.waitTo}>{fmtWait(nextTransition.maxFromNowMin)}</Text>
          </View>
        </View>
      )}
      <Text style={pwStyles.tapHint}>Tap for full analysis  ›</Text>
    </TouchableOpacity>
  );
}

const pwStyles = StyleSheet.create({
  card: { backgroundColor: '#1a1035', borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: '#4c1d95' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  headerLabel: { color: '#a78bfa', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  confBadge: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 3 },
  confText: { fontSize: 11, fontWeight: '700' },
  body: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  transitionBox: { flex: 1, backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12 },
  transLabel: { color: '#64748b', fontSize: 10, marginBottom: 4 },
  transValue: { fontSize: 16, fontWeight: '800', marginBottom: 2 },
  transRange: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  waitBox: { alignItems: 'center', backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12, minWidth: 72 },
  waitLabel: { color: '#64748b', fontSize: 10, marginBottom: 4 },
  waitFrom: { color: '#c4b5fd', fontSize: 15, fontWeight: '800' },
  waitSep: { color: '#475569', fontSize: 11, marginVertical: 2 },
  waitTo: { color: '#c4b5fd', fontSize: 15, fontWeight: '800' },
  unstableText: { color: '#78716c', fontSize: 12, lineHeight: 18, backgroundColor: '#0f0a1e', borderRadius: 10, padding: 12 },
  tapHint: { color: '#4c1d95', fontSize: 11, textAlign: 'right', marginTop: 10, fontWeight: '600' },
});

// ── Community Resync Timeline ─────────────────────────────────────────────────
function ResyncTimeline({ onViewConflicts, conflictsCount }: { onViewConflicts: () => void; conflictsCount: number }) {
  const { events, loading } = useAdminResyncHistory(8);

  if (loading) {
    return (
      <View style={rtStyles.card}>
        <Text style={rtStyles.header}>👥  COMMUNITY RESYNC EVENTS</Text>
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
          <Text style={{ color: '#475569', fontSize: 12 }}>Loading…</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={rtStyles.card}>
      <View style={rtStyles.headerRow}>
        <Text style={rtStyles.header}>👥  COMMUNITY RESYNC</Text>
        <TouchableOpacity onPress={onViewConflicts} style={rtStyles.conflictBtn} activeOpacity={0.8}>
          <Text style={rtStyles.conflictBtnText}>
            {conflictsCount > 0 ? `⚠ ${conflictsCount} Conflict${conflictsCount > 1 ? 's' : ''}` : '⚔ Conflicts'}
          </Text>
        </TouchableOpacity>
      </View>

      {events.length === 0 ? (
        <View style={rtStyles.empty}>
          <Text style={rtStyles.emptyText}>No community resyncs yet. When users confirm grid reports, they appear here.</Text>
        </View>
      ) : (
        events.map((ev, i) => {
          const isOn = ev.reported_state === 'UTILITY_ON';
          const color = isOn ? '#22c55e' : '#ef4444';
          const effectiveTime = new Date(ev.effective_transition_at).toLocaleString('en-US', {
            timeZone: 'Asia/Aden', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
          });
          return (
            <View key={ev.id} style={[rtStyles.row, i < events.length - 1 && rtStyles.rowBorder]}>
              <View style={[rtStyles.dot, { backgroundColor: color }]} />
              <View style={rtStyles.rowContent}>
                <View style={rtStyles.rowTop}>
                  <Text style={[rtStyles.state, { color }]}>
                    {isOn ? '⚡ ON' : '🔴 OFF'}
                  </Text>
                  {ev.yes_count !== undefined && ev.yes_count > 0 && (
                    <View style={rtStyles.yesBadge}>
                      <Text style={rtStyles.yesText}>✅ {ev.yes_count} confirmed</Text>
                    </View>
                  )}
                  {ev.reporter_reliability !== null && ev.reporter_reliability !== undefined && (
                    <View style={rtStyles.relBadge}>
                      <Text style={rtStyles.relText}>{ev.reporter_reliability}% rel.</Text>
                    </View>
                  )}
                </View>
                <Text style={rtStyles.meta}>
                  {effectiveTime} · by {ev.reporter_username ?? '?'} → {ev.recipient_username ?? '?'}
                </Text>
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

const rtStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: '#334155' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  header: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  conflictBtn: { backgroundColor: '#1a0e00', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: '#92400e' },
  conflictBtnText: { color: '#f59e0b', fontSize: 11, fontWeight: '700' },
  empty: { paddingVertical: 12 },
  emptyText: { color: '#475569', fontSize: 12, lineHeight: 18 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 9 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 5, flexShrink: 0 },
  rowContent: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3, flexWrap: 'wrap' },
  state: { fontSize: 14, fontWeight: '800' },
  yesBadge: { backgroundColor: '#052e16', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, borderWidth: 1, borderColor: '#166534' },
  yesText: { color: '#22c55e', fontSize: 10, fontWeight: '700' },
  relBadge: { backgroundColor: '#0f172a', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  relText: { color: '#64748b', fontSize: 10, fontWeight: '600' },
  meta: { color: '#475569', fontSize: 11, lineHeight: 16 },
});

// ── Admin Dashboard ───────────────────────────────────────────────────────────
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
        <View>
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>⚙️ ADMIN</Text>
          </View>
          <Text style={styles.headerTitle}>Growatt Monitor</Text>
          <Text style={styles.headerSub}>KHM8EYS0SC · Yemen</Text>
        </View>
        <LiveBadge />
      </View>

      <StatusCard state={state} loading={stateLoading} />

      {prediction?.apppe?.crisisMode && prediction.apppe.crisisReason ? (
        <CrisisBanner reason={prediction.apppe.crisisReason} />
      ) : null}

      <View style={styles.pillRow}>
        <View style={styles.pill}><Text style={styles.pillLabel}>☀️  Solar + BYD Battery</Text></View>
        <View style={styles.pill}><Text style={styles.pillLabel}>🔄  Polls every 5 min</Text></View>
      </View>

      {prediction ? (
        <PredictionWidget prediction={prediction} onPress={() => router.push('/(admin)/predictions')} />
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Recent Events</Text>
          {!eventsLoading && events.length > 0 && (
            <Text style={styles.sectionCount}>{events.length} total</Text>
          )}
        </View>
        {eventsLoading ? (
          <View style={styles.emptyBox}><Text style={styles.emptyText}>Loading events…</Text></View>
        ) : events.length === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyIcon}>🕐</Text>
            <Text style={styles.emptyTitle}>No Events Yet</Text>
            <Text style={styles.emptyText}>Events appear when utility power changes state.</Text>
          </View>
        ) : (
          events.slice(0, 5).map((e) => <EventItem key={e.id} event={e} />)
        )}
      </View>

      <ResyncTimeline
        conflictsCount={conflictsCount}
        onViewConflicts={() => router.push('/(admin)/conflicts')}
      />

      <View style={styles.navRow}>
        <TouchableOpacity style={[styles.navBtn, { flex: 1 }]} onPress={() => router.push('/(admin)/history')} activeOpacity={0.75}>
          <Text style={styles.navBtnText}>📋  History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navBtn, styles.navBtnAccent, { flex: 1 }]} onPress={() => router.push('/(admin)/predictions')} activeOpacity={0.75}>
          <Text style={[styles.navBtnText, { color: '#a78bfa' }]}>🔮  Predictions</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.navBtn, { flex: 1 }]} onPress={() => router.push('/(admin)/settings')} activeOpacity={0.75}>
          <Text style={styles.navBtnText}>⚙️  Settings</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16, paddingTop: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  adminBadge: { backgroundColor: '#1e293b', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, alignSelf: 'flex-start', marginBottom: 4, borderWidth: 1, borderColor: '#334155' },
  adminBadgeText: { color: '#94a3b8', fontSize: 10, fontWeight: '700', letterSpacing: 1 },
  headerTitle: { color: '#f1f5f9', fontSize: 22, fontWeight: '800' },
  headerSub: { color: '#64748b', fontSize: 12, marginTop: 2 },
  pillRow: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  pill: { backgroundColor: '#1e293b', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 },
  pillLabel: { color: '#64748b', fontSize: 12, fontWeight: '500' },
  section: { marginTop: 28 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sectionTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  sectionCount: { color: '#475569', fontSize: 12 },
  emptyBox: { backgroundColor: '#1e293b', borderRadius: 16, padding: 32, alignItems: 'center' },
  emptyIcon: { fontSize: 36, marginBottom: 10 },
  emptyTitle: { color: '#94a3b8', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  emptyText: { color: '#475569', fontSize: 13, textAlign: 'center', lineHeight: 20 },
  navRow: { marginTop: 20, flexDirection: 'row', gap: 8 },
  navBtn: { backgroundColor: '#1e293b', padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  navBtnAccent: { borderColor: '#4c1d95', backgroundColor: '#1a1035' },
  navBtnText: { color: '#38bdf8', fontWeight: '700', fontSize: 14 },
});
