import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { PowerEvent } from '../hooks/usePowerEvents';

interface Props {
  event: PowerEvent;
}

export default React.memo(function EventItem({ event }: Props) {
  const isOn = event.event_type === 'UTILITY_ON';

  // Yemen time (UTC+3)
  const time = new Date(event.occurred_at).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <View style={[styles.row, { borderLeftColor: isOn ? '#22c55e' : '#ef4444' }]}>
      <Text style={styles.icon}>{isOn ? '⚡' : '🔴'}</Text>

      <View style={styles.info}>
        <Text style={[styles.type, { color: isOn ? '#22c55e' : '#ef4444' }]}>
          {isOn ? 'الكهرباء اشتغلت' : 'الكهرباء طفت'}
        </Text>
        <Text style={styles.time}>{time} (اليمن)</Text>
        {event.status_text ? (
          <Text style={styles.statusText}>{event.status_text}</Text>
        ) : null}
      </View>

      <View style={styles.voltBadge}>
        <Text style={styles.voltValue}>
          {event.vac != null ? Number(event.vac).toFixed(0) : '—'}
        </Text>
        <Text style={styles.voltUnit}>W</Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    backgroundColor: '#1e293b',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderRightWidth: 3,
  },
  icon: {
    fontSize: 22,
    marginLeft: 12,
  },
  info: {
    flex: 1,
  },
  type: {
    fontWeight: '700',
    fontSize: 14,
    marginBottom: 2,
    textAlign: 'right',
  },
  time: {
    color: '#64748b',
    fontSize: 12,
    textAlign: 'right',
  },
  statusText: {
    color: '#475569',
    fontSize: 11,
    marginTop: 2,
  },
  voltBadge: {
    alignItems: 'center',
    backgroundColor: '#0f172a',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    minWidth: 52,
  },
  voltValue: {
    color: '#94a3b8',
    fontSize: 14,
    fontWeight: '700',
  },
  voltUnit: {
    color: '#475569',
    fontSize: 10,
  },
});
