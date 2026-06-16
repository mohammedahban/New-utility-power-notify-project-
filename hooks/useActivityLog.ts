/**
 * useActivityLog — session tracking hook
 * Inserts a row on app foreground, updates with end + duration on background.
 * Call once from a layout that wraps the entire authenticated app.
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export function useActivityLog() {
  const { user } = useAuth();
  const sessionIdRef = useRef<number | null>(null);
  const sessionStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (!user?.id) return;

    let cancelled = false;

    const startSession = async () => {
      if (cancelled) return;
      sessionStartRef.current = Date.now();
      try {
        const { data, error } = await supabase
          .from('user_activity_logs')
          .insert({ user_id: user.id, started_at: new Date().toISOString() })
          .select('id')
          .single();
        if (!error && data && !cancelled) {
          sessionIdRef.current = data.id;
        }
      } catch (_) { /* non-fatal */ }
    };

    const endSession = async () => {
      const id = sessionIdRef.current;
      const start = sessionStartRef.current;
      if (!id || !start) return;
      sessionIdRef.current = null;
      sessionStartRef.current = null;
      const durationSeconds = Math.round((Date.now() - start) / 1000);
      try {
        await supabase
          .from('user_activity_logs')
          .update({
            ended_at: new Date().toISOString(),
            duration_seconds: durationSeconds,
          })
          .eq('id', id);
      } catch (_) { /* non-fatal */ }
    };

    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        startSession();
      } else if (nextState === 'background' || nextState === 'inactive') {
        endSession();
      }
    };

    // Start immediately on mount (app is already active)
    startSession();

    const sub = AppState.addEventListener('change', handleAppState);

    return () => {
      cancelled = true;
      sub.remove();
      endSession();
    };
  }, [user?.id]);
}
