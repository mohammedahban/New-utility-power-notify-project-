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
  /**
   * F-18: full V2.1 offset semantics BEFORE the report/sync.
   * `offset_minutes` alone cannot represent NEUTRAL-with-value or
   * PENDING_NEGATIVE — restoring only the number loses the state machine.
   */
  previousOffsetState?: string | null;
  previousOffsetValue?: string | number | null;
  /**
   * F-17: id of the resync_history row created BY the action that followed
   * this snapshot (self-report row or cloned community row). Revert marks
   * exactly this row as reverted instead of blindly marking the LATEST row.
   */
  resyncHistoryRowId?: number | null;
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
    // F-17/F-18: optional extras — full offset semantics + the id of the
    // resync_history row the subsequent action creates. Optional so existing
    // call sites keep compiling; revert falls back to legacy behavior when
    // they are absent.
    extra?: {
      offsetState?: string | null;
      offsetValue?: string | number | null;
      resyncHistoryRowId?: number | null;
    },
  ): Promise<void> => {
    if (!storageKey) return;

    // Race guard (ISSUE-FIX revert-to-neutral): some paths capture
    // explicitly BEFORE the mutation and then applyResync's registered
    // snapshot callback fires AFTER the mutation (respond()/submitReport()
    // already wrote user_offsets — and the F-05 realtime subscription can
    // deliver that write before the callback runs). A second capture would
    // then snapshot the POST-mutation offset, so "revert" restored the
    // cloned/pending values (NEUTRAL 0) instead of the pre-action state.
    // If a fresh snapshot (< 15 s old) already exists, keep it — it holds
    // the true pre-action state — and only carry over a newly-known
    // resyncHistoryRowId.
    try {
      const raw = await AsyncStorage.getItem(storageKey);
      if (raw) {
        const prev: StatusSnapshot = JSON.parse(raw);
        if (prev?.createdAt && Date.now() - new Date(prev.createdAt).getTime() < 15_000) {
          if (extra?.resyncHistoryRowId != null && prev.resyncHistoryRowId == null) {
            const merged: StatusSnapshot = { ...prev, resyncHistoryRowId: extra.resyncHistoryRowId };
            setSnapshot(merged);
            await AsyncStorage.setItem(storageKey, JSON.stringify(merged)).catch(() => {});
          }
          return;
        }
      }
    } catch (_) {}

    const snap: StatusSnapshot = {
      previousState: currentState,
      previousStateStartIso: currentStateStartIso,
      previousOffsetMinutes: currentOffsetMinutes,
      previousResyncPoint: currentResyncPoint,
      previousOffsetState: extra?.offsetState ?? null,
      previousOffsetValue: extra?.offsetValue ?? null,
      resyncHistoryRowId: extra?.resyncHistoryRowId ?? null,
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
   * F-17: the resync_history row is inserted AFTER the snapshot is captured
   * (capture must happen before applying state). Call this once the insert
   * returns its id so revert can target exactly that row.
   */
  const attachResyncHistoryRowId = useCallback(async (rowId: number | null): Promise<void> => {
    if (!storageKey || rowId == null) return;
    setSnapshot(prev => {
      if (!prev) return prev;
      const next: StatusSnapshot = { ...prev, resyncHistoryRowId: rowId };
      AsyncStorage.setItem(storageKey, JSON.stringify(next)).catch(() => {});
      return next;
    });
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
    attachResyncHistoryRowId,
    clearSnapshot,
  };
}
