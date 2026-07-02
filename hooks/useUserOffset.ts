/**
 * useUserOffset — manages the user's personal schedule offset (DSD calibration)
 *
 * Responsibilities:
 *  - Fetch and persist the user's offset_minutes from/to user_offsets table
 *  - Track PendingDSD candidates (awaiting Growatt confirmation)
 *  - Expose saveOffset() for manual and community-derived offset writes
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

const PENDING_DSD_KEY = 'pending_dsd_candidate';

export interface PendingDSDCandidate {
  eventType: 'UTILITY_ON' | 'UTILITY_OFF';
  tentativeDSD: number;   // tentative offset in minutes
  createdAtIso: string;
}

export interface UserOffsetRow {
  id: number;
  user_id: string;
  offset_minutes: number;
  last_event_type: string | null;
  last_event_at: string | null;
  updated_at: string;
  offset_state: string | null;
  offset_value: string | null;
}

export function useUserOffset() {
  const { user } = useAuth();
  const [offset, setOffset] = useState<UserOffsetRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDSD, setPendingDSD] = useState<PendingDSDCandidate | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── Load persisted PendingDSD candidate ────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(PENDING_DSD_KEY);
        if (raw && mountedRef.current) {
          setPendingDSD(JSON.parse(raw));
        }
      } catch (_) {}
    })();
  }, []);

  // ── Fetch offset from DB ───────────────────────────────────────────────────
  const fetchOffset = useCallback(async () => {
    if (!user) { setLoading(false); return; }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_offsets')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) {
        console.warn('[useUserOffset] fetch error:', error.message);
      }
      if (mountedRef.current) {
        setOffset(data ?? null);
      }
    } catch (e) {
      console.warn('[useUserOffset] unexpected error:', e);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [user]);

  useEffect(() => { fetchOffset(); }, [fetchOffset]);

  // ── Save / upsert offset ───────────────────────────────────────────────────
  const saveOffset = useCallback(async (offsetMinutes: number) => {
    if (!user) return;
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
        console.warn('[useUserOffset] save error:', error.message);
        return;
      }
      if (mountedRef.current) {
        setOffset(prev => prev
          ? { ...prev, offset_minutes: offsetMinutes }
          : {
              id: 0,
              user_id: user.id,
              offset_minutes: offsetMinutes,
              last_event_type: null,
              last_event_at: null,
              updated_at: new Date().toISOString(),
              offset_state: null,
              offset_value: null,
            });
      }
    } catch (e) {
      console.warn('[useUserOffset] saveOffset unexpected error:', e);
    }
  }, [user]);

  // ── Pending DSD helpers ────────────────────────────────────────────────────
  const setPendingDSDCandidate = useCallback(async (candidate: PendingDSDCandidate) => {
    try {
      await AsyncStorage.setItem(PENDING_DSD_KEY, JSON.stringify(candidate));
      if (mountedRef.current) setPendingDSD(candidate);
    } catch (_) {}
  }, []);

  const clearPendingDSD = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(PENDING_DSD_KEY);
      if (mountedRef.current) setPendingDSD(null);
    } catch (_) {}
  }, []);

  return {
    offset,
    loading,
    pendingDSD,
    setPendingDSDCandidate,
    clearPendingDSD,
    saveOffset,
    refresh: fetchOffset,
  };
}
