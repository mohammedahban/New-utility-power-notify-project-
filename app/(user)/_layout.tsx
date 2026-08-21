import React, { useState, useCallback } from 'react';
import { Tabs } from 'expo-router';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal,
  ActivityIndicator, Alert, Platform, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useResyncNotifications } from '../../hooks/useResyncNotifications';
import { useUtilityReports, TimeOption } from '../../hooks/useUtilityReports';
import { useUserOffset } from '../../hooks/useUserOffset';
import { useResync } from '../../contexts/ResyncContext';
import { UserPredictionProvider, useSharedUserPrediction } from '../../contexts/UserPredictionContext';
import { useStatusSnapshot, readPreActionStateForSnapshot } from '../../hooks/useStatusSnapshot';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';

// Submit-page time options: only "Now" .. "30 minutes before" are offered —
// the longer lookback options were removed per product decision.
const TIME_OPTS: { key: TimeOption; label: string }[] = [
  { key: 'now',   label: AR.timeNow   },
  { key: '5min',  label: AR.time5min  },
  { key: '10min', label: AR.time10min },
  { key: '15min', label: AR.time15min },
  { key: '20min', label: AR.time20min },
  { key: '30min', label: AR.time30min },
];

// TMMS V2.2: Global Report Modal — ON-ONLY reporting.
// Users NEVER report OFF. The state selector has been removed entirely.
// The engine computes Period 1/2/3 offset at submission time automatically.
function GlobalReportModal({ visible, onClose, onSubmit, submitting, isCoolingDown, cooldownLabel }: {
  visible: boolean;
  onClose: () => void;
  // V2.2: signature changed — no `state` param. Always UTILITY_ON.
  onSubmit: (time: TimeOption) => void;
  submitting: boolean;
  isCoolingDown: boolean;
  cooldownLabel: string | null;
}) {
  const [time, setTime] = useState<TimeOption>('now');
  const insets = useSafeAreaInsets();

  const T = {
    surface: '#0f172a', elevated: '#1e293b', border: '#334155',
    primary: '#3b82f6', accent: '#38bdf8', textPrimary: '#f1f5f9',
    textMuted: '#64748b', success: '#22c55e', danger: '#ef4444',
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={grmStyles.overlay}>
        <View style={[grmStyles.sheet, { paddingBottom: insets.bottom + 24 }]}>
        <ScrollView
          style={{ flexShrink: 1 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={grmStyles.handle} />
          {/* V2.2: title changed to ON-only */}
          <Text style={grmStyles.title}>{AR.reportUtilityOn}</Text>
          <Text style={grmStyles.sub}>{AR.reportOnSubtitle}</Text>

          {/* V2.2: ON-only info banner. Replaces the old state selector row. */}
          <View style={grmStyles.onOnlyBanner}>
            <Text style={grmStyles.onOnlyEmoji}>⚡</Text>
            <View style={{ flex: 1 }}>
              <Text style={grmStyles.onOnlyTitle}>{AR.onOnlyTitle}</Text>
              <Text style={grmStyles.onOnlySub}>
                {AR.onOnlySub}
              </Text>
            </View>
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

          {/* V2.2: Period 1/2/3 offset hint */}
          <View style={grmStyles.calibHint}>
            <Text style={grmStyles.calibHintText}>
              💡 {AR.offsetAutoCalculated}
            </Text>
          </View>

          {isCoolingDown ? (
            <View style={grmStyles.cooldownBox}>
              <Text style={grmStyles.cooldownText}>⏳ {AR.cooldownText.replace('{label}', cooldownLabel ?? '')}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[grmStyles.submitBtn, submitting && { opacity: 0.6 }]}
              // V2.2: always submit UTILITY_ON — no state parameter
              onPress={() => onSubmit(time)}
              disabled={submitting}
              activeOpacity={0.85}
            >
              {submitting
                ? <ActivityIndicator color="#fff" size="small" />
                : <Text style={grmStyles.submitText}>⚡ {AR.shareWithFollowers}</Text>
              }
            </TouchableOpacity>
          )}
          <TouchableOpacity style={grmStyles.cancelBtn} onPress={onClose}>
            <Text style={grmStyles.cancelText}>{AR.cancel}</Text>
          </TouchableOpacity>
        </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const grmStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  // maxHeight keeps the sheet inside the viewport; the inner ScrollView makes
  // every widget reachable on small screens (fixes clipped title/buttons).
  sheet: { backgroundColor: '#0f172a', borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, maxHeight: '94%' },
  handle: { width: 40, height: 4, backgroundColor: '#334155', borderRadius: 2, alignSelf: 'center', marginBottom: 20 },
  title: { color: '#f1f5f9', fontSize: 20, fontWeight: '800', marginBottom: 6, textAlign: 'right' },
  sub: { color: '#64748b', fontSize: 13, lineHeight: 19, marginBottom: 20, textAlign: 'right' },
  sectionLabel: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textAlign: 'right' },
  timeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  timeBtn: { backgroundColor: '#1e293b', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, borderWidth: 1, borderColor: '#334155' },
  timeBtnActive: { borderColor: '#38bdf8', backgroundColor: '#001a2e' },
  timeBtnText: { color: '#64748b', fontSize: 13, fontWeight: '600' },
  submitBtn: { backgroundColor: '#3b82f6', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10 },
  submitText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  cooldownBox: { backgroundColor: '#1e293b', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginBottom: 10, borderWidth: 1, borderColor: '#334155' },
  cooldownText: { color: '#94a3b8', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  calibHint: { backgroundColor: '#001a2e', borderRadius: 10, padding: 12, marginBottom: 16, borderWidth: 1, borderColor: '#38bdf833' },
  calibHintText: { color: '#38bdf8', fontSize: 12, textAlign: 'right', lineHeight: 18, fontWeight: '600' },
  cancelBtn: { paddingVertical: 12, alignItems: 'center' },
  cancelText: { color: '#64748b', fontSize: 14 },
  // V2.2: ON-only banner styles (replaces stateRow/stateBtn* styles)
  onOnlyBanner: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 12,
    backgroundColor: '#052e16', borderRadius: 14, padding: 14, marginBottom: 20,
    borderWidth: 1.5, borderColor: '#22c55e55',
  },
  onOnlyEmoji: { fontSize: 28 },
  onOnlyTitle: { color: '#22c55e', fontSize: 14, fontWeight: '800', marginBottom: 4, textAlign: 'right' },
  onOnlySub: { color: '#22c55ecc', fontSize: 11, lineHeight: 16, textAlign: 'right' },
});

