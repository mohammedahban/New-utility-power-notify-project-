import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { AR } from '../constants/arabic';

export default function RegisterScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signUp, session, loading: authLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Auto-redirect if auth recovers while on this screen
  useEffect(() => {
    let mounted = true;
    if (!authLoading && session) {
      setTimeout(() => {
        if (mounted) router.replace('/(tabs)');
      }, 0);
    }
    return () => { mounted = false; };
  }, [authLoading, session]);
  const handleRegister = async () => {
    if (!username.trim() || !email.trim() || !password.trim()) {
      setError(AR.fillAllFields);
      return;
    }
    if (password.length < 6) {
      setError(AR.passwordMin6);
      return;
    }
    if (password !== confirm) {
      setError(AR.passwordsNoMatch);
      return;
    }
    setSubmitting(true);
    setError('');
    const { error: err } = await signUp(email.trim(), password, username.trim());
    setSubmitting(false);
    if (err) {
      setError(err);
    } else {
      setSuccess(true);
    }
  };

  if (success) {
    return (
      <View style={[styles.root, { justifyContent: 'center', alignItems: 'center', padding: 32 }]}>
        <Text style={{ fontSize: 56, marginBottom: 16 }}>✅</Text>
        <Text style={styles.cardTitle}>{AR.accountCreated}</Text>
        <Text style={{ color: '#64748b', fontSize: 14, textAlign: 'center', lineHeight: 22, marginVertical: 16 }}>
          {AR.accountCreatedBody}
        </Text>
        <TouchableOpacity style={styles.btn} onPress={() => router.replace('/login')}>
          <Text style={styles.btnText}>{AR.goToSignIn}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>{AR.back}</Text>
        </TouchableOpacity>

        <View style={styles.brandRow}>
          <Text style={styles.brandName}>{AR.appName}</Text>
          <Text style={styles.brandIcon}>⚡</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{AR.createAccount}</Text>
          <Text style={styles.cardSub}>{AR.joinNetwork}</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{AR.username}</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder={AR.displayNamePlaceholder}
              placeholderTextColor="#475569"
              autoCapitalize="none"
              textAlign="right"
              accessibilityLabel={AR.username}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{AR.email}</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder={AR.emailPlaceholder}
              placeholderTextColor="#475569"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              textAlign="right"
              accessibilityLabel={AR.email}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{AR.password}</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder={AR.minSixChars}
              placeholderTextColor="#475569"
              secureTextEntry
              textAlign="right"
              accessibilityLabel={AR.password}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>{AR.confirmPassword}</Text>
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder={AR.reEnterPassword}
              placeholderTextColor="#475569"
              secureTextEntry
              textAlign="right"
              accessibilityLabel={AR.confirmPassword}
            />
          </View>

          <TouchableOpacity
            style={[styles.btn, submitting && { opacity: 0.6 }]}
            onPress={handleRegister}
            activeOpacity={0.8}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>{AR.createAccount}</Text>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#060d1a' },
  container: { paddingHorizontal: 24 },
  backBtn: { marginBottom: 20, alignSelf: 'flex-end' },
  backText: { color: '#38bdf8', fontSize: 15, fontWeight: '600' },
  brandRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 24 },
  brandIcon: { fontSize: 32 },
  brandName: { fontSize: 24, fontWeight: '800', color: '#f1f5f9', textAlign: 'right' },
  card: {
    backgroundColor: '#0f1a2e', borderRadius: 20, padding: 24,
    borderWidth: 1, borderColor: '#1e3a5f',
  },
  cardTitle: { color: '#e2e8f0', fontSize: 22, fontWeight: '700', marginBottom: 4, textAlign: 'right' },
  cardSub: { color: '#64748b', fontSize: 13, marginBottom: 24, textAlign: 'right' },
  errorBox: {
    backgroundColor: 'rgba(239,68,68,0.12)', borderRadius: 10, padding: 12,
    marginBottom: 16, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)',
  },
  errorText: { color: '#f87171', fontSize: 13, lineHeight: 19, textAlign: 'right' },
  field: { marginBottom: 16 },
  fieldLabel: { color: '#94a3b8', fontSize: 12, fontWeight: '600', marginBottom: 8, textAlign: 'right' },
  input: {
    backgroundColor: '#060d1a', borderRadius: 12, borderWidth: 1, borderColor: '#1e3a5f',
    paddingHorizontal: 16, paddingVertical: 14, color: '#f1f5f9', fontSize: 15,
    textAlign: 'right',
  },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
