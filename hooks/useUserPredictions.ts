/**
 * useUserPredictions
 *
 * Applies user offset + community resync + ATC state machine to the raw
 * admin prediction, producing a personalised UserPrediction for the UI.
 *
 * Also re-exports the types and helpers consumed by the admin predictions
 * page and nearby-users hook so they don't need to import directly from
 * tmmsEngine.ts.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { ResyncPoint } from '../contexts/ResyncContext';
import type { TransitionMode } from './useTransitionMode';
import {
  applyOffsetToPrediction as _applyOffsetToPrediction,
  UserPrediction,
} from '../app/(admin)/tmmsEngine';
import type { Prediction as AdminPrediction } from './usePredictions';

// ── Re-exports ────────────────────────────────────────────────────────────────

export { applyOffsetToPrediction } from '../app/(admin)/tmmsEngine';
export type { UserPrediction } from '../app/(admin)/tmmsEngine';

/** The seven ATC controller modes. */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/** A schedule slot after offset/resync transformation (used by schedule.tsx). */
export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced?: boolean;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Fetches the latest prediction from `utility_predictions` (id=1), applies
 * the user's offset + community resync + ATC state machine, and returns the
 * personalised result.
 *
 * @param offsetMinutes   User's DSD offset (from useUserOffset)
 * @param resyncPoint     Active community sync point (from ResyncContext) or null
 * @param transitionMode  AUTO | MANUAL (from useTransitionMode) — optional
 * @param heldCycleStartIso  Anchor start ISO for held state — optional
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso: string | null = null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const [rawPrediction, setRawPrediction] = useState<AdminPrediction | null>(null);
  const [loading, setLoading] = useState(true);

  // Keep a ref to latest resync so the real-time subscription callback
  // can always access the current value without a stale closure.
  const offsetRef = useRef(offsetMinutes);
  const resyncRef = useRef(resyncPoint);
  const modeRef = useRef(transitionMode);
  const heldRef = useRef(heldCycleStartIso);

  useEffect(() => { offsetRef.current = offsetMinutes; }, [offsetMinutes]);
  useEffect(() => { resyncRef.current = resyncPoint; }, [resyncPoint]);
  useEffect(() => { modeRef.current = transitionMode; }, [transitionMode]);
  useEffect(() => { heldRef.current = heldCycleStartIso; }, [heldCycleStartIso]);

  const fetchPrediction = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('utility_predictions')
        .select('prediction, computed_at')
        .eq('id', 1)
        .maybeSingle();

      if (error) {
        console.error('[useUserPredictions] fetch error:', error.message);
      } else if (data?.prediction) {
        setRawPrediction(data.prediction as AdminPrediction);
      }
    } catch (e) {
      console.error('[useUserPredictions] exception:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPrediction();

    const channelName = `user_predictions_${Math.random().toString(36).slice(2)}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'utility_predictions' },
        (payload) => {
          const row = payload.new as any;
          if (row?.prediction) {
            setRawPrediction(row.prediction as AdminPrediction);
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchPrediction]);

  // Derive userPrediction synchronously from raw prediction + offset/resync.
  // Re-computed whenever any dependency changes.
  const userPrediction: UserPrediction | null = (() => {
    if (!rawPrediction) return null;

    const syncMeta = resyncPoint
      ? {
          syncedAtIso: resyncPoint.syncedAtIso,
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
        }
      : null;

    try {
      return _applyOffsetToPrediction(
        rawPrediction as any,
        offsetMinutes,
        resyncPoint ?? null,
        syncMeta,
        transitionMode,
        heldCycleStartIso ?? null,
        null, // frozenCommunityOffsetMinutes
        undefined, // onOffsetCalculated
        Date.now(),
      );
    } catch (e) {
      console.error('[useUserPredictions] applyOffsetToPrediction error:', e);
      return null;
    }
  })();

  return { userPrediction, loading };
}
