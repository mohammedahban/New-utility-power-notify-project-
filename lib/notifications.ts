import * as Notifications from 'expo-notifications';
import { Platform, AppState } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

// ── Keys ──────────────────────────────────────────────────────────────────────
export const PREFS_SOUND_KEY = '@grid_monitor/sound_enabled';
export const PREFS_DURATION_KEY = '@grid_monitor/alarm_duration';

export async function getSoundEnabled(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(PREFS_SOUND_KEY);
    return v === null ? true : v === 'true';
  } catch {
    return true;
  }
}

export async function getAlarmDuration(): Promise<number> {
  try {
    const v = await AsyncStorage.getItem(PREFS_DURATION_KEY);
    return v !== null ? Math.max(1, Math.min(10, parseInt(v, 10))) : 5;
  } catch {
    return 5;
  }
}

// ── Notification Handler (foreground) ────────────────────────────────────────
// This runs while the app is OPEN. It decides whether to show the alert/sound.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data ?? {};
    const soundEnabled = await getSoundEnabled();
    return {
      shouldShowAlert: true,
      shouldPlaySound: soundEnabled && (data.play_sound === true),
      shouldSetBadge: true,
    };
  },
});

// ── Android Channel Setup ─────────────────────────────────────────────────────
// Both channels are created eagerly at module load time (Android 8+ requires
// channels to exist BEFORE a push arrives or the notification is silently dropped).
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('grid-monitor', {
    name: 'تنبيهات الكهرباء — Grid Monitor',
    description: 'إشعارات فورية عند تغيّر حالة الكهرباء (تشغيل / انقطاع)',
    // IMPORTANCE_HIGH (4) wakes screen + shows heads-up on Android 8+
    // Use MAX (5) so the alarm sound is always audible
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 400, 200, 400, 200, 400],
    lightColor: '#22c55e',
    enableLights: true,
    enableVibrate: true,
    sound: 'alarm.wav',   // must match assets/sounds/alarm.wav
    showBadge: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
  });
}

async function ensureCommunityAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('community-alerts', {
    name: 'تنبيهات المجتمع — Community Alerts',
    description: 'إشعارات المزامنة المجتمعية من المستخدمين الموثوقين',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250, 150, 250],
    lightColor: '#38bdf8',
    enableLights: true,
    enableVibrate: true,
    sound: 'default',
    showBadge: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
  });
}

// Create channels immediately at module load so they exist before any push arrives.
// Safe to call multiple times — Android deduplicates by channel ID.
if (Platform.OS === 'android') {
  Promise.all([ensureAndroidChannel(), ensureCommunityAndroidChannel()]).catch(
    (err) => console.warn('[notifications] Channel setup error:', err),
  );
}

// ── Token Registration ────────────────────────────────────────────────────────
export async function registerPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    // Ensure both channels exist before requesting permission
    await ensureAndroidChannel();
    await ensureCommunityAndroidChannel();

    const { status: existing } = await Notifications.getPermissionsAsync();
    let finalStatus = existing;

    if (existing !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[notifications] Permission denied — push token skipped');
      return;
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as any).easConfig?.projectId ??
      (Constants as any).manifest?.extra?.eas?.projectId;

    if (!projectId || projectId === 'your-eas-project-id') {
      console.warn('[notifications] No valid EAS projectId found — token skipped');
      // Don't show an error alert here — this is a dev/config issue, not a user error.
      // The app works fine without push tokens; Growatt state still updates via real-time.
      return;
    }

    let tokenData: { data: string };
    try {
      tokenData = await Notifications.getExpoPushTokenAsync({ projectId });
    } catch (tokenErr: any) {
      // On Android APK builds without google-services.json (FCM not initialized),
      // getExpoPushTokenAsync throws "Default FirebaseApp is not initialized".
      // Catch this gracefully so the rest of the app works normally.
      const msg: string = tokenErr?.message ?? String(tokenErr);
      if (msg.includes('FirebaseApp') || msg.includes('Firebase') || msg.includes('FCM')) {
        console.warn('[notifications] FCM not configured — push tokens disabled:', msg);
        // No user-facing error: the app functions normally, just without push
      } else {
        console.error('[notifications] getExpoPushTokenAsync error:', msg);
      }
      return;
    }
    const token = tokenData.data;

    // Check if current user is admin to tag the token accordingly
    let isAdmin = false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('user_profiles')
          .select('role, id')
          .eq('id', user.id)
          .maybeSingle();
        isAdmin = profile?.role === 'admin';
        const { error } = await supabase
          .from('push_tokens')
          .upsert({ token, user_id: user.id, is_admin: isAdmin }, { onConflict: 'token' });
        if (error) {
          console.error('[notifications] Token upsert error:', error.message);
        } else {
          console.log('[notifications] Push token registered (admin=' + isAdmin + '):', token);
        }
      } else {
        // Unauthenticated — register token without user association
        const { error } = await supabase
          .from('push_tokens')
          .upsert({ token }, { onConflict: 'token' });
        if (error) console.error('[notifications] Token upsert error:', error.message);
      }
    } catch (_) {
      const { error } = await supabase
        .from('push_tokens')
        .upsert({ token }, { onConflict: 'token' });
      if (error) console.error('[notifications] Token upsert error:', error.message);
    }
  } catch (err) {
    console.error('[notifications] registerPushToken error:', err);
  }
}

// ── Notification Tap Handler ──────────────────────────────────────────────────
export function setupNotificationResponseHandler(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data ?? {};
    console.log('[notifications] Tapped:', data.eventType);
    // Could navigate to history screen here if desired
  });
  return () => sub.remove();
}

// ── Foreground Received Handler ───────────────────────────────────────────────
// Plays in-app alarm sound when a grid event notification arrives while app is open
export function setupForegroundNotificationHandler(): () => void {
  const sub = Notifications.addNotificationReceivedListener(async (notification) => {
    const data = notification.request.content.data ?? {};
    if (data.play_sound !== true) return;

    const soundEnabled = await getSoundEnabled();
    if (!soundEnabled) return;

    // Dynamically import to avoid issues at module level
    try {
      const durationSec = await getAlarmDuration();
      const { playAlarmSound } = await import('./sound');
      await playAlarmSound(durationSec * 1000);
    } catch (err) {
      console.error('[notifications] In-app alarm error:', err);
    }
  });
  return () => sub.remove();
}

// ── Test Notification ─────────────────────────────────────────────────────────
export async function sendTestNotification(isOn: boolean): Promise<void> {
  await ensureAndroidChannel();
  await Notifications.scheduleNotificationAsync({
    content: {
      title: isOn ? '⚡ اختبار: الكهرباء اشتغلت' : '🔴 اختبار: الكهرباء طفت',
      body: isOn
        ? 'إشعار تجريبي — عادت الكهرباء'
        : 'إشعار تجريبي — انقطعت الكهرباء، يعمل على الطاقة الشمسية/البطارية',
      sound: 'alarm.wav',
      data: { play_sound: true, eventType: isOn ? 'UTILITY_ON' : 'UTILITY_OFF' },
      ...(Platform.OS === 'android' ? { channelId: 'grid-monitor' } : {}),
    },
    trigger: null, // fire immediately
  });
}
