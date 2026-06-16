import { Stack } from 'expo-router';
import { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { TouchableOpacity, Text, View, Platform } from 'react-native';
import { useUnreviewedConflictsCount } from '../../hooks/useResyncHistory';
import { AR } from '../../constants/arabic';
import { supabase } from '../../lib/supabase';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

/**
 * Silently ensures the current device's push token is flagged is_admin=true.
 * Runs on every admin app launch (mount of AdminLayout) so token stays
 * current after reinstalls or token rotation — no dialogs shown.
 */
async function silentAdminTokenRefresh(userId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') return; // don't request permission — silent only

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as any).easConfig?.projectId ??
      (Constants as any).manifest?.extra?.eas?.projectId ??
      '2ef3abec-5b06-4be3-9dd0-4dbacf35957d';

    const tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    const token = tokenData.data;

    const { error } = await supabase
      .from('push_tokens')
      .upsert({ token, user_id: userId, is_admin: true }, { onConflict: 'token' });

    if (error) {
      console.warn('[AdminLayout] silent token refresh error:', error.message);
    } else {
      console.log('[AdminLayout] Admin push token refreshed silently:', token.slice(-8));
    }
  } catch (err: any) {
    // FCM/Firebase errors are swallowed — app works normally without push
    console.warn('[AdminLayout] silentAdminTokenRefresh skipped:', err?.message ?? err);
  }
}

function ConflictsBadge() {
  const { count } = useUnreviewedConflictsCount();
  if (count === 0) return null;
  return (
    <View style={{ backgroundColor: '#f59e0b', borderRadius: 8, minWidth: 16, height: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, marginLeft: 4 }}>
      <Text style={{ color: '#000', fontSize: 9, fontWeight: '900' }}>{count}</Text>
    </View>
  );
}

export default function AdminLayout() {
  const { signOut, user } = useAuth();

  // Re-register admin push token on every login / app launch
  useEffect(() => {
    if (!user?.id) return;
    silentAdminTokenRefresh(user.id);
  }, [user?.id]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0f172a' },
        headerTintColor: '#e2e8f0',
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: '#0f172a' },
        headerLeft: () => (
          <TouchableOpacity onPress={signOut} style={{ marginLeft: 4 }}>
            <Text style={{ color: '#64748b', fontSize: 13 }}>{AR.signOut}</Text>
          </TouchableOpacity>
        ),
        headerRight: () => null,
      }}
    >
      <Stack.Screen name="index" options={{ title: AR.growattMonitor, headerShown: true }} />
      <Stack.Screen name="history" options={{ title: AR.powerHistory }} />
      <Stack.Screen name="predictions" options={{ title: AR.smartPredictions }} />
      <Stack.Screen
        name="settings"
        options={{
          title: AR.settings,
          headerTitle: () => (
            <View style={{ flexDirection: 'row-reverse', alignItems: 'center' }}>
              <Text style={{ color: '#e2e8f0', fontWeight: '700', fontSize: 17 }}>{AR.settings}</Text>
              <ConflictsBadge />
            </View>
          ),
        }}
      />
      <Stack.Screen name="conflicts" options={{ title: AR.conflictsTitle }} />
      <Stack.Screen name="accuracy" options={{ title: 'دقة التوقعات' }} />
      <Stack.Screen name="offset-analytics" options={{ title: 'تحليل الفوارق الزمنية' }} />
    </Stack>
  );
}
