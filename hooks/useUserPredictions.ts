/**
 * useUserPredictions
 *
 * Applies the TMMS V2 ATC engine (from tmmsEngine.ts) on top of the raw
 * prediction fetched by usePredictions. Re-exports all types consumed by
 * the schedule, home, community, admin predictions, and nearby-users screens.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { usePredictions, Prediction } from './usePredictions';
import {
  applyOffsetToPrediction,
  UserPrediction,
  ATCState,
  ResyncPoint,
} from '../app/(admin)/tmmsEngine';
import { useTransitionMode } from './useTransitionMode';

// ── Re-exports consumed by multiple screens ───────────────────────────────────

export type { UserPrediction, ATCState, ResyncPoint } from '../app/(admin)/tmmsEngine';
export { applyOffsetToPrediction } from '../app/(admin)/tmmsEngine';

/**
 * ScheduleStateMode — the seven operational ATC modes.
 * Kept as a string union so components can compare without importing ATCState.
 */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

/**
 * ShiftedScheduleSlot — a schedule slot after offset + ATC processing.
 * Extends the raw ScheduleSlot with shifted time fields used by the UI.
 */
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

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * useUserPredictions
 *
 * @param offsetMinutes  User's DSD offset in minutes (negative = earlier,
 *                       positive = later, 0 = follow Growatt exactly).
 * @param resyncPoint    Community resync anchor applied by ResyncContext.
 * @param communitySyncMeta  Optional metadata passed through to the engine.
 * @param frozenCommunityOffsetMinutes  Frozen offset from a prior community
 *                       computation — avoids re-deriving on every render.
 */
export function useUserPredictions(
  offsetMinutes: number = 0,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: any,
  frozenCommunityOffsetMinutes?: number | null,
): {
  userPrediction: UserPrediction | null;
  loading: boolean;
  rawPrediction: Prediction | null;
} {
  const { prediction, loading } = usePredictions();
  const { mode: transitionMode } = useTransitionMode();

  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);
  const computeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const compute = useCallback(() => {
    if (!prediction) {
      setUserPrediction(null);
      return;
    }

    try {
      const result = applyOffsetToPrediction(
        prediction,
        offsetMinutes,
        resyncPoint ?? null,
        communitySyncMeta ?? null,
        transitionMode ?? 'AUTO',
        null,
        frozenCommunityOffsetMinutes ?? null,
        undefined,
        Date.now(),
      );
      setUserPrediction(result);
    } catch (err) {
      console.error('[useUserPredictions] compute error:', err);
    }
  }, [
    prediction,
    offsetMinutes,
    resyncPoint,
    communitySyncMeta,
    transitionMode,
    frozenCommunityOffsetMinutes,
  ]);

  // Recompute whenever inputs change
  useEffect(() => {
    compute();
  }, [compute]);

  // Recompute every 30 seconds so ATC mode, countdowns, and "الآن" markers
  // stay fresh without requiring user interaction.
  useEffect(() => {
    const interval = setInterval(() => {
      compute();
    }, 30_000);
    return () => clearInterval(interval);
  }, [compute]);

  return {
    userPrediction,
    loading,
    rawPrediction: prediction,
  };
}
