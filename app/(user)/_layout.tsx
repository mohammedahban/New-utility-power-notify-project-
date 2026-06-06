import React, { useState, useCallback } from 'react';
import { Tabs } from 'expo-router';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal,
  ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useUtilityReports, TimeOption, ReportedState } from '../../hooks/useUtilityReports';
import { useResync } from '../../contexts/ResyncContext';

// ── Time option labels ───────────────────────────────────────────────────────
const TIME_OPTS: { key: TimeOption; label: string }[] = [
  { key: 'now', label: 'Just now' },
  { key: '5min', label: '~5 min ago' },
  { key: '10min', label: '~10 min ago' },
  { key: '15min', label: '~15 min ago' },
  { key: '20min', label: '~20 min ago' },
];

// ── Global Report Modal ───────────────────────────────────────────────────────
function GlobalReportModal({ visible, onClose, onSubmit, submitting, isCoolingDown, cooldownLabel }: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (state: ReportedState, time: TimeOption) => void;
  submitting: boolean;
  isCoolingDown: boolean;
  cooldownLabel: string | null;
}) {
  const [state, setState] = useState<ReportedState>('UTILITY_ON');
  const [time, setTime] = useState<TimeOption>('now');

  const T = {
    surface: '#0f172a', elevated: '#1e293b', border: '#334155',
    primary: '#3b82f6', accent: '#38bdf8', textPrimary: '#f1f5f9',
    textMuted: '#64748b', success: '#22c55e', danger: '#ef4444',
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={grmStyles.overlay}>
        <View style={grmStyles.sheet}>
          <View style={grmStyles.handle} />
          <Text style={grmStyles.title}>Report Utility Transition</Text>
          <Text style={grmStyles.sub}>Share what just happened so your followers can resync their schedules</Text>

          <Text style={grmStyles.sectionLabel}>WHAT HAPPENED?</Text>
          <View style={grmStyles.stateRow}>
            {(['UTILITY_ON', 'UTILITY_OFF'] as ReportedState[]).map(s => (
              <TouchableOpacity
                key={s}
                style={[
                  grmStyles.stateBtn,
                  state === s && (s === 'UTILITY_ON' ? grmStyles.stateBtnOnActive : grmStyles.stateBtnOffActive),
                ]}
                onPress={() => setState(s)}
                activeOpacity={0.8}
              >
                <Text style={grmStyles.stateEmoji}>{s === 'UTILITY_ON' ? '⚡' : '🔴'}</Text>
                <Text style={[
                  grmStyles.stateBtnText,
                  state === s && { color: s === 'UTILITY_ON' ? T.success : T.danger },
                ]}>
                  {s === 'UTILITY_ON' ? 'Came ON' : 'Went OFF'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={grmStyles.sectionLabel}>WHEN DID IT HAPPEN?</Text>
          <View style={grmStyles.timeGrid}>
            {TIME_OPTS.map(opt => (
              <TouchableOpacity
                key={opt.key}
                style={[grmStyles.timeBtn, time === opt.key && grmStyles.timeBtnActive]}
                onPress={() => setTime(opt.key)}
                activeOpacity={0.8}
              >
                <Text style={[grmStyles.timeBtnText, time === opt.key && { color: T.accent }]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {isCoolingDown ? (
            <View style={grmStyles.cooldownBox}>
              <Text style={grmStyles.cooldownText}>⏳ Next report available in {cooldownLabel}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[grmStyles.submitBtn, submitting && { opacity: 0.6 }]}
              onPress={() => onSubmit(state, time)}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={grmStyles.submitText}>📢  Share with Followers</Text>
              }
            </TouchableOpacity>
          )}
          <TouchableOpacity style={grmStyles.cancelBtn} onPress={onClose}>
            <Text style={grmStyles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const grmStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#0f172a', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: '#334155', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: '#f1f5f9', fontSize: 20, fontWeight: '800', marginBottom: 6 },
  sub: { color: '#64748b', fontSize: 13, lineHeight: 19, marginBottom: 20 },
  sectionLabel: { color: '#64748b', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 10 },
  stateRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stateBtn: { flex: 1, backgroundColor: '#1e293b', borderRadius: 14, padding: 16, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#334155' },
  stateBtnOnActive: { borderColor: '#22c55e', backgroundColor: '#052e16' },
  stateBtnOffActive: { borderColor: '#ef4444', backgroundColor: '#2d0a0a' },
  stateEmoji: { fontSize: 26 },
  stateBtnText: { color: '#64748b', fontSize: 14, fontWeight: '700' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  timeBtn: { backgroundColor: '#1e293b', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#334155' },
  timeBtnActive: { borderColor: '#38bdf8', backgroundColor: '#001a2e' },
  timeBtnText: { color: '#64748b', fontSize: 13, fontWeight: '600' },
  submitBtn: { backgroundColor: '#3b82f6', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cooldownBox: { backgroundColor: '#1e293b', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  cooldownText: { color: '#94a3b8', fontSize: 14, fontWeight: '600' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: '#64748b', fontSize: 14 },
});

export default function UserLayout() {
  const insets = useSafeAreaInsets();
  const { pendingCount } = useResyncNotifications();
  const { submitting, submitReport, isCoolingDown, cooldownLabel } = useUtilityReports();
  const { applyResync } = useResync();
  const [reportModalVisible, setReportModalVisible] = useState(false);

  const handleReport = useCallback(async (state: ReportedState, time: TimeOption) => {
    const { selfResync, error } = await submitReport(state, time);
    setReportModalVisible(false);
    if (error) {
      Alert.alert('Error', error);
    } else {
      // Immediately resync the reporter's own schedule
      if (selfResync) await applyResync(selfResync);
      Alert.alert(
        'Report Shared',
        'Your schedule has been updated and your followers have been notified.',
      );
    }
  }, [submitReport, applyResync]);

  const fabBottom = insets.bottom + 80; // sit above the tab bar

  return (
    <View style={{ flex: 1 }}>
      <GlobalReportModal
        visible={reportModalVisible}
        onClose={() => setReportModalVisible(false)}
        onSubmit={handleReport}
        submitting={submitting}
        isCoolingDown={isCoolingDown}
        cooldownLabel={cooldownLabel}
      />

      {/* Global FAB — visible on every user tab */}
      <TouchableOpacity
        style={[fabStyle.btn, { bottom: fabBottom }]}
        onPress={() => setReportModalVisible(true)}
        activeOpacity={0.85}
      >
        <Text style={fabStyle.text}>📢  Report Transition</Text>
      </TouchableOpacity>

      <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: '#0a0f1e' },
        headerTintColor: '#f1f5f9',
        headerTitleStyle: { fontWeight: '700', fontSize: 17 },
        headerShadowVisible: false,
        tabBarStyle: {
          backgroundColor: '#0f172a',
          borderTopColor: '#1e293b',
          borderTopWidth: 1,
          height: Platform.select({ ios: insets.bottom + 60, android: insets.bottom + 60, default: 70 }),
          paddingTop: 8,
          paddingBottom: Platform.select({ ios: insets.bottom + 8, android: insets.bottom + 8, default: 8 }),
        },
        tabBarActiveTintColor: '#38bdf8',
        tabBarInactiveTintColor: '#475569',
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600', marginTop: 2 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          headerTitle: 'Day Schedule',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="community"
        options={{
          title: 'Community',
          headerTitle: 'Community',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="people" size={size} color={color} />
          ),
          tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
          tabBarBadgeStyle: { backgroundColor: '#ef4444', fontSize: 10 },
        }}
      />
      <Tabs.Screen
        name="calibrate"
        options={{
          title: 'My Offset',
          headerTitle: 'Calibrate My Timing',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="compass" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          headerTitle: 'My Profile & Settings',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="person-circle-outline" size={size} color={color} />
          ),
        }}
      />
      </Tabs>
    </View>
  );
}

const fabStyle = StyleSheet.create({
  btn: {
    position: 'absolute',
    right: 16,
    backgroundColor: '#3b82f6',
    borderRadius: 28,
    paddingHorizontal: 20,
    paddingVertical: 14,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    zIndex: 9999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  text: { color: '#fff', fontWeight: '800', fontSize: 14 },
});
