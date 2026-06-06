import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { InverterState } from '../hooks/useInverterState';

interface Props {
  state: InverterState | null;
  loading: boolean;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

export default React.memo(function StatusCard({ state, loading }: Props) {
  if (loading) {
    return (
      <View style={[styles.card, styles.centerCard]}>
        <ActivityIndicator size="large" color="#38bdf8" />
        <Text style={styles.loadingText}>Connecting to grid monitor…</Text>
      </View>
    );
  }

  if (!state) {
    return (
      <View style={[styles.card, styles.centerCard, { borderColor: '#475569' }]}>
        <Text style={styles.offlineIcon}>📡</Text>
        <Text style={styles.offlineTitle}>No Data Yet</Text>
        <Text style={styles.offlineBody}>
          The poller has not run yet. It checks every 5 minutes automatically.
        </Text>
      </View>
    );
  }

  // Three distinct states:
  // 1. inverter_offline = true  → inverter stopped reporting (data field empty)
  // 2. utility_on = false       → inverter online, grid is physically OFF
  // 3. utility_on = true        → inverter online, grid is ON
  const isInverterOffline = state.inverter_offline === true;
  const isUtilityOn = state.utility_on === true;

  const lastSeen = state.last_polled
    ? new Date(state.last_polled).toLocaleString('en-US', {
        timeZone: 'Asia/Aden',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

  // Card border color
  const borderColor = isInverterOffline ? '#f59e0b' : isUtilityOn ? '#22c55e' : '#ef4444';

  // Main status display
  const statusIcon = isInverterOffline ? '📡' : isUtilityOn ? '⚡' : '🔴';
  const statusLabel = isInverterOffline
    ? 'INVERTER\nNO SIGNAL'
    : isUtilityOn
    ? 'GRID ON'
    : 'GRID OFF';
  const statusColor = borderColor;

  // Grid input power (stored in vac column)
  const gridInputW = state.vac != null ? Number(state.vac) : null;
  const sysOutW    = state.pac_to_user != null ? Number(state.pac_to_user) : null;

  return (
    <View style={[styles.card, { borderColor }]}>
      {/* Inverter offline banner */}
      {isInverterOffline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineBannerIcon}>⚠️</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.offlineBannerTitle}>Inverter Not Reporting</Text>
            <Text style={styles.offlineBannerBody}>
              The inverter stopped sending data to Growatt servers. This is different from a grid outage —
              the inverter hardware may have lost internet or restarted.
            </Text>
          </View>
        </View>
      )}

      {/* Status header */}
      <View style={styles.headerRow}>
        <View style={[styles.dot, { backgroundColor: borderColor }]} />
        <Text style={styles.label}>UTILITY POWER STATUS</Text>
      </View>

      <Text style={[styles.status, { color: statusColor }]}>
        {statusIcon}{'  '}{statusLabel}
      </Text>

      <View style={styles.divider} />

      {/* Stats row */}
      <View style={styles.statsRow}>
        <Stat
          label="Grid Input"
          value={isInverterOffline || gridInputW == null ? '— W' : `${gridInputW.toFixed(0)} W`}
          sub="from utility"
        />
        <View style={styles.statDivider} />
        <Stat
          label="Load Power"
          value={isInverterOffline || sysOutW == null ? '— W' : `${sysOutW.toFixed(0)} W`}
          sub="to home"
        />
        <View style={styles.statDivider} />
        <Stat
          label="Inverter"
          value={isInverterOffline ? 'Offline' : state.status_text || '—'}
        />
      </View>

      <Text style={styles.updated}>Last polled: {lastSeen} (Yemen time)</Text>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1e293b',
    borderRadius: 20,
    padding: 22,
    borderWidth: 2,
    marginTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  centerCard: {
    alignItems: 'center',
    paddingVertical: 40,
    borderColor: '#334155',
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
    gap: 10,
  },
  offlineBannerIcon: {
    fontSize: 18,
    marginTop: 1,
  },
  offlineBannerTitle: {
    color: '#fbbf24',
    fontWeight: '700',
    fontSize: 13,
    marginBottom: 4,
  },
  offlineBannerBody: {
    color: '#d97706',
    fontSize: 11,
    lineHeight: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  label: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  status: {
    fontSize: 36,
    fontWeight: '800',
    marginVertical: 10,
    letterSpacing: -0.5,
  },
  divider: {
    height: 1,
    backgroundColor: '#334155',
    marginVertical: 14,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: 1,
    height: 44,
    backgroundColor: '#334155',
    alignSelf: 'center',
  },
  statLabel: {
    color: '#64748b',
    fontSize: 10,
    marginBottom: 4,
    textAlign: 'center',
  },
  statValue: {
    color: '#e2e8f0',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  statSub: {
    color: '#475569',
    fontSize: 10,
    marginTop: 2,
    textAlign: 'center',
  },
  updated: {
    color: '#475569',
    fontSize: 11,
    marginTop: 16,
    textAlign: 'right',
  },
  loadingText: {
    color: '#64748b',
    marginTop: 12,
    fontSize: 14,
  },
  offlineIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  offlineTitle: {
    color: '#94a3b8',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  offlineBody: {
    color: '#475569',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 16,
  },
});
