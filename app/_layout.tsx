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
  const [hasNavigated, setHasNavigated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(ONBOARDING_KEY).then((val) => {
      setOnboardingChecked(true);
      if (!val) {
        router.replace('/onboarding');
        setHasNavigated(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!onboardingChecked || loading) return;

    const inAuth = segments[0] === 'login' || segments[0] === 'register';
    const inOnboarding = segments[0] === 'onboarding';
    const inAdmin = segments[0] === '(admin)';
    const inUser = segments[0] === '(user)';

    if (inOnboarding) return;

       if (!session) {
      if (!inAuth) {
        setTimeout(() => router.replace('/login'), 0);
      }
      return;
       }

    // Wait for profile to load before routing
    if (!profile) return;

        if (profile.role === 'admin') {
      if (!inAdmin) {
        setTimeout(() => router.replace('/(admin)'), 0);
      }
    } else {
      if (!inUser) {
        setTimeout(() => router.replace('/(user)'), 0);
      }
        }
  }, [session, profile, loading, segments, onboardingChecked]);
  // Show loading during initial auth check (including the 2s grace window)
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
    return () => { c1(); c2(); };
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
