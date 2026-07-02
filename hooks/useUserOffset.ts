/**
 * useUserOffset — manages the user's personal time offset (DSD calibration)
 *
 * Reads from / writes to the `user_offsets` table.
 * Also manages the pending DSD candidate (a speculative offset awaiting
 * Growatt confirmation before being committed).
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

export interface UserOffset {
  offset_minutes: number;
  last_event_type: string | null;
  last_event_at: string | null;
  updated_at: string;
  offset_state: string | null;
  offset_value: string | number | null;
}

export interface PendingDSDCandidate {
  eventType: 'UTILITY_ON' | 'UTILITY_OFF';
  tentativeDSD: number;        // minutes
  createdAtIso: string;
  reportedAtIso: string;
}

const PENDING_DSD_KEY = 'pending_dsd_candidate_v2';

export function useUserOffset() {
  const { user } = useAuth();
  const [offset, setOffset] = useState<UserOffset | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);

  // Load offset from DB on mount
  const fetchOffset = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    try {
      const { data, error } = await supabase
        .from('user_offsets')
        .select('offset_minutes, last_event_type, last_event_at, updated_at, offset_state, offset_value')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error('[useUserOffset] fetch error:', error.message);
      } else {
        setOffset(data ?? { offset_minutes: 0, last_event_type: null, last_event_at: null, updated_at: new Date().toISOString(), offset_state: null, offset_value: null });
      }
    } catch (e) {
      console.error('[useUserOffset] unexpected error:', e);
    }
    setLoading(false);
  }, [user]);

  useEffect(() => { fetchOffset(); }, [fetchOffset]);

  // Load pending DSD from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PENDING_DSD_KEY);
        if (raw) setPendingDSD(JSON.parse(raw));
      } catch (_) {}
    })();
  }, []);

  // Save user offset to DB
  const saveOffset = useCallback(async (offsetMinutes: number): Promise<boolean> => {
    if (!user) return false;
    try {
      const { error } = await supabase
        .from('user_offsets')
        .upsert(
          {
            user_id: user.id,
            offset_minutes: offsetMinutes,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id' },
        );
      if (error) {
        console.error('[useUserOffset] saveOffset error:', error.message);
        return false;
      }
      // Update local state immediately
      setOffset(prev => prev
        ? { ...prev, offset_minutes: offsetMinutes, updated_at: new Date().toISOString() }
        : { offset_minutes: offsetMinutes, last_event_type: null, last_event_at: null, updated_at: new Date().toISOString(), offset_state: null, offset_value: null }
      );
      return true;
    } catch (e) {
      console.error('[useUserOffset] saveOffset unexpected error:', e);
      return false;
    }
  }, [user]);

  // Clear pending DSD
  const clearPendingDSD = useCallback(async () => {
    setPendingDSD(null);
    try {
      await AsyncStorage.removeItem(PENDING_DSD_KEY);
    } catch (_) {}
  }, []);

  // Set pending DSD candidate
  const setPendingDSDCandidate = useCallback(async (candidate: PendingDSDCandidate) => {
    setPendingDSD(candidate);
    try {
      await AsyncStorage.setItem(PENDING_DSD_KEY, JSON.stringify(candidate));
    } catch (_) {}
  }, []);

  return {
    offset,
    loading,
    pendingDSD,
    clearPendingDSD,
    setPendingDSDCandidate,
    saveOffset,
    refresh: fetchOffset,
  };
}
