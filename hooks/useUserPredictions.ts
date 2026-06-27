/**
 * useUserPredictions — user-facing prediction hook
 *
 * Wraps the raw APPPE prediction with the TMMS ATC engine:
 *   1. Fetches raw prediction via usePredictions()
 *   2. Applies user offset + resync point via applyOffsetToPrediction()
 *   3. Returns a fully-computed UserPrediction with ATC state machine output
 *
 * Re-exports types from tmmsEngine.ts for consuming screens.
 */

import { useMemo } from 'react';
import { usePredictions } from './usePredictions';
import { useTransitionMode } from './useTransitionMode';
import {
  applyOffsetToPrediction,
  UserPrediction,
  ATCState,
  ScheduleSlot,
  ResyncPoint,
} from '../app/(admin)/tmmsEngine';

// ── Type re-exports ───────────────────────────────────────────────────────────

export type { UserPrediction } from '../app/(admin)/tmmsEngine';
export { applyOffsetToPrediction } from '../app/(admin)/tmmsEngine';

/** ATC controller mode — subset of ATCState['mode'] exposed to screens. */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/**
 * A schedule slot as seen by user-facing screens after offset + ATC processing.
 * Extends the base ScheduleSlot with shifted time strings and resync flag.
 */
export interface ShiftedScheduleSlot extends ScheduleSlot {
  isResynced: boolean;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string | null;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

/**
 * Returns the ATC-processed user prediction for the given offset and optional
 * resync point.
 *
 * @param offsetMinutes   User's personal time offset in minutes (positive / negative / 0)
 * @param resyncPoint     Optional community resync anchor (from ResyncContext)
 * @param communitySyncMeta  Optional metadata from community sync operation
 * @param frozenCommunityOffsetMinutes  Frozen offset from a prior community computation
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: any,
  frozenCommunityOffsetMinutes?: number | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const { mode: transitionMode } = useTransitionMode();

  const userPrediction = useMemo(() => {
    if (!prediction) return null;
    return applyOffsetToPrediction(
      prediction as any,
      offsetMinutes,
      resyncPoint ?? null,
      communitySyncMeta ?? null,
      transitionMode,
      null,
      frozenCommunityOffsetMinutes ?? null,
      undefined,
      Date.now(),
    );
  }, [prediction, offsetMinutes, resyncPoint, communitySyncMeta, transitionMode, frozenCommunityOffsetMinutes]);

  return { userPrediction, loading };
}
