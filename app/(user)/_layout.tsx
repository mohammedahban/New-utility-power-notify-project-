import React, { useState, useCallback } from 'react';
import { Tabs } from 'expo-router';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal,
  ActivityIndicator, Alert, Platform, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useUtilityReports, TimeOption, ReportedState } from '../../hooks/useUtilityReports';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useResync } from '../../contexts/ResyncContext';
import { AR } from '../../constants/arabic';

const TIME_OPTS: { key: TimeOption; label: string; minutesAgo: number }[] = [
  { key: 'now',   label: AR.timeNow,   minutesAgo: 0  },
  { key: '5min',  label: AR.time5min,  minutesAgo: 5  },
  { key: '10min', label: AR.time10min, minutesAgo: 10 },
  { key: '15min', label: AR.time15min, minutesAgo: 15 },
  { key: '20min', label: AR.time20min, minutesAgo: 20 },
];

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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ justifyContent: 'flex-end', flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
        <View style={grmStyles.sheet}>
          <View style={grmStyles.handle} />
          <Text style={grmStyles.title}>{AR.reportUtilityTransition}</Text>
          <Text style={grmStyles.sub}>{AR.reportSubtitle}</Text>

          <Text style={grmStyles.sectionLabel}>{AR.whatHappened}</Text>
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
                  {s === 'UTILITY_ON' ? AR.cameOn : AR.wentOff}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={grmStyles.sectionLabel}>{AR.whenHappened}</Text>
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

          {/* Offset calibration hint */}
          <View style={grmStyles.calibHint}>
            <Text style={grmStyles.calibHintText}>
              💡 سيُحدَّث فارقك الزمني تلقائياً بناءً على هذا البلاغ
            </Text>
          </View>

          {isCoolingDown ? (
            <View style={grmStyles.cooldownBox}>
              <Text style={grmStyles.cooldownText}>⏳ {AR.cooldownText.replace('{label}', cooldownLabel ?? '')}</Text>
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
                : <Text style={grmStyles.submitText}>{AR.shareWithFollowers}</Text>
              }
            </TouchableOpacity>
          )}
          <TouchableOpacity style={grmStyles.cancelBtn} onPress={onClose}>
            <Text style={grmStyles.cancelText}>{AR.cancel}</Text>
          </TouchableOpacity>
        </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const grmStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)' },
  sheet: { backgroundColor: '#0f172a', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 40 },
  handle: { width: 40, height: 4, backgroundColor: '#334155', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: '#f1f5f9', fontSize: 20, fontWeight: '800', marginBottom: 6, textAlign: 'right' },
  sub: { color: '#64748b', fontSize: 13, lineHeight: 19, marginBottom: 20, textAlign: 'right' },
  sectionLabel: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textAlign: 'right' },
  stateRow: { flexDirection: 'row', gap: 10, marginBottom: 20 },
  stateBtn: { flex: 1, backgroundColor: '#1e293b', borderRadius: 14, padding: 16, alignItems: 'center', gap: 6, borderWidth: 1, borderColor: '#334155' },
  stateBtnOnActive: { borderColor: '#22c55e', backgroundColor: '#052e16' },
  stateBtnOffActive: { borderColor: '#ef4444', backgroundColor: '#2d0a0a' },
  stateEmoji: { fontSize: 26 },
  stateBtnText: { color: '#64748b', fontSize: 14, fontWeight: '700', textAlign: 'center' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  timeBtn: { backgroundColor: '#1e293b', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#334155' },
  timeBtnActive: { borderColor: '#38bdf8', backgroundColor: '#001a2e' },
  timeBtnText: { color: '#64748b', fontSize: 13, fontWeight: '600' },
  submitBtn: { backgroundColor: '#3b82f6', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cooldownBox: { backgroundColor: '#1e293b', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  cooldownText: { color: '#94a3b8', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  calibHint: { backgroundColor: '#001a2e', borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#38bdf833' },
  calibHintText: { color: '#94a3b8', fontSize: 12, textAlign: 'right', lineHeight: 18 },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: '#64748b', fontSize: 14 },
});

export default function UserLayout() {
  const insets = useSafeAreaInsets();
  const { pendingCount } = useResyncNotifications();
  const { submitting, submitReport, isCoolingDown, cooldownLabel } = useUtilityReports();
  const { applyResync } = useResync();
  const { calibrate } = useUserOffset();
  const [reportModalVisible, setReportModalVisible] = useState(false);

  const handleReport = useCallback(async (state: ReportedState, time: TimeOption) => {
    const { selfResync, error } = await submitReport(state, time);
    setReportModalVisible(false);
    if (error) {
      Alert.alert(AR.error, error);
      return;
    }
    // Auto-apply community resync (existing behaviour)
    if (selfResync) await applyResync(selfResync);

    // Auto-calibrate offset from this report in the background.
    // We derive the event time by subtracting minutesAgo from now.
    const opt = TIME_OPTS.find(o => o.key === time);
    const minutesAgo = opt?.minutesAgo ?? 0;
    const eventMs = Date.now() - minutesAgo * 60_000;
    const eventDate = new Date(eventMs + 3 * 60 * 60 * 1000); // shift to Yemen local
    const eventType = state === 'UTILITY_ON' ? 'UTILITY_ON' : 'UTILITY_OFF';
    // Fire calibration silently — we pass Yemen local hour/minute directly
    calibrate(eventType as any, eventDate.getUTCHours(), Math.floor(eventDate.getUTCMinutes() / 5) * 5)
      .then(({ offsetMinutes, error: calibErr }) => {
        if (!calibErr) {
          console.log(`[AutoCalibrate] new offset: ${offsetMinutes} min`);
        }
      })
      .catch(() => {/* silent */});

    Alert.alert(AR.reportShared, AR.reportSharedBody);
  }, [submitReport, applyResync, calibrate]);

  const fabBottom = insets.bottom + 80;

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

      {/* Global FAB */}
      <TouchableOpacity
        style={[fabStyle.btn, { bottom: fabBottom }]}
        onPress={() => setReportModalVisible(true)}
        activeOpacity={0.85}
      >
        <Text style={fabStyle.text}>{AR.reportTransitionBtn}</Text>
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
            title: 'الرئيسية',
            headerShown: false,
            tabBarIcon: ({ color, size }) => <Ionicons name="home" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="schedule"
          options={{
            title: 'الجدول',
            headerTitle: AR.daySchedule,
            tabBarIcon: ({ color, size }) => <Ionicons name="calendar" size={size} color={color} />,
          }}
        />
        <Tabs.Screen
          name="community"
          options={{
            title: 'المجتمع',
            headerTitle: AR.communityTitle,
            tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size} color={color} />,
            tabBarBadge: pendingCount > 0 ? pendingCount : undefined,
            tabBarBadgeStyle: { backgroundColor: '#ef4444', fontSize: 10 },
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: 'إعداداتي',
            headerTitle: AR.myProfileSettings,
            tabBarIcon: ({ color, size }) => <Ionicons name="person-circle-outline" size={size} color={color} />,
          }}
        />
        {/* Hidden screens — not shown in tab bar */}
        <Tabs.Screen
          name="reporter/[id]"
          options={{
            href: null,
            headerShown: true,
            headerTitle: 'الملف الشخصي',
            headerStyle: { backgroundColor: '#060d1a' },
            headerTintColor: '#38bdf8',
            headerTitleStyle: { fontWeight: '700', fontSize: 17, color: '#f1f5f9' },
          }}
        />
      </Tabs>
    </View>
  );
}

const fabStyle = StyleSheet.create({
  btn: {
    position: 'absolute',
    left: 16,
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
