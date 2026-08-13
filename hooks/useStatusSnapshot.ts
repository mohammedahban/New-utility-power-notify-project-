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
import { supabase } from '../lib/supabase';
import { serverNowMs } from '../lib/serverTime';
import { effectiveOffsetFromRow } from './useUserOffset';

const SNAPSHOT_KEY_PREFIX = 'status_snapshot_v2_';

/**
 * Read the user's CURRENT offset semantics + active resync point straight
 * from the source of truth (DB + AsyncStorage).
 *
 * Snapshot captures that rely on React hook state (`useUserOffset`,
 * `useResync`) race on a fresh app open: the auto-clone fires seconds after
 * launch, before those hooks finish loading, and would snapshot
 * offset=null → 0/NEUTRAL — the revert-to-neutral bug. Reading the row
 * directly removes the race.
 */
export async function readPreActionStateForSnapshot(userId: string): Promise<{
  offsetMinutes: number;
  offsetState: string | null;
  offsetValue: number | string | null;
  resyncPoint: ResyncPoint | null;
}> {
  let offsetMinutes = 0;
  let offsetState: string | null = null;
  let offsetValue: number | string | null = null;
  try {
    const { data } = await supabase
      .from('user_offsets')
      .select('offset_minutes, offset_state, offset_value')
      .eq('user_id', userId)
      .maybeSingle();
    if (data) {
      const eff = effectiveOffsetFromRow(data);
      offsetMinutes = eff.minutes;
      offsetState = eff.state;
      offsetValue = eff.value;
    }
  } catch (_) { /* fall back to zeros/nulls */ }

  let resyncPoint: ResyncPoint | null = null;
  try {
    const raw = await AsyncStorage.getItem(`community_resync_point_v2_${userId}`);
    if (raw) {
      const parsed: ResyncPoint = JSON.parse(raw);
      const ageMs = serverNowMs() - new Date(parsed.appliedAtIso).getTime();
      if (Number.isFinite(ageMs) && ageMs < 3 * 60 * 60 * 1000) resyncPoint = parsed;
    }
  } catch (_) { /* non-fatal */ }

  return { offsetMinutes, offsetState, offsetValue, resyncPoint };
}

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

// ── Cross-instance sync ─────────────────────────────────────────────────────
// useStatusSnapshot is mounted by several components at once (user layout,
// home screen, community screen), each holding its own React state over the
// SAME AsyncStorage key. The auto-clone captures from the LAYOUT instance —
// without this emitter the home screen's instance kept its stale mount-time
// state, so the revert button showed the wrong label and revert could fall
// back to the plain "clear resync" path (which left the cloned offset in
// place — the revert-to-neutral symptom). Every mutation notifies all
// mounted instances to re-read the stored snapshot.
const snapshotListeners = new Set<(key: string) => void>();
function emitSnapshotChanged(key: string) {
  snapshotListeners.forEach((l) => { try { l(key); } catch (_) {} });
}

export function useStatusSnapshot() {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<StatusSnapshot | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);

  const storageKey = user ? `${SNAPSHOT_KEY_PREFIX}${user.id}` : null;

  // ── Load persisted snapshot on mount / user change / cross-instance write ──
  useEffect(() => {
    if (!storageKey) {
      setSnapshot(null);
      setHasSnapshot(false);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const raw = await AsyncStorage.getItem(storageKey);
        if (cancelled) return;
        if (raw) {
          const parsed: StatusSnapshot = JSON.parse(raw);
          setSnapshot(parsed);
          setHasSnapshot(true);
        } else {
          setSnapshot(null);
          setHasSnapshot(false);
        }
      } catch (_) {}
    };
    load();
    const listener = (key: string) => { if (key === storageKey) load(); };
    snapshotListeners.add(listener);
    return () => {
      cancelled = true;
      snapshotListeners.delete(listener);
    };
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
        if (prev?.createdAt && serverNowMs() - new Date(prev.createdAt).getTime() < 15_000) {
          if (extra?.resyncHistoryRowId != null && prev.resyncHistoryRowId == null) {
            const merged: StatusSnapshot = { ...prev, resyncHistoryRowId: extra.resyncHistoryRowId };
            setSnapshot(merged);
            await AsyncStorage.setItem(storageKey, JSON.stringify(merged)).catch(() => {});
            emitSnapshotChanged(storageKey);
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
    emitSnapshotChanged(storageKey);
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
      AsyncStorage.setItem(storageKey, JSON.stringify(next))
        .catch(() => {})
        .finally(() => emitSnapshotChanged(storageKey));
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
    emitSnapshotChanged(storageKey);
  }, [storageKey]);

  return {
    snapshot,
    hasSnapshot,
    captureSnapshot,
    attachResyncHistoryRowId,
    clearSnapshot,
  };
}
