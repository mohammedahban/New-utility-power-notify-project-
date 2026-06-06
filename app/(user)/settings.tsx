import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, Switch, TouchableOpacity, StyleSheet,
  ActivityIndicator, TextInput, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';

const T = {
  bg: '#0a0f1e',
  surface: '#0f172a',
  elevated: '#1e293b',
  border: '#334155',
  primary: '#3b82f6',
  accent: '#38bdf8',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  success: '#22c55e',
  danger: '#ef4444',
};

const STORAGE_KEY_SOUND = 'user_notif_sound_enabled';

export default function UserSettings() {
  const insets = useSafeAreaInsets();
  const { profile, refreshProfile, signOut } = useAuth();

  // ── Profile edit state ──
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState('');
  const [usernameSuccess, setUsernameSuccess] = useState(false);

  // ── Delete account state ──
  const [deletingAccount, setDeletingAccount] = useState(false);

  // ── Notification prefs ──
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

  // Seed username input when profile loads
  useEffect(() => {
    if (profile?.username) {
      setUsernameInput(profile.username);
    }
  }, [profile?.username]);

  const toggleSound = useCallback(async (val: boolean) => {
    setSoundEnabled(val);
    await AsyncStorage.setItem(STORAGE_KEY_SOUND, String(val));
  }, []);

  const handleDeleteAccount = useCallback(() => {
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account, all reports, follow connections, and resync history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Forever',
          style: 'destructive',
          onPress: async () => {
            Alert.alert(
              'Are you absolutely sure?',
              `Type "DELETE" to confirm — your account for ${profile?.email} will be permanently removed.`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Yes, Delete',
                  style: 'destructive',
                  onPress: async () => {
                    setDeletingAccount(true);
                    try {
                      const { error } = await supabase.functions.invoke('delete-account', { body: {} });
                      if (error) {
                        Alert.alert('Error', 'Failed to delete account. Please try again.');
                        setDeletingAccount(false);
                      } else {
                        // Sign out locally — account is already deleted server-side
                        await signOut();
                      }
                    } catch (_) {
                      Alert.alert('Error', 'Failed to delete account. Please try again.');
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
    if (!trimmed) { setUsernameError('Username cannot be empty.'); return; }
    if (trimmed.length < 3) { setUsernameError('Must be at least 3 characters.'); return; }
    if (trimmed.length > 30) { setUsernameError('Must be 30 characters or fewer.'); return; }
    if (!/^[a-zA-Z0-9_\-.]+$/.test(trimmed)) {
      setUsernameError('Only letters, numbers, underscores, hyphens, and dots allowed.');
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
          title: '⚡ Test Notification',
          body: 'Grid Monitor notifications are working correctly.',
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
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: T.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        style={styles.root}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Profile Section ─────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>PROFILE</Text>
        <View style={styles.card}>
          {/* Avatar row */}
          <View style={styles.avatarRow}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(profile?.username ?? profile?.email ?? '?')[0].toUpperCase()}
              </Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{profile?.username ?? 'No username set'}</Text>
              <Text style={styles.profileEmail}>{profile?.email}</Text>
              <View style={[styles.rolePill, profile?.role === 'admin' && styles.rolePillAdmin]}>
                <Text style={[styles.rolePillText, profile?.role === 'admin' && { color: '#fbbf24' }]}>
                  {profile?.role === 'admin' ? '🛡 Admin' : '👤 User'}
                </Text>
              </View>
            </View>
          </View>

          {/* Username editor */}
          <View style={styles.divider} />
          {!editingUsername ? (
            <View style={styles.usernameRow}>
              <View style={styles.usernameLeft}>
                <Text style={styles.fieldLabel}>DISPLAY NAME</Text>
                <Text style={styles.usernameValue}>{profile?.username ?? '—'}</Text>
                {usernameSuccess && (
                  <Text style={styles.usernameSuccessText}>✅ Username updated!</Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.editBtn}
                onPress={() => {
                  setUsernameInput(profile?.username ?? '');
                  setEditingUsername(true);
                  setUsernameError('');
                }}
                activeOpacity={0.8}
              >
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.usernameEditBox}>
              <Text style={styles.fieldLabel}>DISPLAY NAME</Text>
              <Text style={styles.usernameHint}>
                This name appears to other users in the Community tab. Use 3–30 characters: letters, numbers, underscore, hyphen, dot.
              </Text>
              <TextInput
                style={[styles.input, usernameError ? styles.inputError : null]}
                value={usernameInput}
                onChangeText={text => { setUsernameInput(text); setUsernameError(''); }}
                placeholder="Enter display name"
                placeholderTextColor={T.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={30}
                returnKeyType="done"
                onSubmitEditing={handleSaveUsername}
                accessibilityLabel="Display name"
              />
              <Text style={styles.charCount}>{usernameInput.length}/30</Text>
              {usernameError ? (
                <Text style={styles.errorText}>{usernameError}</Text>
              ) : null}
              <View style={styles.editActionRow}>
                <TouchableOpacity
                  style={[styles.saveBtn, savingUsername && { opacity: 0.6 }]}
                  onPress={handleSaveUsername}
                  disabled={savingUsername}
                  activeOpacity={0.85}
                >
                  {savingUsername
                    ? <ActivityIndicator color="#fff" size="small" />
                    : <Text style={styles.saveBtnText}>Save Name</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cancelEditBtn}
                  onPress={() => { setEditingUsername(false); setUsernameError(''); }}
                  activeOpacity={0.8}
                >
                  <Text style={styles.cancelEditText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* ── Notifications Section ───────────────────────────────── */}
        <Text style={styles.sectionLabel}>NOTIFICATIONS</Text>
        <View style={styles.card}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Text style={styles.rowIcon}>🔔</Text>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>Notification Sound</Text>
                <Text style={styles.rowSub}>Play alarm when grid state changes</Text>
              </View>
            </View>
            <Switch
              value={soundEnabled}
              onValueChange={toggleSound}
              trackColor={{ false: T.elevated, true: T.primary }}
              thumbColor={soundEnabled ? T.accent : T.textMuted}
            />
          </View>
        </View>

        {/* ── Diagnostics Section ─────────────────────────────────── */}
        <Text style={styles.sectionLabel}>DIAGNOSTICS</Text>
        <View style={styles.card}>
          <Text style={styles.testDesc}>
            Send a test notification to verify alerts are working on your device.
            {soundEnabled ? ' Sound will play.' : ' Sound is disabled.'}
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
                {testResult === 'sent' ? '✓ Notification Sent!'
                  : testResult === 'error' ? '✗ Permission Denied'
                  : '🔔  Send Test Notification'}
              </Text>
            )}
          </TouchableOpacity>
          {testResult === 'error' && (
            <Text style={styles.errorHint}>
              Please enable notification permissions in your device settings.
            </Text>
          )}
        </View>

        {/* ── About Section ───────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>ABOUT</Text>
        <View style={styles.card}>
          <View style={styles.aboutRow}>
            <Text style={styles.aboutLabel}>App</Text>
            <Text style={styles.aboutValue}>Yemen Grid Monitor</Text>
          </View>
          <View style={[styles.aboutRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.aboutLabel}>Data Source</Text>
            <Text style={styles.aboutValue}>Growatt · KHM8EYS0SC</Text>
          </View>
        </View>

        {/* ── Sign Out ────────────────────────────────────────────── */}
        <TouchableOpacity
          style={styles.signOutBtn}
          onPress={() => {
            Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign Out', style: 'destructive', onPress: signOut },
            ]);
          }}
          activeOpacity={0.8}
        >
          <Text style={styles.signOutText}>Sign Out</Text>
        </TouchableOpacity>

        {/* ── Delete Account ───────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>DANGER ZONE</Text>
        <View style={[styles.card, styles.dangerCard]}>
          <Text style={styles.dangerTitle}>Delete My Account</Text>
          <Text style={styles.dangerDesc}>
            Permanently deletes your account, all your reports, follow connections, resync history, and personal offset data. This action cannot be undone.
          </Text>
          <TouchableOpacity
            style={[styles.deleteBtn, deletingAccount && { opacity: 0.6 }]}
            onPress={handleDeleteAccount}
            disabled={deletingAccount}
            activeOpacity={0.8}
          >
            {deletingAccount
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={styles.deleteBtnText}>🗑️  Delete My Account</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={styles.footer}>
          Predictions are based on historical patterns and may not be 100% accurate.
          Always verify with your local conditions.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  content: { paddingHorizontal: 16, paddingTop: 16 },

  sectionLabel: {
    color: T.textMuted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: 8,
    marginTop: 8,
  },

  card: {
    backgroundColor: T.surface,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: T.border,
  },

  // Profile
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: '#1e3a5a',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: T.accent + '44',
  },
  avatarText: { color: T.accent, fontSize: 22, fontWeight: '900' },
  profileInfo: { flex: 1 },
  profileName: { color: T.textPrimary, fontSize: 17, fontWeight: '800', marginBottom: 2 },
  profileEmail: { color: T.textMuted, fontSize: 12, marginBottom: 6 },
  rolePill: {
    alignSelf: 'flex-start',
    backgroundColor: T.elevated,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: T.border,
  },
  rolePillAdmin: { borderColor: '#854d0e', backgroundColor: '#1c1000' },
  rolePillText: { color: T.textMuted, fontSize: 10, fontWeight: '700' },

  divider: { height: 1, backgroundColor: T.elevated, marginBottom: 14 },

  usernameRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  usernameLeft: { flex: 1 },
  fieldLabel: { color: T.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 5 },
  usernameValue: { color: T.textPrimary, fontSize: 15, fontWeight: '600' },
  usernameSuccessText: { color: T.success, fontSize: 12, marginTop: 4, fontWeight: '600' },

  editBtn: {
    backgroundColor: T.elevated,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: T.border,
  },
  editBtnText: { color: T.accent, fontSize: 13, fontWeight: '700' },

  usernameEditBox: {},
  usernameHint: { color: T.textMuted, fontSize: 11, lineHeight: 17, marginBottom: 10 },
  input: {
    backgroundColor: T.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: T.textPrimary,
    fontSize: 15,
    marginBottom: 4,
  },
  inputError: { borderColor: T.danger },
  charCount: { color: T.textMuted, fontSize: 10, textAlign: 'right', marginBottom: 4 },
  errorText: { color: T.danger, fontSize: 12, marginBottom: 10, lineHeight: 17 },
  editActionRow: { flexDirection: 'row', gap: 10, marginTop: 8 },
  saveBtn: {
    flex: 1, backgroundColor: T.primary,
    borderRadius: 10, paddingVertical: 13, alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  cancelEditBtn: {
    backgroundColor: T.elevated,
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: T.border,
  },
  cancelEditText: { color: T.textMuted, fontWeight: '600', fontSize: 13 },

  // Notifications
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
  rowIcon: { fontSize: 24 },
  rowText: { flex: 1 },
  rowTitle: { color: T.textPrimary, fontSize: 15, fontWeight: '600' },
  rowSub: { color: T.textMuted, fontSize: 12, marginTop: 2 },

  // Diagnostics
  testDesc: { color: T.textMuted, fontSize: 13, lineHeight: 20, marginBottom: 16 },
  testBtn: { backgroundColor: T.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  testBtnSuccess: { backgroundColor: '#065f46' },
  testBtnError: { backgroundColor: '#450a0a' },
  testBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  errorHint: { color: '#f87171', fontSize: 12, marginTop: 8, textAlign: 'center' },

  // About
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: T.elevated,
  },
  aboutLabel: { color: T.textMuted, fontSize: 13 },
  aboutValue: { color: T.textSecondary, fontSize: 13, fontWeight: '600' },

  // Danger zone
  dangerCard: {
    borderColor: T.danger + '44',
    backgroundColor: '#1a0808',
  },
  dangerTitle: {
    color: T.danger,
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 8,
  },
  dangerDesc: {
    color: '#f87171',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 16,
  },
  deleteBtn: {
    backgroundColor: '#450a0a',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: T.danger,
  },
  deleteBtnText: { color: T.danger, fontWeight: '700', fontSize: 14 },

  // Sign out
  signOutBtn: {
    backgroundColor: '#1a0808',
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: T.danger + '44',
    marginTop: 4,
    marginBottom: 16,
  },
  signOutText: { color: T.danger, fontWeight: '700', fontSize: 15 },

  footer: {
    color: T.textMuted,
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
    opacity: 0.6,
  },
});
