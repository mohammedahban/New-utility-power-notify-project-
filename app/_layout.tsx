import { useEffect, useState } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { ResyncProvider } from '../contexts/ResyncContext';
import {
  registerPushToken,
  setupNotificationResponseHandler,
  setupForegroundNotificationHandler,
} from '../lib/notifications';
import { useActivityLog } from '../hooks/useActivityLog';
import { ONBOARDING_KEY } from './onboarding';

function AuthGate() {
  const { session, profile, loading } = useAuth();
  const router = useRouter();
  const segments = useSegments();
  const [onboardingChecked, setOnboardingChecked] = useState(false);

  // Check onboarding status once on mount.
  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((val) => {
        if (!mounted) return;
        setOnboardingChecked(true);
        if (!val) {
          router.replace('/onboarding');
        }
      })
      .catch(() => {
        // If storage read fails, don't block the user forever.
        if (mounted) setOnboardingChecked(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────
  //  Centralized routing
  // ─────────────────────────────────────────────────────────────────────
  //  All auth-based redirects happen here. Individual screens (login,
  //  register) no longer redirect on their own — this removes the race
  //  condition where login.tsx redirected to /(tabs) while AuthGate
  //  wanted to redirect to /(user) or /(admin).
  //
  //  Key correctness rules:
  //    • While `loading` is true we do NOT route — the splash screen
  //      covers the cold-start recovery window.
  //    • If `session` is null after loading → go to /login.
  //    • If `session` is set but `profile` is null → wait (do nothing).
  //      The splash is already hidden at this point, but AuthGate returns
  //      null so the current route is preserved. This is fine because
  //      loading only clears *after* fetchProfile() resolves (see
  //      AuthContext), so this branch is only hit on a profile fetch
  //      failure — an edge case that won't send the user to the wrong
  //      screen.
  //    • Once profile is loaded → route by role.
  // ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!onboardingChecked || loading) return;

    const inAuth = segments[0] === 'login' || segments[0] === 'register';
    const inOnboarding = segments[0] === 'onboarding';

    if (inOnboarding) return;

    if (!session) {
      if (!inAuth) {
        router.replace('/login');
      }
      return;
    }

    // Session exists — wait for profile before role-based routing.
    if (!profile) return;

    const inAdmin = segments[0] === '(admin)';
    const inUser = segments[0] === '(user)';

    if (profile.role === 'admin') {
      if (!inAdmin) {
        router.replace('/(admin)');
      }
    } else {
      if (!inUser) {
        router.replace('/(user)');
      }
    }
  }, [session, profile, loading, segments, onboardingChecked]);

  // Show a loading splash while we determine the auth state.
  // This covers both the initial getSession() call AND the token-refresh
  // path, so the user never sees a flash of /login when their session is
  // actually being recovered.
  if (loading || !onboardingChecked) {
    return (
      <View style={{ flex: 1, backgroundColor: '#060d1a', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#38bdf8" />
      </View>
    );
  }

  return null;
}

function RootNavigator() {
  const { session } = useAuth();

  // Track user session activity for analytics (non-admin users only)
  useActivityLog();

  useEffect(() => {
    if (!session) return;
    // Re-register token on each login to keep is_admin flag current
    registerPushToken();
    const c1 = setupNotificationResponseHandler();
    const c2 = setupForegroundNotificationHandler();
    return () => {
      c1();
      c2();
    };
  }, [session]);

  return (
    <>
      <AuthGate />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="register" />
        <Stack.Screen name="(admin)" />
        <Stack.Screen name="(user)" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <ResyncProvider>
          <RootNavigator />
          <StatusBar style="light" />
        </ResyncProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
