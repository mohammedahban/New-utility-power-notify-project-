/**
 * ResyncContext
 *
 * Stores a single "personal sync point" (personal timeline branch) per user.
 * When a community resync is applied (either by submitting a report or
 * confirming YES on a notification) the sync point is saved here AND in
 * AsyncStorage so it survives app restarts.
 *
 * The sync point tells useUserPredictions:
 *   "treat the schedule as if state <syncedState> started at <syncedAtIso>"
 *
 * Per spec §10 (Community Resynchronization V2):
 *   - The resync is a PERMANENT personal timeline branch, not a temporary override.
 *   - It does NOT auto-revert because Growatt changed.
 *   - It does NOT auto-clear when the validation window expires.
 *   - The ONLY way to clear a resync is the user pressing an explicit revert control.
 *
 * Safety net: auto-clears after 6 hours max age to prevent forever-stale data.
 * The ATC validation window still DISPLAYS a warning in the UI (via computeATCState)
 * but does not trigger a clear here.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from './AuthContext';

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

  // ── Max-age watchdog ────────────────────────────────────────────────────────
  // Per spec §10: community sync is a PERMANENT personal timeline branch.
  // It must NOT be cleared because Growatt disagrees or the validation window
  // expired. The ONLY programmatic clear allowed is the 6-hour safety-net to
  // prevent forever-stale data. The user must explicitly press a revert button
  // to leave the community-synced branch at any other time.
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
      // Safety-net only: clear after 6-hour max age
      if (ageMs >= MAX_AGE_MS) {
        console.log('[ResyncContext] 6-hour safety-net reached — clearing resync');
        await AsyncStorage.removeItem(storageKey!);
        setResyncPoint(null);
      }
      // NOTE: validation window expiry and Growatt mismatch do NOT clear the
      // resync here. The ATC layer shows a warning badge in the UI instead.
    };

    check();
    intervalRef.current = setInterval(check, 60_000); // check every minute

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
