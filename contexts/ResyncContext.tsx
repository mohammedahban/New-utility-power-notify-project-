/**
 * ResyncContext
 *
 * Stores a single "personal sync point" per user.
 * When a community resync is applied (either by submitting a report or
 * confirming YES on a notification) the sync point is saved here AND in
 * AsyncStorage so it survives app restarts.
 *
 * The sync point tells useUserPredictions:
 *   "treat the schedule as if state <syncedState> started at <syncedAtIso>"
 *
 * It does NOT modify the master prediction, offset, Growatt data, or any
 * other user's data.
 *
 * Auto-clears when:
 *   1. Age > 6 hours (original expiry)
 *   2. Validation window (20 min) expires AND Growatt state differs from
 *      syncedState — prevents stale community sync persisting indefinitely
 *      after Growatt has already confirmed a different state.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';
import { supabase } from '../lib/supabase';

export interface ResyncPoint {
  /** The utility state that was confirmed as active */
  syncedState: 'ON' | 'OFF';
  /**
   * The ISO timestamp at which this state effectively became active.
   * For reporter: now - selectedTimeOffsetMinutes
   * For recipient: now - (selectedTimeOffsetMinutes + responseDelayMinutes)
   */
  syncedAtIso: string;
  /** When the resync was applied locally (for display / expiry) */
  appliedAtIso: string;
  /** Reporter display name — shown in PersonalStatusCard community banner */
  reporterName?: string | null;
  /** Reporter reliability score (0–100) */
  reporterReliability?: number | null;
}

interface ResyncContextType {
  resyncPoint: ResyncPoint | null;
  applyResync: (point: ResyncPoint) => Promise<void>;
  clearResync: () => Promise<void>;
}

const ResyncContext = createContext<ResyncContextType | undefined>(undefined);

const STORAGE_KEY_PREFIX = 'community_resync_point_v2_';
const VALIDATION_WINDOW_MS = 20 * 60 * 1000;   // 20 minutes
const MAX_AGE_MS          = 6 * 60 * 60 * 1000; // 6 hours

export function ResyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [resyncPoint, setResyncPoint] = useState<ResyncPoint | null>(null);

  // Key is per-user so switching accounts doesn't bleed state
  const storageKey = user ? `${STORAGE_KEY_PREFIX}${user.id}` : null;

  // ── Load persisted resync on user/mount ─────────────────────────────────────
  useEffect(() => {
    if (!storageKey) { setResyncPoint(null); return; }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: ResyncPoint = JSON.parse(raw);
          const ageMs = Date.now() - new Date(parsed.appliedAtIso).getTime();
          if (ageMs < MAX_AGE_MS) {
            setResyncPoint(parsed);
          } else {
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch (_) {}
    })();
  }, [storageKey]);

  // ── Validation-window watchdog ───────────────────────────────────────────────
  // Every 30 seconds while a resync is active, check:
  //   1. Has the 6-hour max age been reached?
  //   2. Has the 20-minute validation window expired AND does Growatt now
  //      report a different state than what was synced?
  // If either condition is true, clear the resync automatically.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (!resyncPoint || !storageKey) return;

    const check = async () => {
      if (!resyncPoint) return;

      const ageMs = Date.now() - new Date(resyncPoint.appliedAtIso).getTime();

      // 1. Max age exceeded
      if (ageMs >= MAX_AGE_MS) {
        await AsyncStorage.removeItem(storageKey);
        setResyncPoint(null);
        return;
      }

      // 2. Validation window expired — check Growatt state
      if (ageMs >= VALIDATION_WINDOW_MS) {
        try {
          const { data } = await supabase
            .from('inverter_state')
            .select('utility_on, inverter_offline')
            .eq('id', 1)
            .maybeSingle();

          if (data && !data.inverter_offline) {
            const growattIsOn: boolean = data.utility_on ?? false;
            const syncedIsOn = resyncPoint.syncedState === 'ON';

            if (growattIsOn !== syncedIsOn) {
              // Growatt has confirmed a different state and the validation
              // window has expired — ATC takes over, community sync is done.
              console.log('[ResyncContext] Validation window expired, Growatt differs — clearing resync');
              await AsyncStorage.removeItem(storageKey);
              setResyncPoint(null);
            }
          }
        } catch (_) {
          // Network error — keep resync, try again next interval
        }
      }
    };

    // Run once immediately, then every 30 seconds
    check();
    intervalRef.current = setInterval(check, 30_000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [resyncPoint, storageKey]);

  // ── applyResync ──────────────────────────────────────────────────────────────
  const applyResync = useCallback(async (point: ResyncPoint) => {
    setResyncPoint(point);
    if (!storageKey) return;
    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(point));
    } catch (_) {}
  }, [storageKey]);

  // ── clearResync ──────────────────────────────────────────────────────────────
  const clearResync = useCallback(async () => {
    setResyncPoint(null);
    if (!storageKey) return;
    try {
      await AsyncStorage.removeItem(storageKey);
    } catch (_) {}
  }, [storageKey]);

  return (
    <ResyncContext.Provider value={{ resyncPoint, applyResync, clearResync }}>
      {children}
    </ResyncContext.Provider>
  );
}

export function useResync() {
  const ctx = useContext(ResyncContext);
  if (!ctx) throw new Error('useResync must be used within ResyncProvider');
  return ctx;
}
