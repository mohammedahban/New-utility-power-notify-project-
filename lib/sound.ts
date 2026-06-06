import { Audio } from 'expo-av';
import { Platform } from 'react-native';

let activeSoundObject: Audio.Sound | null = null;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

export async function playAlarmSound(durationMs = 5000): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    // Stop any currently playing alarm
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }
    if (activeSoundObject) {
      try {
        await activeSoundObject.stopAsync();
        await activeSoundObject.unloadAsync();
      } catch (_) {}
      activeSoundObject = null;
    }

    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,   // allow sound even when app is backgrounded
      shouldDuckAndroid: false,
    });

    const { sound } = await Audio.Sound.createAsync(
      require('../assets/sounds/alarm.wav'),
      { shouldPlay: true, volume: 1.0, isLooping: false }
    );

    activeSoundObject = sound;

    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.isLoaded && status.didJustFinish) {
        sound.unloadAsync().catch(() => {});
        if (activeSoundObject === sound) activeSoundObject = null;
      }
    });

    // Hard stop after durationMs regardless
    stopTimer = setTimeout(async () => {
      try {
        await sound.stopAsync();
        await sound.unloadAsync();
      } catch (_) {}
      if (activeSoundObject === sound) activeSoundObject = null;
      stopTimer = null;
    }, durationMs);
  } catch (err) {
    console.error('[sound] playAlarmSound error:', err);
  }
}

export async function stopAlarmSound(): Promise<void> {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (activeSoundObject) {
    try {
      await activeSoundObject.stopAsync();
      await activeSoundObject.unloadAsync();
    } catch (_) {}
    activeSoundObject = null;
  }
}
