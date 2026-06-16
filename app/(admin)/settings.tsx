import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet, Platform, Alert, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PREFS_SOUND_KEY, PREFS_DURATION_KEY, sendTestNotification, registerPushToken } from '../../lib/notifications';
import { useAuth } from '../../contexts/AuthContext';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { supabase } from '../../lib/supabase';
import { usePredictions } from '../../hooks/usePredictions';
import { useUnreviewedConflictsCount } from '../../hooks/useResyncHistory';
import { useRouter } from 'expo-router';
import { AR } from '../../constants/arabic';

function DurationPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const steps = [1, 2, 3, 5, 7, 10];
  return (
    <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
      {steps.map(s => (
        <TouchableOpacity key={s} style={[dpStyles.btn, value === s && dpStyles.btnActive]} onPress={() => onChange(s)}>
          <Text style={[dpStyles.btnText, value === s && dpStyles.btnTextActive]}>{s}ث</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
const dpStyles = StyleSheet.create({
  btn: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10, backgroundColor: '#0f172a', borderWidth: 1, borderColor: '#334155' },
  btnActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  btnText: { color: '#64748b', fontSize: 14, fontWeight: '600' },
  btnTextActive: { color: '#fff' },
});

const PROFILE_DEFS = [
  { key: 'Night Generator',    icon: '🌑', color: '#818cf8', hours: '00 – 06' },
  { key: 'Morning Transition', icon: '🌅', color: '#fb923c', hours: '06 – 10' },
  { key: 'Solar Assisted',     icon: '☀️',  color: '#facc15', hours: '10 – 16' },
  { key: 'Evening Transition', icon: '🌆', color: '#f472b6', hours: '16 – 20' },
  { key: 'Night Consumption',  icon: '🌃', color: '#60a5fa', hours: '20 – 00' },
];

function fmtMin(min: number): string {
  if (!min || min <= 0) return '—';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

function PatternProfilesCard({ prediction }: { prediction: ReturnType<typeof usePredictions>['prediction'] }) {
  if (!prediction?.apppe) {
    return (
      <View style={ppStyles.card}>
        <Text style={ppStyles.cardTitle}>{AR.patternProfiles}</Text>
        <Text style={ppStyles.noData}>{AR.noApppeData}</Text>
      </View>
    );
  }

  const { profileSamples } = prediction.apppe;
  const dayP  = prediction.dayPattern;
  const nightP = prediction.nightPattern;

  return (
    <View style={ppStyles.card}>
      <Text style={ppStyles.cardTitle}>{AR.patternProfiles} — APPPE v{prediction.apppe.version}</Text>
      {prediction.apppe.crisisMode && (
        <View style={ppStyles.crisisBox}>
          <Text style={ppStyles.crisisText}>{AR.patternShiftActive}</Text>
          {prediction.apppe.crisisReason ? <Text style={ppStyles.crisisReason}>{prediction.apppe.crisisReason}</Text> : null}
        </View>
      )}
      <Text style={ppStyles.hint}>{AR.patternStatsHint}</Text>
      {PROFILE_DEFS.map(({ key, icon, color, hours }) => {
        const samples = profileSamples[key] ?? 0;
        const blend   = prediction.apppe!.profileBlend[key] ?? 0;
        const isDominant = prediction.apppe!.dominantProfile === key;

        return (
          <View key={key} style={[ppStyles.profileRow, isDominant && ppStyles.profileRowDominant]}>
            <View style={ppStyles.statsGrid}>
              <View style={ppStyles.statCell}>
                <Text style={ppStyles.statLabel}>{AR.blend}</Text>
                <Text style={[ppStyles.statValue, { color }]}>{blend}%</Text>
              </View>
              <View style={ppStyles.statCell}>
                <Text style={ppStyles.statLabel}>{AR.medOn}</Text>
                <Text style={[ppStyles.statValue, { color: '#22c55e' }]}>
                  {samples > 0 && dayP?.avgOnMin ? fmtMin(dayP.avgOnMin) : '—'}
                </Text>
              </View>
              <View style={ppStyles.statCell}>
                <Text style={ppStyles.statLabel}>{AR.medOff}</Text>
                <Text style={[ppStyles.statValue, { color: '#ef4444' }]}>
                  {samples > 0 && nightP ? fmtMin(nightP.avgOffMin) : '—'}
                </Text>
              </View>
              <View style={ppStyles.statCell}>
                <Text style={ppStyles.statLabel}>عينات</Text>
                <Text style={[ppStyles.statValue, { color: samples >= 4 ? '#22c55e' : samples >= 2 ? '#f59e0b' : '#ef4444' }]}>{samples}</Text>
              </View>
            </View>
            <View style={ppStyles.profileLeft}>
              <View>
                <Text style={[ppStyles.profileName, isDominant && { color }]}>
                  {key}{isDominant ? '  ●' : ''}
                </Text>
                <Text style={ppStyles.profileHours}>{hours}</Text>
              </View>
              <Text style={ppStyles.profileIcon}>{icon}</Text>
            </View>
          </View>
        );
      })}

      <View style={ppStyles.footer}>
        <View style={ppStyles.footerItem}>
          <Text style={[ppStyles.footerValue, { color: prediction.confidence >= 72 ? '#22c55e' : prediction.confidence >= 52 ? '#f59e0b' : '#ef4444' }]}>
            {prediction.confidence}%  {prediction.confidenceLabel}
          </Text>
          <Text style={ppStyles.footerLabel}>{AR.confidence}</Text>
        </View>
        <View style={ppStyles.footerItem}>
          <Text style={[ppStyles.footerValue, { color: prediction.stabilityScore >= 75 ? '#22c55e' : prediction.stabilityScore >= 45 ? '#f59e0b' : '#ef4444' }]}>
            {prediction.stabilityScore}%  {prediction.stabilityLabel}
          </Text>
          <Text style={ppStyles.footerLabel}>{AR.overallStability}</Text>
        </View>
      </View>
    </View>
  );
}

const ppStyles = StyleSheet.create({
  card: { backgroundColor: '#1e293b', borderRadius: 16, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16, marginBottom: 16, borderRightWidth: 3, borderRightColor: '#38bdf8' },
  cardTitle: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 10, textAlign: 'right' },
  noData: { color: '#475569', fontSize: 13, paddingVertical: 8, textAlign: 'right' },
  hint: { color: '#475569', fontSize: 11, lineHeight: 16, marginBottom: 14, textAlign: 'right' },
  crisisBox: { backgroundColor: '#1a0e00', borderRadius: 10, padding: 10, marginBottom: 12, borderWidth: 1, borderColor: '#92400e' },
  crisisText: { color: '#f59e0b', fontSize: 12, fontWeight: '700', marginBottom: 4, textAlign: 'right' },
  crisisReason: { color: '#fbbf24', fontSize: 11, lineHeight: 17, textAlign: 'right' },
  profileRow: { backgroundColor: '#0f172a', borderRadius: 12, padding: 12, marginBottom: 8 },
  profileRowDominant: { borderWidth: 1, borderColor: '#334155' },
  profileLeft: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, marginBottom: 10 },
  profileIcon: { fontSize: 20 },
  profileName: { color: '#94a3b8', fontSize: 13, fontWeight: '700', lineHeight: 18, textAlign: 'right' },
  profileHours: { color: '#475569', fontSize: 10, marginTop: 1 },
  statsGrid: { flexDirection: 'row-reverse', gap: 4 },
  statCell: { flex: 1, backgroundColor: '#1e293b', borderRadius: 8, padding: 8, alignItems: 'center' },
  statLabel: { color: '#475569', fontSize: 8, fontWeight: '700', letterSpacing: 0.8, marginBottom: 4 },
  statValue: { color: '#e2e8f0', fontSize: 13, fontWeight: '800' },
  footer: { flexDirection: 'row-reverse', gap: 8, marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#0f172a' },
  footerItem: { flex: 1, backgroundColor: '#0f172a', borderRadius: 10, padding: 10 },
  footerLabel: { color: '#475569', fontSize: 8, fontWeight: '700', letterSpacing: 1, marginBottom: 4, textAlign: 'right' },
  footerValue: { fontSize: 13, fontWeight: '700', textAlign: 'right' },
});

export default function AdminSettings() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut, profile } = useAuth();
  const { prediction } = usePredictions();
  const { count: conflictsCount } = useUnreviewedConflictsCount();
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [alarmDuration, setAlarmDuration] = useState(5);
  const [testingOn, setTestingOn] = useState(false);
  const [testingOff, setTestingOff] = useState(false);
  const [saved, setSaved] = useState(false);
  const [markingAdmin, setMarkingAdmin] = useState(false);
  const [adminTokenStatus, setAdminTokenStatus] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const se = await AsyncStorage.getItem(PREFS_SOUND_KEY);
        const ad = await AsyncStorage.getItem(PREFS_DURATION_KEY);
        if (se !== null) setSoundEnabled(se === 'true');
        if (ad !== null) setAlarmDuration(Math.max(1, Math.min(10, parseInt(ad, 10))));
      } catch (_) {}
    })();
    checkAdminTokenStatus();
  }, []);

  const checkAdminTokenStatus = async () => {
    if (Platform.OS === 'web') return;
    try {
      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as any).easConfig?.projectId ??
        (Constants as any).manifest?.extra?.eas?.projectId ??
        '2ef3abec-5b06-4be3-9dd0-4dbacf35957d';
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      const token = tokenData.data;
      const { data } = await supabase.from('push_tokens').select('is_admin, token').eq('token', token).maybeSingle();
      if (data) {
        setAdminTokenStatus(data.is_admin ? AR.adminTokenOk : AR.adminTokenNotMarked);
      } else {
        setAdminTokenStatus(AR.adminTokenNotReg);
      }
    } catch (_) { setAdminTokenStatus(null); }
  };

  const flashSaved = () => { setSaved(true); setTimeout(() => setSaved(false), 1500); };

  const saveSoundEnabled = useCallback(async (v: boolean) => {
    setSoundEnabled(v);
    await AsyncStorage.setItem(PREFS_SOUND_KEY, String(v));
    flashSaved();
  }, []);

  const saveDuration = useCallback(async (v: number) => {
    setAlarmDuration(v);
    await AsyncStorage.setItem(PREFS_DURATION_KEY, String(v));
    flashSaved();
  }, []);

  const handleMarkAsAdmin = async () => {
    if (Platform.OS === 'web') { Alert.alert(AR.error, AR.notOnWeb); return; }
    setMarkingAdmin(true);
    try {
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') {
        Alert.alert(AR.permissionDenied, AR.allowNotifications);
        setMarkingAdmin(false);
        return;
      }

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        (Constants as any).easConfig?.projectId ??
        (Constants as any).manifest?.extra?.eas?.projectId ??
        '2ef3abec-5b06-4be3-9dd0-4dbacf35957d'; // hardcoded fallback — same as app.json

      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
      const token = tokenData.data;
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase.from('push_tokens').upsert({ token, user_id: user?.id ?? null, is_admin: true }, { onConflict: 'token' });

      if (error) {
        Alert.alert(AR.error, error.message);
      } else {
        setAdminTokenStatus(AR.adminTokenOk);
        Alert.alert(AR.ok, AR.adminTokenOk);
      }
    } catch (err: any) {
      const msg: string = err?.message ?? String(err);
      const isFcmError = msg.includes('FIS_AUTH') || msg.includes('FirebaseApp') || msg.includes('Firebase') || msg.includes('FIS') || msg.includes('ExecutionException') || msg.includes('IOException');
      if (isFcmError) {
        // FCM/Firebase auth error — show inline status only, no blocking dialog
        // This usually means the APK was built before google-services.json was updated.
        setAdminTokenStatus('⚠️ يلزم إعادة بناء APK لتطبيق إعدادات Firebase. حالياً: FCM غير مُهيَّأ.');
      } else {
        // Non-FCM error — show inline only, no blocking dialog
        setAdminTokenStatus('خطأ: ' + msg.slice(0, 80));
      }
      console.warn('[AdminSettings] handleMarkAsAdmin error:', msg);
    }
    setMarkingAdmin(false);
  };

  const handleTestOn = async () => {
    if (Platform.OS === 'web') { Alert.alert(AR.error, AR.notOnWeb); return; }
    setTestingOn(true);
    try { await sendTestNotification(true); } catch (e: any) { Alert.alert(AR.error, e?.message ?? 'Failed'); }
    setTimeout(() => setTestingOn(false), 2000);
  };

  const handleTestOff = async () => {
    if (Platform.OS === 'web') { Alert.alert(AR.error, AR.notOnWeb); return; }
    setTestingOff(true);
    try { await sendTestNotification(false); } catch (e: any) { Alert.alert(AR.error, e?.message ?? 'Failed'); }
    setTimeout(() => setTestingOff(false), 2000);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
      {saved ? <View style={styles.savedBanner}><Text style={styles.savedText}>{AR.settingsSaved}</Text></View> : null}

      {/* Account */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{AR.adminAccount}</Text>
        <View style={styles.row}>
          <View style={styles.roleBadge}><Text style={styles.roleBadgeText}>مشرف</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowLabel}>{profile?.username ?? profile?.email ?? 'Admin'}</Text>
            <Text style={styles.rowDesc}>{profile?.email}</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.signOutBtn} onPress={signOut}>
          <Text style={styles.signOutText}>{AR.signOutAdmin}</Text>
        </TouchableOpacity>
      </View>

      {/* Mark Device as Admin */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{AR.pushTokenAdmin}</Text>
        {adminTokenStatus ? (
          <View style={[styles.statusBanner, (adminTokenStatus.includes('ADMIN') || adminTokenStatus.includes('مشرف ✓') || adminTokenStatus.includes('مسجّل')) ? styles.statusBannerOk : styles.statusBannerWarn]}>
            <Text style={[styles.statusBannerText, (adminTokenStatus.includes('مشرف ✓') || adminTokenStatus.includes('مسجّل')) ? { color: '#4ade80' } : adminTokenStatus.startsWith('⚠️') ? { color: '#f59e0b' } : { color: '#ef4444' }]}>
              {adminTokenStatus}
            </Text>
            {adminTokenStatus.startsWith('⚠️') ? (
              <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 6, lineHeight: 17, textAlign: 'right' }}>
                بعد تحديث google-services.json يجب تنزيل APK جديد من OnSpace لكي تُطبَّق تغييرات Firebase.
              </Text>
            ) : null}
          </View>
        ) : null}
        <Text style={[styles.rowDesc, { marginTop: 8, marginBottom: 12, textAlign: 'right' }]}>{AR.markAdminDesc}</Text>
        <TouchableOpacity style={[styles.markAdminBtn, markingAdmin && { opacity: 0.6 }]} onPress={handleMarkAsAdmin} disabled={markingAdmin} activeOpacity={0.8}>
          {markingAdmin ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.markAdminText}>{AR.markAsAdmin}</Text>}
        </TouchableOpacity>
      </View>

      {/* Notifications */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{AR.notificationsSection}</Text>
        <View style={styles.row}>
          <Switch value={soundEnabled} onValueChange={saveSoundEnabled} trackColor={{ false: '#334155', true: '#166534' }} thumbColor={soundEnabled ? '#22c55e' : '#64748b'} />
          <View style={{ flex: 1, marginHorizontal: 12 }}>
            <Text style={styles.rowLabel}>{AR.soundAlarm}</Text>
            <Text style={styles.rowDesc}>{AR.playAlarmDesc}</Text>
          </View>
        </View>
        <View style={{ paddingVertical: 14 }}>
          <Text style={styles.rowLabel}>{AR.alarmDuration.replace('{n}', String(alarmDuration))}</Text>
          <Text style={[styles.rowDesc, { marginBottom: 10, textAlign: 'right' }]}>{AR.alarmDurationDesc}</Text>
          <DurationPicker value={alarmDuration} onChange={saveDuration} />
        </View>
      </View>

      {/* Community Conflicts */}
      <TouchableOpacity
        style={[styles.card, { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' }]}
        onPress={() => router.push('/(admin)/conflicts')}
        activeOpacity={0.8}
      >
        <View style={{ flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginRight: 12 }}>
          <Text style={{ color: '#64748b', fontSize: 18 }}>‹</Text>
          {conflictsCount > 0 && (
            <View style={{ backgroundColor: '#f59e0b', borderRadius: 10, minWidth: 22, height: 22, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
              <Text style={{ color: '#000', fontSize: 11, fontWeight: '900' }}>{conflictsCount}</Text>
            </View>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{AR.communityConflicts}</Text>
          <Text style={[styles.rowDesc, { marginTop: 2, textAlign: 'right' }]}>
            {conflictsCount > 0
              ? AR.conflictsDesc.replace('{n}', String(conflictsCount))
              : AR.conflictsOkDesc}
          </Text>
        </View>
      </TouchableOpacity>

      {/* Pattern Profiles */}
      <PatternProfilesCard prediction={prediction} />

      {/* Test */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{AR.testSection}</Text>
        <View style={{ paddingVertical: 8 }}>
          <Text style={[styles.rowDesc, { marginBottom: 14, textAlign: 'right' }]}>{AR.testSectionDesc}</Text>
          <View style={{ flexDirection: 'row-reverse', gap: 10 }}>
            <TouchableOpacity style={[styles.testBtn, { backgroundColor: '#450a0a', borderColor: '#7f1d1d' }]} onPress={handleTestOff} disabled={testingOff}>
              <Text style={styles.testBtnText}>{testingOff ? AR.sending : AR.testOff}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.testBtn, { backgroundColor: '#052e16', borderColor: '#166534' }]} onPress={handleTestOn} disabled={testingOn}>
              <Text style={styles.testBtnText}>{testingOn ? AR.sending : AR.testOn}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f172a' },
  content: { padding: 16 },
  savedBanner: { backgroundColor: '#14532d', borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 14, borderWidth: 1, borderColor: '#166534' },
  savedText: { color: '#4ade80', fontWeight: '700', fontSize: 13, textAlign: 'center' },
  card: { backgroundColor: '#1e293b', borderRadius: 16, paddingHorizontal: 18, paddingTop: 14, paddingBottom: 16, marginBottom: 16 },
  cardTitle: { color: '#64748b', fontSize: 11, fontWeight: '700', letterSpacing: 1, marginBottom: 12, textAlign: 'right' },
  row: { flexDirection: 'row-reverse', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#0f172a' },
  rowLabel: { color: '#e2e8f0', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  rowDesc: { color: '#64748b', fontSize: 12, marginTop: 2, lineHeight: 17 },
  roleBadge: { backgroundColor: '#1d4ed8', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  roleBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  signOutBtn: { marginTop: 14, paddingVertical: 12, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#334155' },
  signOutText: { color: '#94a3b8', fontWeight: '600', fontSize: 14 },
  statusBanner: { borderRadius: 10, padding: 10, marginBottom: 4, borderWidth: 1 },
  statusBannerOk: { backgroundColor: '#052e16', borderColor: '#166534' },
  statusBannerWarn: { backgroundColor: '#1c1400', borderColor: '#713f12' },
  statusBannerText: { fontSize: 12, fontWeight: '600', lineHeight: 18, textAlign: 'right' },
  markAdminBtn: { backgroundColor: '#1d4ed8', borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  markAdminText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  testBtn: { flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: 'center', borderWidth: 1 },
  testBtnText: { color: '#e2e8f0', fontWeight: '700', fontSize: 14 },
});