export default function UserLayout() {
  const [reportModalVisible, setReportModalVisible] = useState(false);

  return (
    // SPEC-FIX (F13): one shared TMMS engine instance for all user screens —
    // Home / Schedule / Community read the same prediction (spec: "No
    // independent calculations are allowed").
    // AUDIT-FIX (F-08): the interactive shell lives in UserLayoutInner,
    // rendered INSIDE the provider, so the FAB report path can read the
    // shared prediction and capture a revert snapshot exactly like the
    // community-screen report path does.
    <UserPredictionProvider>
      <UserLayoutInner
        reportModalVisible={reportModalVisible}
        setReportModalVisible={setReportModalVisible}
      />
    </UserPredictionProvider>
  );
}

function UserLayoutInner({ reportModalVisible, setReportModalVisible }: {
  reportModalVisible: boolean;
  setReportModalVisible: (v: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const { pendingCount, registerAutoCloneHandler, findExistingCloneRowId, performClone } = useResyncNotifications();
  const { submitting, submitReport, isCoolingDown, cooldownLabel } = useUtilityReports();
  const { applyResync, resyncPoint } = useResync();
  const { userPrediction } = useSharedUserPrediction();
  const { offset } = useUserOffset();
  const { captureSnapshot, attachResyncHistoryRowId } = useStatusSnapshot();

  // ── ISSUE-FIX (auto-clone, spec §21–§23): followers clone the reporter's
  // calculated state AUTOMATICALLY when the notification arrives — manual
  // approval is confidence/reliability bookkeeping only, never a gate for
  // the timeline. The one-hour window is already enforced server-side
  // (suppression) and client-side (applyResync guard); manual-state priority
  // (§24) is enforced by applyResync. A previously-cloned (even reverted)
  // report never re-applies (§29).
  React.useEffect(() => {
    registerAutoCloneHandler(async (notif) => {
      try {
        const existingId = await findExistingCloneRowId(notif);
        if (existingId != null) return; // already cloned (or reverted) — do nothing

        // 1. Snapshot BEFORE any mutation so revert restores the true
        //    pre-clone state (the clone upserts user_offsets; capturing
        //    afterwards would race the F-05 realtime echo — the
        //    revert-to-neutral bug). Read the offset row + persisted resync
        //    point DIRECTLY from the source of truth: on a fresh app open
        //    the useUserOffset/useResync hooks may still be loading, and
        //    snapshotting their empty state stores 0/NEUTRAL — revert would
        //    then "restore" neutral instead of the real previous offset.
        const { data: authData } = await supabase.auth.getUser();
        const uid = authData?.user?.id;
        if (!uid) return;
        const pre = await readPreActionStateForSnapshot(uid);

        // 1b. Guard pre-check (spec §24 manual priority + §25 one-hour
        //     earliest-wins) using the PERSISTED resync point as fallback:
        //     on a fresh app open the context's resyncPoint may still be
        //     loading, and applyResync's guards would see `null` and wave a
        //     later in-window event through. If this check rejects, nothing
        //     is written and no snapshot is created.
        const effectiveTransitionAt = notif.estimated_transition_at ?? new Date().toISOString();
        const existingPoint = resyncPoint ?? pre.resyncPoint;
        if (existingPoint) {
          const existingSource = existingPoint.source ?? 'community_resync';
          if (existingSource === 'self_report') {
            console.log('[AutoClone] skipped — manual self-report has priority (§24)');
            return;
          }
          const existingMs = new Date(existingPoint.syncedAtIso).getTime();
          const incomingMs = new Date(effectiveTransitionAt).getTime();
          if (
            Number.isFinite(existingMs) && Number.isFinite(incomingMs) &&
            incomingMs > existingMs && incomingMs - existingMs < 60 * 60 * 1000
          ) {
            console.log('[AutoClone] skipped — one-hour earliest-wins window (§25)');
            return;
          }
        }

        await captureSnapshot(
          userPrediction?.currentState ?? 'OFF',
          userPrediction?.currentStateStartIso ?? null,
          pre.offsetMinutes,
          resyncPoint ?? pre.resyncPoint,
          'community_confirm',
          {
            offsetState: pre.offsetState,
            offsetValue: pre.offsetValue,
          },
        );

        // 2. Guards FIRST (spec §24 manual priority + §25 one-hour window):
        //    if applyResync rejects, NOTHING is written — the user's own
        //    manual state and offset row stay intact. (The one-hour window
        //    stays anchored by the user's own existing resync_history row.)
        const applied = await applyResync({
          syncedState: 'ON',
          syncedAtIso: effectiveTransitionAt,
          appliedAtIso: new Date().toISOString(),
          reporterName: notif.reporter_username ?? null,
          reporterReliability: null,
          offsetState: notif.reporter_offset_state ?? 'NEUTRAL',
          offsetValue: notif.reporter_offset_value ?? 0,
          timelineAlignment: notif.reporter_timeline_alignment ?? effectiveTransitionAt,
          generatedOnStartIso: effectiveTransitionAt,
          generatedOnDurationMin: notif.generated_on_duration_min ?? null,
          generatedOnReferenceIso: notif.generated_on_reference_iso ?? null,
          generatedOnReferenceKind: notif.generated_on_reference_kind ?? null,
          source: 'community_resync',
        } as any);
        if (!applied) {
          console.log('[AutoClone] timeline application rejected by guards (manual priority or one-hour rule) — nothing written');
          return;
        }

        // 3. Guards passed → persist the clone (history row + user_offsets).
        const yesResult = await performClone(notif);
        if (yesResult.cloneRowId != null) {
          attachResyncHistoryRowId(yesResult.cloneRowId);
        }
      } catch (e) {
        console.warn('[AutoClone] failed:', e);
      }
    });
    return () => registerAutoCloneHandler(null);
  }, [registerAutoCloneHandler, findExistingCloneRowId, performClone, captureSnapshot, attachResyncHistoryRowId, applyResync, userPrediction, offset, resyncPoint]);

  // V2.2: handleReport — ON-only, no calibrate() call.
  // The Period 1/2/3 offset is computed automatically inside submitReport.
  // AUDIT-FIX (F-08): this FAB path previously applied the resync with NO
  // snapshot, so "العودة إلى الحالة الأصلية" had nothing to restore. It now
  // captures the same full snapshot (state + offset semantics) as the
  // community-screen report path, BEFORE submitting.
  const handleReport = useCallback(async (time: TimeOption) => {
    // Read the effective offset semantics from the source of truth (the raw
    // numeric column is a 0 placeholder for PENDING rows).
    const { data: authData } = await supabase.auth.getUser();
    const uid = authData?.user?.id;
    const pre = uid
      ? await readPreActionStateForSnapshot(uid)
      : { offsetMinutes: offset?.offset_minutes ?? 0, offsetState: (offset as any)?.offset_state ?? null, offsetValue: (offset as any)?.offset_value ?? null, resyncPoint: null };
    await captureSnapshot(
      userPrediction?.currentState ?? 'OFF',
      userPrediction?.currentStateStartIso ?? null,
      pre.offsetMinutes,
      resyncPoint ?? pre.resyncPoint,
      'user_report',
      {
        offsetState: pre.offsetState,
        offsetValue: pre.offsetValue,
      },
    );

    // V2.2: always UTILITY_ON
    const { selfResync, error, duplicate, selfResyncHistoryId } = await submitReport('UTILITY_ON', time);
    setReportModalVisible(false);
    // F-17: bind the snapshot to the exact resync_history row created.
    if (selfResyncHistoryId != null) {
      attachResyncHistoryRowId(selfResyncHistoryId);
    }
    if (error) {
      Alert.alert(AR.error, error);
      return;
    }
    if (duplicate) {
      // F-24: idempotent re-submission — nothing new was written.
      Alert.alert(AR.reportShared, 'تم استلام هذا البلاغ مسبقاً — لا حاجة لإرساله مرة أخرى.');
      return;
    }
    // Auto-apply community resync (existing behaviour)
    if (selfResync) await applyResync(selfResync);

    Alert.alert(AR.reportShared, AR.reportSharedBody);
  }, [submitReport, applyResync, captureSnapshot, attachResyncHistoryRowId, userPrediction, offset, resyncPoint, setReportModalVisible]);

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
        {/* السجل (history): hidden from the bottom navigation per product
            decision, but the route, screen file and ALL its logic stay fully
            intact (href:null only removes the tab button) — it can be
            re-enabled later by restoring the tabBarIcon/title options. */}
        <Tabs.Screen
          name="history"
          options={{
            href: null,
            title: 'السجل',
            headerTitle: 'السجل',
          }}
        />
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
