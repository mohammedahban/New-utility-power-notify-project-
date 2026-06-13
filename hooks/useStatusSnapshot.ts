/**
 * useStatusSnapshot — Pre-report / pre-community-sync state snapshot.
 *
 * Whenever the user:
 *   - Submits a personal utility report (Report ON / Report OFF)
 *   - Confirms a community resync (YES)
 *
 * the system must call `captureSnapshot()` BEFORE applying the new state.
 * This stores the complete state needed to fully undo the change.
 *
 * When the user presses "العودة إلى الحالة الأصلية":
 *   1. `restoreSnapshot()` returns the stored snapshot.
 *   2. Caller restores offset → clearResync (or re-applies previous resync).
 *   3. `clearSnapshot()` removes the stored snapshot.
 *
 * Storage: AsyncStorage per-user key `status_snapshot_v2_<userId>`.
 * One snapshot at a time — each new report/sync overwrites the previous one.
 */

import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../contexts/AuthContext';
import type { ResyncPoint } from '../contexts/ResyncContext';

const SNAPSHOT_KEY_PREFIX = 'status_snapshot_v2_';

export interface StatusSnapshot {
  /** Utility state BEFORE the report/sync was applied */
  previousState: 'ON' | 'OFF';
  /** ISO of when that state started (for elapsed timer restoration) */
  previousStateStartIso: string | null;
  /** Offset minutes BEFORE the report/sync */
  previousOffsetMinutes: number;
  /** Resync point BEFORE the report/sync (null if none was active) */
  previousResyncPoint: ResyncPoint | null;
  /** When the snapshot was created */
  createdAt: string;
  /** Human-readable context for debugging / display */
  trigger: 'user_report' | 'community_confirm';
}

export function useStatusSnapshot() {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);

  const storageKey = user ? `${SNAPSHOT_KEY_PREFIX}${user.id}` : null;

  // ── Load persisted snapshot on mount / user change ──────────────────────────
  useEffect(() => {
    if (!storageKey) {
      setSnapshot(null);
      setHasSnapshot(false);
      return;
    }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (raw) {
          const parsed: StatusSnapshot = JSON.parse(raw);
          setSnapshot(parsed);
          setHasSnapshot(true);
        } else {
          setSnapshot(null);
          setHasSnapshot(false);
        }
      } catch (_) {}
    })();
  }, [storageKey]);

  /**
   * captureSnapshot — call this BEFORE applying a report or community sync.
   *
   * @param currentState        Current utility state (ON/OFF)
   * @param currentStateStartIso ISO when the current state started
   * @param currentOffsetMinutes Current DSD offset
   * @param currentResyncPoint   Active resync point (null if none)
   * @param trigger              What event triggered the snapshot
   */
  const captureSnapshot = useCallback(async (
    currentState: 'ON' | 'OFF',
    currentStateStartIso: string | null,
    currentOffsetMinutes: number,
    currentResyncPoint: ResyncPoint | null,
    trigger: 'user_report' | 'community_confirm',
  ): Promise<void> => {
    if (!storageKey) return;

    const snap: StatusSnapshot = {
      previousState: currentState,
      previousStateStartIso: currentStateStartIso,
      previousOffsetMinutes: currentOffsetMinutes,
      previousResyncPoint: currentResyncPoint,
      createdAt: new Date().toISOString(),
      trigger,
    };

    setSnapshot(snap);
    setHasSnapshot(true);

    try {
      await AsyncStorage.setItem(storageKey, JSON.stringify(snap));
    } catch (_) {}
  }, [storageKey]);

  /**
   * clearSnapshot — call after restoration completes so the button disappears.
   */
  const clearSnapshot = useCallback(async (): Promise<void> => {
    setSnapshot(null);
    setHasSnapshot(false);
    if (!storageKey) return;
    try {
      await AsyncStorage.removeItem(storageKey);
    } catch (_) {}
  }, [storageKey]);

  return {
    snapshot,
    hasSnapshot,
    captureSnapshot,
    clearSnapshot,
  };
}
