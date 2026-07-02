/**
 * ResyncContext — TMMS V2.2 Community Resync State Management
 *
 * Provides a global ResyncPoint that represents the active community sync.
 * When a user accepts a community ON report (YES response), applyResync()
 * stores the full V2.2 state including Generated ON metadata and cloned
 * Offset State/Value/TimelineAlignment. clearResync() removes it.
 *
 * The ResyncPoint is persisted in AsyncStorage so it survives app restarts.
 *
 * V2.2 additions:
 *   - offsetState / offsetValue / timelineAlignment (cloned from reporter)
 *   - generatedOnStartIso / generatedOnDurationMin / generatedOnReferenceIso
 *     / generatedOnReferenceKind (Generated ON metadata)
 *   - confirmationTime (when the approver pressed YES)
 */

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ResyncPoint } from '../app/(admin)/tmmsEngine';

const STORAGE_KEY = 'tmms_resync_point_v22';

interface ResyncContextValue {
  /** Active community resync point, or null if none. */
  resyncPoint: ResyncPoint | null;
  /**
   * Apply a new community resync. Persists the full V2.2 ResyncPoint
   * to AsyncStorage so it survives app restarts.
   */
  applyResync: (point: ResyncPoint) => Promise<void>;
  /**
   * Clear the active resync point (user pressed "العودة إلى Growatt").
   * Also removes from AsyncStorage.
   */
  clearResync: () => Promise<void>;
}

const ResyncContext = createContext<ResyncContextValue | undefined>(undefined);

export function ResyncProvider({ children }: { children: ReactNode }) {
  const [resyncPoint, setResyncPoint] = useState<ResyncPoint | null>(null);

  // Load persisted resync point on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as ResyncPoint;
          setResyncPoint(parsed);
        } catch (_) {
          // Corrupt data — ignore
        }
      })
      .catch(() => {/* non-fatal */});
  }, []);

  const applyResync = useCallback(async (point: ResyncPoint) => {
    setResyncPoint(point);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(point));
    } catch (_) {/* non-fatal */}
  }, []);

  const clearResync = useCallback(async () => {
    setResyncPoint(null);
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch (_) {/* non-fatal */}
  }, []);

  return (
    <ResyncContext.Provider value={{ resyncPoint, applyResync, clearResync }}>
      {children}
    </ResyncContext.Provider>
  );
}

export function useResync(): ResyncContextValue {
  const ctx = useContext(ResyncContext);
  if (!ctx) throw new Error('useResync must be used within ResyncProvider');
  return ctx;
}
