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
        <Text style={styles.loadingText}>جارٍ الاتصال بمراقب الشبكة…</Text>
      </View>
    );
  }

  if (!state) {
    return (
      <View style={[styles.card, styles.centerCard, { borderColor: '#475569' }]}>
        <Text style={styles.offlineIcon}>📡</Text>
        <Text style={styles.offlineTitle}>لا توجد بيانات بعد</Text>
        <Text style={styles.offlineBody}>
          لم يعمل النظام بعد. يتحقق تلقائياً كل 5 دقائق.
        </Text>
      </View>
    );
  }

  const isInverterOffline = state.inverter_offline === true;
  const isUtilityOn = state.utility_on === true;

  const lastSeen = state.last_polled
    ? new Date(state.last_polled).toLocaleString('en-US', {
        timeZone: 'Asia/Aden',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

  const borderColor = isInverterOffline ? '#f59e0b' : isUtilityOn ? '#22c55e' : '#ef4444';

  const statusIcon = isInverterOffline ? '📡' : isUtilityOn ? '⚡' : '🔴';
  const statusLabel = isInverterOffline
    ? 'الجهاز\nغير متصل'
    : isUtilityOn
    ? 'الكهرباء شغالة'
    : 'الكهرباء طافية';
  const statusColor = borderColor;

  const gridInputW = state.vac != null ? Number(state.vac) : null;
  const sysOutW    = state.pac_to_user != null ? Number(state.pac_to_user) : null;

  return (
    <View style={[styles.card, { borderColor }]}>
      {isInverterOffline && (
        <View style={styles.offlineBanner}>
          <View style={{ flex: 1 }}>
            <Text style={styles.offlineBannerTitle}>الجهاز لا يُرسل بيانات</Text>
            <Text style={styles.offlineBannerBody}>
              توقف الجهاز عن إرسال البيانات إلى خوادم Growatt. هذا مختلف عن انقطاع الكهرباء — قد يكون الجهاز فقد الاتصال بالإنترنت أو أُعيد تشغيله.
            </Text>
          </View>
          <Text style={styles.offlineBannerIcon}>⚠️</Text>
        </View>
      )}

      <View style={styles.headerRow}>
        <Text style={styles.label}>حالة الكهرباء</Text>
        <View style={[styles.dot, { backgroundColor: borderColor }]} />
      </View>

      <Text style={[styles.status, { color: statusColor }]}>
        {statusIcon}{'  '}{statusLabel}
      </Text>

      <View style={styles.divider} />

      <View style={styles.statsRow}>
        <Stat
          label="قدرة الشبكة"
          value={isInverterOffline || gridInputW == null ? '— W' : `${gridInputW.toFixed(0)} W`}
          sub="من الشبكة"
        />
        <View style={styles.statDivider} />
        <Stat
          label="الحمل"
          value={isInverterOffline || sysOutW == null ? '— W' : `${sysOutW.toFixed(0)} W`}
          sub="للمنزل"
        />
        <View style={styles.statDivider} />
        <Stat
          label="الجهاز"
          value={isInverterOffline ? 'غير متصل' : state.status_text || '—'}
        />
      </View>

      <Text style={styles.updated}>آخر استعلام: {lastSeen} (توقيت اليمن)</Text>
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
    flexDirection: 'row-reverse',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
    gap: 10,
  },
  offlineBannerIcon: { fontSize: 18, marginTop: 1 },
  offlineBannerTitle: { color: '#fbbf24', fontWeight: '700', fontSize: 13, marginBottom: 4, textAlign: 'right' },
  offlineBannerBody: { color: '#d97706', fontSize: 11, lineHeight: 16, textAlign: 'right' },
  headerRow: { flexDirection: 'row-reverse', alignItems: 'center', marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  label: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  status: { fontSize: 36, fontWeight: '800', marginVertical: 10, letterSpacing: -0.5, textAlign: 'right' },
  divider: { height: 1, backgroundColor: '#334155', marginVertical: 14 },
  statsRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'flex-start' },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { width: 1, height: 44, backgroundColor: '#334155', alignSelf: 'center' },
  statLabel: { color: '#64748b', fontSize: 10, marginBottom: 4, textAlign: 'center' },
  statValue: { color: '#e2e8f0', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  statSub: { color: '#475569', fontSize: 10, marginTop: 2, textAlign: 'center' },
  updated: { color: '#475569', fontSize: 11, marginTop: 16, textAlign: 'right' },
  loadingText: { color: '#64748b', marginTop: 12, fontSize: 14 },
  offlineIcon: { fontSize: 40, marginBottom: 12 },
  offlineTitle: { color: '#94a3b8', fontSize: 18, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  offlineBody: { color: '#475569', fontSize: 13, textAlign: 'center', lineHeight: 20, paddingHorizontal: 16 },
});
