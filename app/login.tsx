import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  KeyboardAvoidingView, Platform, ScrollView, ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { AR } from '../constants/arabic';

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signIn, session, loading: authLoading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Auto-redirect if auth recovers while on this screen
  useEffect(() => {
    if (!authLoading && session) {
      router.replace('/(tabs)');
    }
  }, [authLoading, session]);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setError(AR.enterEmailPassword);
      return;
    }
    setSubmitting(true);
    setError('');
    const { error: err } = await signIn(email.trim(), password);
    setSubmitting(false);
    if (err) setError(err);
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[styles.container, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Logo / Brand */}
        <View style={styles.brandRow}>
          <Text style={styles.brandName}>{AR.appName}</Text>
          <Text style={styles.brandIcon}>⚡</Text>
        </View>
        <Text style={styles.tagline}>{AR.appTagline}</Text>

        {/* Card */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{AR.signIn}</Text>
          <Text style={styles.cardSub}>{AR.enterCredentials}</Text>

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

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
              placeholder="••••••••"
              placeholderTextColor="#475569"
              secureTextEntry
              textAlign="right"
              accessibilityLabel={AR.password}
            />
          </View>

          <TouchableOpacity
            style={[styles.btn, submitting && { opacity: 0.6 }]}
            onPress={handleLogin}
            activeOpacity={0.8}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.btnText}>{AR.signIn}</Text>
            )}
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={styles.switchRow}
          onPress={() => router.push('/register')}
          activeOpacity={0.7}
        >
          <Text style={styles.switchText}>
            {AR.noAccount}
            <Text style={styles.switchLink}>{AR.createAccountLink}</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#060d1a' },
  container: { paddingHorizontal: 24, alignItems: 'stretch' },
  brandRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 12, marginBottom: 6 },
  brandIcon: { fontSize: 40 },
  brandName: { fontSize: 28, fontWeight: '800', color: '#f1f5f9', letterSpacing: -0.5, textAlign: 'right' },
  tagline: { color: '#475569', fontSize: 13, marginBottom: 40, textAlign: 'right' },
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
  field: { marginBottom: 18 },
  fieldLabel: { color: '#94a3b8', fontSize: 12, fontWeight: '600', marginBottom: 8, textAlign: 'right' },
  input: {
    backgroundColor: '#060d1a', borderRadius: 12, borderWidth: 1, borderColor: '#1e3a5f',
    paddingHorizontal: 16, paddingVertical: 14, color: '#f1f5f9', fontSize: 15,
    textAlign: 'right',
  },
  btn: { backgroundColor: '#1d4ed8', borderRadius: 14, paddingVertical: 16, alignItems: 'center', marginTop: 8 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  switchRow: { marginTop: 24, alignItems: 'center' },
  switchText: { color: '#475569', fontSize: 14, textAlign: 'center' },
  switchLink: { color: '#38bdf8', fontWeight: '700' },
});
