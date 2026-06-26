
/**
 * useUserPredictions
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin React wrapper around the TMMS V2 engine's applyOffsetToPrediction
 * pipeline.  Fetches raw predictions via usePredictions, applies the user's
 * offset / resync point, and re-runs every 30 seconds so the ATC state stays
 * current without requiring a server round-trip.
 *
 * Exports (consumed by app/(user)/index.tsx and app/(admin)/predictions.tsx):
 *   - useUserPredictions   — hook
 *   - UserPrediction       — extended prediction type with convenience fields
 *   - ScheduleStateMode    — union of the 6 ATC modes shown in the admin UI
 *   - applyOffsetToPrediction — re-exported from the engine for direct use
 */

import { useState, useEffect, useMemo } from 'react';
import { usePredictions } from './usePredictions';
import {
  applyOffsetToPrediction as engineApply,
  type Prediction,
  type ResyncPoint,
  type UserPrediction as EngineUserPrediction,
  type TransitionMode,
} from '../app/(admin)/tmmsEngine';

// ── Re-export the engine function so consumers don't need a direct dep on tmmsEngine ──
export { applyOffsetToPrediction } from '../app/(admin)/tmmsEngine';

// ── ScheduleStateMode ─────────────────────────────────────────────────────────
// The 6 modes rendered by the admin ATCSystemIndicator.  POSITIVE_OFFSET_PENDING
// lives on ATCState.mode in the engine but is intentionally omitted here because
// predictions.tsx's modeColors/modeIcons records only define these 6 keys.
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE';

// ── Extended UserPrediction ───────────────────────────────────────────────────
// Adds convenience fields that the Home screen reads directly from the hook
// result instead of digging into nested prediction structures.
export interface UserPrediction extends EngineUserPrediction {
  /** Mirror of apppe.crisisActive — avoids optional-chaining at every call-site */
  crisisMode: boolean;
  /** Mirror of apppe.crisisReason */
  crisisReason: string | null;
  /** The user's effective offset minutes (after community transition derivation) */
  offsetMinutes: number;
  /** Human-readable expected ON duration label (e.g. "2س 30د") */
  expectedOnDurationLabel: string | null;
  /** Human-readable expected OFF duration label */
  expectedOffDurationLabel: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDurationLabel(minMin: number | undefined, maxMin: number | undefined): string | null {
  if (minMin == null || maxMin == null) return null;
  const mid = Math.round((minMin + maxMin) / 2);
  if (mid <= 0) return null;
  const h = Math.floor(mid / 60);
  const m = mid % 60;
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null | undefined,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso: string | null = null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // Tick every 30 seconds so ATC state (zone transitions, countdowns) stays live
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const userPrediction = useMemo<UserPrediction | null>(() => {
    if (!prediction) return null;

    try {
      const base = engineApply(
        prediction as Prediction,
        offsetMinutes,
        resyncPoint ?? null,
        null,                       // communitySyncMeta — populated by ResyncContext, not here
        transitionMode,
        heldCycleStartIso ?? null,
        null,                       // frozenCommunityOffsetMinutes — managed by ResyncContext
        undefined,                  // onOffsetCalculated callback
        Date.now(),
      );

      // Derive effective offset from community transition if one was generated
      const effectiveOffset = base.communityTransitionMeta
        ? base.communityTransitionMeta.offsetMinutes
        : offsetMinutes;

      const extended: UserPrediction = {
        ...base,
        crisisMode: prediction.apppe?.crisisActive ?? false,
        crisisReason: prediction.apppe?.crisisReason ?? null,
        offsetMinutes: effectiveOffset,
        expectedOnDurationLabel: fmtDurationLabel(
          prediction.expectedOnRange?.minMin,
          prediction.expectedOnRange?.maxMin,
        ),
        expectedOffDurationLabel: fmtDurationLabel(
          prediction.expectedOffRange?.minMin,
          prediction.expectedOffRange?.maxMin,
        ),
      };

      return extended;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, heldCycleStartIso, tick]);

  return { userPrediction, loading };
}
