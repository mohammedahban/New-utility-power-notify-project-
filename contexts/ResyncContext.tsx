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
 */

import React, {
  createContext, useCallback, useContext, useEffect, useState,
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
   *
   * This is the ABSOLUTE wall-clock time — it is used to compute the
   * delta against whichever master slot matches, so it remains valid
   * even when the master prediction is refreshed by Growatt updates.
   * Community priority > Growatt is enforced by reapplying this delta
   * on every master update.
   */
  syncedAtIso: string;
  /** When the resync was applied locally (for display / expiry) */
  appliedAtIso: string;
}

interface ResyncContextType {
  resyncPoint: ResyncPoint | null;
  applyResync: (point: ResyncPoint) => Promise<void>;
  clearResync: () => Promise<void>;
}

const ResyncContext = createContext<ResyncContextType | undefined>(undefined);

const STORAGE_KEY_PREFIX = 'community_resync_point_';

export function ResyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [resyncPoint, setResyncPoint] = useState<ResyncPoint | null>(null);

  // Key is per-user so switching accounts doesn't bleed state
  const storageKey = user ? `${STORAGE_KEY_PREFIX}${user.id}` : null;

  // Load persisted resync on user/mount
  useEffect(() => {
    if (!storageKey) { setResyncPoint(null); return; }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: ResyncPoint = JSON.parse(raw);
          // Auto-expire sync points older than 6 hours — after that the
          // normal prediction engine is far enough ahead that the resync
          // no longer helps alignment.
          const ageMs = Date.now() - new Date(parsed.appliedAtIso).getTime();
          if (ageMs < 6 * 60 * 60 * 1000) {
            setResyncPoint(parsed);
          } else {
            await AsyncStorage.removeItem(storageKey);
          }
        }
      } catch (_) {}
    })();
  }, [storageKey]);

  const applyResync = useCallback(async (point: ResyncPoint) => {
    setResyncPoint(point);
    if (!storageKey) return;
    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(point));
    } catch (_) {}
  }, [storageKey]);

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
