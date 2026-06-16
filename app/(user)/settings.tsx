import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet,
  ActivityIndicator, TextInput, Alert, KeyboardAvoidingView, Platform,
  Linking, Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { AR } from '../../constants/arabic';

const T = {
  bg: '#0a0f1e', surface: '#0f172a', elevated: '#1e293b',
  border: '#334155', primary: '#3b82f6', accent: '#38bdf8',
  textPrimary: '#f1f5f9', textSecondary: '#94a3b8', textMuted: '#64748b',
  success: '#22c55e', danger: '#ef4444',
};

const STORAGE_KEY_SOUND = 'user_notif_sound_enabled';

export default function UserSettings() {
  const insets = useSafeAreaInsets();
  const { profile, refreshProfile, signOut } = useAuth();

  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [usernameSuccess, setUsernameSuccess] = useState(false);

  const [deletingAccount, setDeletingAccount] = useState(false);
  const [atcDebugMode, setAtcDebugMode] = useState<string | null>(null);
  const [atcDebugOffset, setAtcDebugOffset] = useState(0);

  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<'idle' | 'sent' | 'error'>('idle');

  useEffect(() => {
    (async () => {
      try {
        const soundVal = await AsyncStorage.getItem(STORAGE_KEY_SOUND);
        if (soundVal !== null) setSoundEnabled(soundVal === 'true');
      } catch (_) {}
      setLoadingPrefs(false);
    })();
  }, []);

  useEffect(() => {
    if (profile?.username) setUsernameInput(profile.username);
  }, [profile?.username]);

  const toggleSound = useCallback(async (val: boolean) => {
    setSoundEnabled(val);
    await AsyncStorage.setItem(STORAGE_KEY_SOUND, String(val));
  }, []);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      AR.deleteAccountConfirmTitle,
      AR.deleteAccountConfirmBody,
      [
        { text: AR.cancel, style: 'cancel' },
        {
          text: AR.deleteForever,
          style: 'destructive',
          onPress: async () => {
            Alert.alert(
              AR.deleteAccountFinal,
              AR.deleteAccountFinalBody.replace('{email}', profile?.email ?? ''),
              [
                { text: AR.cancel, style: 'cancel' },
                {
                  text: AR.yesDelete,
                  style: 'destructive',
                  onPress: async () => {
                    setDeletingAccount(true);
                    try {
                      const { error } = await supabase.functions.invoke('delete-account', { body: {} });
                      if (error) {
                        Alert.alert(AR.error, AR.deleteError);
                        setDeletingAccount(false);
                      } else {
                        await signOut();
                      }
                    } catch (_) {
                      Alert.alert(AR.error, AR.deleteError);
                      setDeletingAccount(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [profile?.email, signOut]);

  const handleSaveUsername = useCallback(async () => {
    const trimmed = usernameInput.trim();
    if (!trimmed) { setUsernameError(AR.usernameEmpty); return; }
    if (trimmed.length < 3) { setUsernameError(AR.usernameTooShort); return; }
    if (trimmed.length > 30) { setUsernameError(AR.usernameTooLong); return; }
    if (!/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) {
      setUsernameError(AR.usernameInvalidChars);
      return;
    }

    setSavingUsername(true);
    setUsernameError('');
    setUsernameSuccess(false);

    if (!profile?.id) { setSavingUsername(false); return; }

    const { error } = await supabase
      .from('user_profiles')
      .update({ username: trimmed, updated_at: new Date().toISOString() })
      .eq('id', profile.id);

    if (error) {
      setUsernameError(error.message);
    } else {
      await refreshProfile();
      setUsernameSuccess(true);
      setEditingUsername(false);
      setTimeout(() => setUsernameSuccess(false), 3000);
    }
    setSavingUsername(false);
  }, [usernameInput, profile?.id, refreshProfile]);

  const handleTestNotification = useCallback(async () => {
    setTestSending(true);
    setTestResult('idle');
    try {
      const { status } = await Notifications.getPermissionsAsync();
      let finalStatus = status;
      if (status !== 'granted') {
        const { status: reqStatus } = await Notifications.requestPermissionsAsync();
        finalStatus = reqStatus;
      }
      if (finalStatus !== 'granted') {
        setTestResult('error');
        setTestSending(false);
        return;
      }
      await Notifications.scheduleNotificationAsync({
        content: {
          title: '⚡ إشعار تجريبي',
          body: 'إشعارات مراقب الكهرباء تعمل بشكل صحيح.',
          sound: soundEnabled ? 'alarm.wav' : undefined,
          data: { test: true },
        },
        trigger: { seconds: 1 } as any,
      });
      setTestResult('sent');
    } catch (_) {
      setTestResult('error');
    }
    setTestSending(false);
    setTimeout(() => setTestResult('idle'), 4000);
  }, [soundEnabled]);

  if (loadingPrefs) {
    return (
      <View style={{ flex: 1, backgroundColor: T.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={T.accent} />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: T.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Profile */}
        <Text style={styles.sectionLabel}>{AR.profile}</Text>
        <View style={styles.card}>
          <View style={styles.avatarRow}>
            <View style={styles.profileInfo}>
              <View style={[styles.rolePill, profile?.role === 'admin' && styles.rolePillAdmin]}>
                <Text style={[styles.rolePillText, profile?.role === 'admin' && { color: '#fbbf24' }]}>
                  {profile?.role === 'admin' ? AR.adminRole : AR.userRole}
                </Text>
              </View>
              <Text style={styles.profileEmail}>{profile?.email}</Text>
              <Text style={styles.profileName}>{profile?.username ?? AR.noUsername}</Text>
            </View>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(profile?.username ?? profile?.email ?? '?')[0].toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />
          {!editingUsername ? (
            <View style={styles.usernameRow}>
              <TouchableOpacity
                style={styles.editBtn}
                onPress={() => {
                  setUsernameInput(profile?.username ?? '');
                  setEditingUsername(true);
                  setUsernameError('');
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.editBtnText}>{AR.edit}</Text>
              </TouchableOpacity>
              <View style={styles.usernameLeft}>
                {usernameSuccess && <Text style={styles.usernameSuccessText}>{AR.usernameUpdated}</Text>}
                <Text style={styles.usernameValue}>{profile?.username ?? '—'}</Text>
                <Text style={styles.fieldLabel}>{AR.displayName}</Text>
              </View>
            </View>
          ) : (
            <View style={styles.usernameEditBox}>
              <Text style={styles.fieldLabel}>{AR.displayName}</Text>
              <Text style={styles.usernameHint}>{AR.displayNameHint}</Text>
              <TextInput
                style={[styles.input, usernameError ? styles.inputError : null]}
                value={usernameInput}
                onChangeText={text => { setUsernameInput(text); setUsernameError(''); }}
                placeholder={AR.displayNamePlaceholder}
                placeholderTextColor={T.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={30}
                returnKeyType="done"
                onSubmitEditing={handleSaveUsername}
                textAlign="right"
                accessibilityLabel={AR.displayName}
              />
              <Text style={styles.charCount}>{usernameInput.length}/30</Text>
              {usernameError ? <Text style={styles.errorText}>{usernameError}</Text> : null}
              <View style={styles.editActionRow}>
                <TouchableOpacity
                  style={styles.cancelEditBtn}
                  onPress={() => { setEditingUsername(false); setUsernameError(''); }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.cancelEditText}>{AR.cancel}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.saveBtn, savingUsername && { opacity: 0.6 }]}
                  onPress={handleSaveUsername}
                  disabled={savingUsername}
                  activeOpacity={0.85}
                >
                  {savingUsername ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.saveBtnText}>{AR.saveName}</Text>}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Notifications */}
        <Text style={styles.sectionLabel}>{AR.notifications}</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <Switch
              value={soundEnabled}
              onValueChange={toggleSound}
              trackColor={{ false: T.elevated, true: T.primary }}
              thumbColor={soundEnabled ? T.accent : T.textMuted}
            />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{AR.notificationSound}</Text>
              <Text style={styles.rowSub}>{AR.playSoundOnChange}</Text>
            </View>
            <Text style={styles.rowIcon}>🔔</Text>
          </View>
        </View>

        {/* Diagnostics */}
        <Text style={styles.sectionLabel}>{AR.diagnostics}</Text>
        <View style={styles.card}>
          <Text style={styles.testDesc}>
            {AR.testNotifDesc}{soundEnabled ? AR.testNotifDescSound : AR.testNotifDescNoSound}
          </Text>
          <TouchableOpacity
            style={[
              styles.testBtn,
              testResult === 'sent' && styles.testBtnSuccess,
              testResult === 'error' && styles.testBtnError,
              testSending && { opacity: 0.6 },
            ]}
            onPress={handleTestNotification}
            disabled={testSending}
            activeOpacity={0.8}
          >
            {testSending ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.testBtnText}>
                {testResult === 'sent' ? AR.notifSent : testResult === 'error' ? AR.permDenied : AR.sendTestNotif}
              </Text>
            )}
          </TouchableOpacity>
          {testResult === 'error' && <Text style={styles.errorHint}>{AR.permDeniedHint}</Text>}
        </View>

        {/* About */}
        <Text style={styles.sectionLabel}>عن التطبيق</Text>
        <View style={styles.card}>
          <View style={styles.appLogoRow}>
            <View style={styles.appIconBadge}>
              <Text style={styles.appIconText}>⚡</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.appNameText}>مراقب الكهرباء</Text>
              <Text style={styles.appVersionText}>الإصدار 1.0 · عدن، اليمن</Text>
            </View>
          </View>
          <View style={styles.aboutDescBox}>
            <Text style={styles.aboutDescText}>
              تطبيق مراقب الكهرباء مخصص حالياً لمدينة{' '}
              <Text style={{ color: T.accent, fontWeight: '800' }}>عدن</Text>
              {' '}ويتيح لك متابعة انقطاع وعودة التيار الكهربائي بشكل لحظي، مع نظام توقعات ذكي يتعلم من جدول الكهرباء في منطقتك.
            </Text>
            <View style={styles.comingSoonBadge}>
              <Text style={styles.comingSoonText}>🌍 قريباً في بقية محافظات اليمن</Text>
            </View>
          </View>
          <View style={[styles.aboutRow, { borderBottomWidth: 0, marginTop: 4 }]}>
            <Text style={styles.aboutValue}>Growatt · KHM8EYS0SC</Text>
            <Text style={styles.aboutLabel}>مصدر البيانات</Text>
          </View>
        </View>

        {/* Share App */}
        <Text style={styles.sectionLabel}>شارك التطبيق</Text>
        <View style={styles.card}>
          <Text style={styles.shareDesc}>
            ساعد جيرانك ومعارفك في مدينة عدن على متابعة الكهرباء — شارك التطبيق معهم الآن.
          </Text>
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={async () => {
              try {
                await Share.share({
                  message:
                    '⚡ تطبيق مراقب الكهرباء لعدن\n' +
                    'تابع انقطاع وعودة الكهرباء لحظياً مع توقعات ذكية وإشعارات فورية.\n' +
                    'حمّله الآن من OnSpace: https://onspace.ai',
                  title: 'مراقب الكهرباء — عدن',
                });
              } catch (_) {}
            }}
            activeOpacity={0.85}
          >
            <Text style={styles.shareBtnText}>📤  مشاركة التطبيق</Text>
          </TouchableOpacity>
        </View>

        {/* Contact */}
        <Text style={styles.sectionLabel}>تواصل معنا</Text>
        <View style={styles.card}>
          <Text style={styles.contactDesc}>
            للدعم الفني، الاقتراحات، أو الاستفسارات حول الإعلانات والشراكات — يسعدنا سماعك.
          </Text>
          <TouchableOpacity
            style={styles.contactRow}
            onPress={() => Linking.openURL('mailto:Futurewait515@gmail.com')}
            activeOpacity={0.8}
          >
            <Text style={styles.contactEmail}>Futurewait515@gmail.com</Text>
            <Text style={styles.contactIcon}>✉️</Text>
          </TouchableOpacity>
          <View style={styles.contactTagsRow}>
            {['دعم فني', 'اقتراحات', 'إعلانات', 'شراكات'].map(tag => (
              <View key={tag} style={styles.contactTag}>
                <Text style={styles.contactTagText}>{tag}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Privacy */}
        <Text style={styles.sectionLabel}>الخصوصية</Text>
        <View style={styles.card}>
          {[
            { icon: '🔒', title: 'بياناتك آمنة', desc: 'لا يتم بيع بياناتك أو مشاركتها مع أي طرف ثالث.' },
            { icon: '📍', title: 'الموقع الجغرافي', desc: 'يُستخدم موقعك الاختياري فقط لتحسين توقعات منطقتك، ولا يُخزَّن بشكل دائم.' },
            { icon: '🔔', title: 'الإشعارات', desc: 'يتم إرسال إشعارات الكهرباء فقط عند تغيّر حالة التيار، ويمكنك إيقافها في أي وقت.' },
            { icon: '🗑️', title: 'حذف الحساب', desc: 'يمكنك حذف حسابك وجميع بياناتك بشكل نهائي من قسم "منطقة الخطر" أدناه.' },
          ].map((item, i, arr) => (
            <View key={item.title} style={[styles.privacyRow, i < arr.length - 1 && { borderBottomWidth: 1, borderBottomColor: T.elevated }]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.privacyTitle}>{item.title}</Text>
                <Text style={styles.privacyDesc}>{item.desc}</Text>
              </View>
              <Text style={styles.privacyIcon}>{item.icon}</Text>
            </View>
          ))}
        </View>

        {/* Sign Out */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() => {
            Alert.alert(AR.signOutConfirmTitle, AR.signOutConfirmBody, [
              { text: AR.cancel, style: 'cancel' },
              { text: AR.signOut, style: 'destructive', onPress: signOut },
            ]);
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.signOutText}>{AR.signOut}</Text>
        </TouchableOpacity>

        {/* Danger Zone */}
        <Text style={styles.sectionLabel}>{AR.dangerZone}</Text>
        <View style={[styles.card, styles.dangerCard]}>
          <Text style={styles.dangerTitle}>{AR.deleteMyAccount}</Text>
          <Text style={styles.dangerDesc}>{AR.deleteAccountDesc}</Text>
          <TouchableOpacity
            style={[styles.deleteBtn, deletingAccount && { opacity: 0.6 }]}
            onPress={handleDeleteAccount}
            disabled={deletingAccount}
            activeOpacity={0.8}
          >
            {deletingAccount ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.deleteBtnText}>{AR.deleteAccountBtn}</Text>}
          </TouchableOpacity>
        </View>

        {/* ATC Debug Panel — only in development */}
        {__DEV__ && (
          <>
            <Text style={styles.sectionLabel}>🛠 ATC — وضع الاختبار</Text>
            <View style={styles.card}>
              <Text style={[styles.rowTitle, { marginBottom: 12 }]}>محاكاة حالة ATC</Text>
              <Text style={[styles.rowSub, { marginBottom: 14 }]}>
                اختر حالة ATC للتحقق من عرض واجهة المستخدم دون الانتظار لبيانات Growatt الحقيقية.
              </Text>

              {/* Offset selector */}
              <Text style={[styles.fieldLabel, { marginBottom: 6 }]}>الفارق الزمني المُحاكى</Text>
              <View style={{ flexDirection: 'row-reverse', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
                {([-60, -30, 0, 30, 60] as number[]).map(v => (
                  <TouchableOpacity
                    key={v}
                    style={[debugStyles.offsetBtn, atcDebugOffset === v && debugStyles.offsetBtnActive]}
                    onPress={() => setAtcDebugOffset(v)}
                    activeOpacity={0.8}
                  >
                    <Text style={[debugStyles.offsetBtnText, atcDebugOffset === v && { color: T.accent }]}>
                      {v > 0 ? `+${v}` : v}د
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Mode selector */}
              <Text style={[styles.fieldLabel, { marginBottom: 6 }]}>حالة ATC</Text>
              <View style={{ gap: 8 }}>
                {(['NORMAL', 'PREDICTION_RANGE', 'UNCERTAIN_ZONE', 'WAITING_FOR_GROWATT', 'COMMUNITY_SYNCED'] as const).map(mode => {
                  const modeColors = {
                    NORMAL: '#22c55e',
                    PREDICTION_RANGE: '#38bdf8',
                    UNCERTAIN_ZONE: '#f59e0b',
                    COMMUNITY_SYNCED: '#a78bfa',
                    WAITING_FOR_GROWATT: '#3b82f6',
                  };
                  const color = modeColors[mode];
                  const isActive = atcDebugMode === mode;
                  return (
                    <TouchableOpacity
                      key={mode}
                      style={[debugStyles.modeBtn, { borderColor: color + (isActive ? 'cc' : '33'), backgroundColor: isActive ? color + '20' : T.elevated }]}
                      onPress={() => setAtcDebugMode(isActive ? null : mode)}
                      activeOpacity={0.8}
                    >
                      <View style={[debugStyles.modeDot, { backgroundColor: isActive ? color : T.textMuted }]} />
                      <Text style={[debugStyles.modeText, { color: isActive ? color : T.textSecondary }]}>{mode}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {atcDebugMode && (
                <View style={debugStyles.resultBox}>
                  <Text style={debugStyles.resultTitle}>معاينة الحالة</Text>
                  <Text style={debugStyles.resultBody}>
                    الوضع: <Text style={{ color: T.accent, fontWeight: '800' }}>{atcDebugMode}</Text>{' '}
                    الفارق: <Text style={{ color: T.warning, fontWeight: '700' }}>{atcDebugOffset > 0 ? '+' : ''}{atcDebugOffset}د</Text>
                  </Text>
                  <Text style={debugStyles.resultNote}>
                    {atcDebugMode === 'NORMAL' ? '✅ الحالة طبيعية — لا يوجد تأخير أو تجاوز للنطاق.' : ''}
                    {atcDebugMode === 'PREDICTION_RANGE' ? '🔮 النظام في نطاق التوقع — التغيير محتمل لكنه لم يُؤكَّد بعد.' : ''}
                    {atcDebugMode === 'UNCERTAIN_ZONE' ? '⚠ تجاوز النطاق المتوقع — بانتظار تأكيد مجتمعي أو من Growatt.' : ''}
                    {atcDebugMode === 'WAITING_FOR_GROWATT' ? '⏳ بانتظار Growatt — الفارق الموجب يعني أن Growatt تغيّر أولاً.' : ''}
                    {atcDebugMode === 'COMMUNITY_SYNCED' ? '👥 حالة مُزامَنة من المجتمع — الجدول يعتمد على بلاغ مجتمعي.' : ''}
                  </Text>
                </View>
              )}
            </View>
          </>
        )}

        <Text style={styles.footer}>{AR.footer}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 16 },
  sectionLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8, marginTop: 8, textAlign: 'right' },
  card: { backgroundColor: T.surface, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: T.border },
  avatarRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14, marginBottom: 14 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#1e3a5a', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: T.accent + '44' },
  avatarText: { color: T.accent, fontSize: 22, fontWeight: '900' },
  profileInfo: { flex: 1 },
  profileName: { color: T.textPrimary, fontSize: 17, fontWeight: '800', marginBottom: 2, textAlign: 'right' },
  profileEmail: { color: T.textMuted, fontSize: 12, marginBottom: 6, textAlign: 'right' },
  rolePill: { alignSelf: 'flex-end', backgroundColor: T.elevated, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: T.border },
  rolePillAdmin: { borderColor: '#854d0e', backgroundColor: '#1c1000' },
  rolePillText: { color: T.textMuted, fontSize: 10, fontWeight: '700' },
  divider: { height: 1, backgroundColor: T.elevated, marginBottom: 14 },
  usernameRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  usernameLeft: { flex: 1 },
  fieldLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 5, textAlign: 'right' },
  usernameValue: { color: T.textPrimary, fontSize: 15, fontWeight: '600', textAlign: 'right' },
  usernameSuccessText: { color: T.success, fontSize: 12, marginTop: 4, fontWeight: '600', textAlign: 'right' },
  editBtn: { backgroundColor: T.elevated, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: T.border },
  editBtnText: { color: T.accent, fontSize: 13, fontWeight: '700' },
  usernameEditBox: {},
  usernameHint: { color: T.textMuted, fontSize: 11, lineHeight: 17, marginBottom: 10, textAlign: 'right' },
  input: { backgroundColor: T.bg, borderRadius: 10, borderWidth: 1, borderColor: T.border, paddingHorizontal: 14, paddingVertical: 12, color: T.textPrimary, fontSize: 15, marginBottom: 4, textAlign: 'right' },
  inputError: { borderColor: T.danger },
  charCount: { color: T.textMuted, fontSize: 10, textAlign: 'left', marginBottom: 4 },
  errorText: { color: T.danger, fontSize: 12, marginBottom: 10, lineHeight: 17, textAlign: 'right' },
  editActionRow: { flexDirection: 'row-reverse', gap: 10, marginTop: 8 },
  saveBtn: { flex: 1, backgroundColor: T.primary, borderRadius: 10, paddingVertical: 13, alignItems: 'center' },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  cancelEditBtn: { backgroundColor: T.elevated, borderRadius: 10, paddingHorizontal: 18, paddingVertical: 13, alignItems: 'center', borderWidth: 1, borderColor: T.border },
  cancelEditText: { color: T.textMuted, fontWeight: '600', fontSize: 13 },
  row: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  rowText: { flex: 1, marginHorizontal: 12 },
  rowIcon: { fontSize: 24 },
  rowTitle: { color: T.textPrimary, fontSize: 15, fontWeight: '600', textAlign: 'right' },
  rowSub: { color: T.textMuted, fontSize: 12, marginTop: 2, textAlign: 'right' },
  testDesc: { color: T.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 16, textAlign: 'right' },
  testBtn: { backgroundColor: T.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  testBtnSuccess: { backgroundColor: '#065f46' },
  testBtnError: { backgroundColor: '#450a0a' },
  testBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errorHint: { color: '#f87171', fontSize: 12, marginTop: 8, textAlign: 'center' },
  aboutRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: T.elevated },
  aboutLabel: { color: T.textMuted, fontSize: 13 },
  aboutValue: { color: T.textSecondary, fontSize: 13, fontWeight: '600' },
  appLogoRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 14, marginBottom: 14 },
  appIconBadge: { width: 52, height: 52, borderRadius: 14, backgroundColor: '#001a2e', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: T.accent + '55' },
  appIconText: { fontSize: 24 },
  appNameText: { color: T.textPrimary, fontSize: 18, fontWeight: '900', textAlign: 'right' },
  appVersionText: { color: T.textMuted, fontSize: 11, marginTop: 2, textAlign: 'right' },
  aboutDescBox: { backgroundColor: T.elevated, borderRadius: 12, padding: 14, marginBottom: 12 },
  aboutDescText: { color: T.textSecondary, fontSize: 13, lineHeight: 22, textAlign: 'right' },
  comingSoonBadge: { marginTop: 10, backgroundColor: '#001a14', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, borderWidth: 1, borderColor: T.success + '44', alignSelf: 'flex-end' },
  comingSoonText: { color: T.success, fontSize: 11, fontWeight: '700' },
  shareDesc: { color: T.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 14, textAlign: 'right' },
  shareBtn: { backgroundColor: '#001a2e', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1.5, borderColor: T.accent + '55' },
  shareBtnText: { color: T.accent, fontWeight: '700', fontSize: 14 },
  contactDesc: { color: T.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 14, textAlign: 'right' },
  contactRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, backgroundColor: T.elevated, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 12 },
  contactIcon: { fontSize: 22 },
  contactEmail: { flex: 1, color: T.accent, fontSize: 14, fontWeight: '700', textAlign: 'right' },
  contactTagsRow: { flexDirection: 'row-reverse', gap: 8, flexWrap: 'wrap' },
  contactTag: { backgroundColor: T.elevated, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border },
  contactTagText: { color: T.textMuted, fontSize: 11, fontWeight: '600' },
  privacyRow: { flexDirection: 'row-reverse', alignItems: 'flex-start', gap: 12, paddingVertical: 12 },
  privacyIcon: { fontSize: 20, marginTop: 2 },
  privacyTitle: { color: T.textPrimary, fontSize: 13, fontWeight: '700', marginBottom: 3, textAlign: 'right' },
  privacyDesc: { color: T.textMuted, fontSize: 12, lineHeight: 18, textAlign: 'right' },
  dangerCard: { borderColor: T.danger + '44', backgroundColor: '#1a0808' },
  dangerTitle: { color: T.danger, fontSize: 15, fontWeight: '800', marginBottom: 8, textAlign: 'right' },
  dangerDesc: { color: '#f87171', fontSize: 12, lineHeight: 18, marginBottom: 16, textAlign: 'right' },
  deleteBtn: { backgroundColor: '#450a0a', borderRadius: 12, paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: T.danger },
  deleteBtnText: { color: T.danger, fontWeight: '700', fontSize: 14 },
  signOutBtn: { backgroundColor: '#1a0808', borderRadius: 14, paddingVertical: 15, alignItems: 'center', borderWidth: 1, borderColor: T.danger + '44', marginTop: 4, marginBottom: 16 },
  signOutText: { color: T.danger, fontWeight: '700', fontSize: 15 },
  footer: { color: T.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 18, marginBottom: 16, opacity: 0.6 },
});

const debugStyles = StyleSheet.create({
  offsetBtn: { backgroundColor: T.elevated, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1, borderColor: T.border },
  offsetBtnActive: { borderColor: T.accent, backgroundColor: '#001a2e' },
  offsetBtnText: { color: T.textMuted, fontSize: 13, fontWeight: '600' },
  modeBtn: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1 },
  modeDot: { width: 8, height: 8, borderRadius: 4 },
  modeText: { fontSize: 13, fontWeight: '600' },
  resultBox: { backgroundColor: T.elevated, borderRadius: 12, padding: 14, marginTop: 14, borderWidth: 1, borderColor: T.border },
  resultTitle: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginBottom: 8, textAlign: 'right' },
  resultBody: { color: T.textSecondary, fontSize: 13, textAlign: 'right', marginBottom: 8 },
  resultNote: { color: T.textMuted, fontSize: 11, lineHeight: 18, textAlign: 'right' },
});
