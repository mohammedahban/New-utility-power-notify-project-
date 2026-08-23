import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as SplashScreen from 'expo-splash-screen';
import { checkInternetReachable } from '../lib/connectivity';

// Startup internet gate.
//
// When the phone has NO internet at app open, the user is held on a
// "no internet connection" screen with a reload button instead of landing
// on a broken or endlessly-spinning home screen. The reachability check
// tolerates slow connections (12s budget per attempt + one automatic
// retry), so slow-but-working internet is never misclassified as offline.
export default function ConnectivityGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [busy, setBusy] = useState(false);

  const runCheck = useCallback(async () => {
    const ok = await checkInternetReachable();
    setStatus(ok ? 'online' : 'offline');
    return ok;
  }, []);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  // The native splash is held by AuthGate until routing state is known — the
  // pre-gate startup flow the user is used to (splash → brief default route →
  // correct home, NO loading spinners). This gate must not change the ONLINE
  // flow at all, so while the probe runs we render NOTHING and leave the
  // native splash untouched (never hide it here — AuthGate hides it exactly
  // as before once the app is ready). The splash is only dismissed when the
  // phone turns out to be OFFLINE, so the no-internet screen becomes visible.
  useEffect(() => {
    if (status === 'offline') SplashScreen.hideAsync().catch(() => {});
  }, [status]);

  const onReload = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    await runCheck();
    setBusy(false);
  }, [busy, runCheck]);

  if (status === 'checking') {
    // Native splash is still covering — identical to the startup flow from
    // before this gate existed. No spinner, no flash, no behavior change.
    return null;
  }

  if (status === 'offline') {
    return (
      <View style={styles.splash}>
        <Ionicons name="cloud-offline-outline" size={76} color="#38bdf8" />
        <Text style={styles.title}>لا يوجد اتصال بالإنترنت</Text>
        <Text style={styles.body}>
          يرجى التحقق من اتصالك بالإنترنت ثم إعادة المحاولة.{'\n'}
          إذا كان الإنترنت بطيئاً فقد تستغرق المحاولة بضع ثوانٍ.
        </Text>
        <TouchableOpacity
          style={[styles.btn, busy && { opacity: 0.7 }]}
          onPress={onReload}
          disabled={busy}
          activeOpacity={0.85}
        >
          {busy ? (
            <ActivityIndicator size="small" color="#060d1a" />
          ) : (
            <Text style={styles.btnText}>إعادة المحاولة</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    backgroundColor: '#060d1a',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    color: '#f1f5f9',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 20,
    textAlign: 'center',
  },
  body: {
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 24,
    marginTop: 12,
    textAlign: 'center',
  },
  btn: {
    marginTop: 28,
    backgroundColor: '#38bdf8',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 44,
    minWidth: 180,
    alignItems: 'center',
  },
  btnText: {
    color: '#060d1a',
    fontSize: 16,
    fontWeight: '800',
  },
});
