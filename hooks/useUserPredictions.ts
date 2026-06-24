/**
 * hooks/useUserPredictions.ts
 *
 * Re-exports the core engine types/functions and wraps the raw APPPE prediction
 * in the full ATC pipeline so every consumer gets a ready-to-render UserPrediction.
 *
 * Imports from the shared engine (app/(admin)/tmmsEngine.ts) — the same code that
 * drives the admin TMMS simulator, ensuring production and debug paths are identical.
 */

import { useState, useEffect, useMemo } from 'react';
import { usePredictions } from './usePredictions';
import {
  applyOffsetToPrediction as engineApplyOffset,
  type UserPrediction as EngineUserPrediction,
  type ATCState,
  type CommunityTransitionMeta,
  type ResyncPoint,
  type TransitionMode,
} from '../app/(admin)/tmmsEngine';

// Re-export engine helpers so admin/predictions.tsx can import from this file
export { applyOffsetToPrediction } from '../app/(admin)/tmmsEngine';
export type { ATCState, CommunityTransitionMeta, ResyncPoint, TransitionMode };

// ── ScheduleStateMode ─────────────────────────────────────────────────────────
// The six "displayable" ATC modes used by the admin predictions screen's
// modeColors record.  POSITIVE_OFFSET_PENDING is excluded — components that
// need it can check `atc.mode` as a plain string comparison.
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE';

// ── Community sync metadata (typed for Home screen banner) ───────────────────
export interface CommunitySyncMeta {
  syncedAtIso: string | null;
  reporterName: string | null;
  reporterReliability: number | null;
}

// ── UserPrediction — engine type + Home Screen convenience fields ─────────────
export interface UserPrediction extends EngineUserPrediction {
  /** Convenience alias for apppe.crisisActive */
  crisisMode?: boolean;
  /** Convenience alias for apppe.crisisReason */
  crisisReason?: string | null;
  /** The user's own offset in minutes, carried through for display */
  offsetMinutes?: number;
  /** Human-readable ON duration derived from expectedOnRange */
  expectedOnDurationLabel?: string | null;
  /** Human-readable OFF duration derived from expectedOffRange */
  expectedOffDurationLabel?: string | null;
  /** Typed community sync metadata override (narrows the engine's `any`) */
  communitySyncMeta: CommunitySyncMeta | null;
}

// ── Duration label helper ─────────────────────────────────────────────────────
function fmtDurationRange(minMin: number, maxMin: number): string {
  const fmt = (min: number) => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h === 0) return `${m}د`;
    if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
    return `${h}س ${m}د`;
  };
  if (minMin === maxMin) return fmt(minMin);
  return `${fmt(minMin)} – ${fmt(maxMin)}`;
}

// ── useUserPredictions hook ──────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // Tick every 30 seconds so countdowns + ATC mode transitions refresh
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const userPrediction = useMemo<UserPrediction | null>(() => {
    if (!prediction) return null;

    // Build typed community sync meta from the resync point
    const communitySyncMeta: CommunitySyncMeta | null = resyncPoint
      ? {
          syncedAtIso: resyncPoint.syncedAtIso,
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
        }
      : null;

    let result: EngineUserPrediction;
    try {
      result = engineApplyOffset(
        prediction,
        offsetMinutes,
        resyncPoint,
        communitySyncMeta,
        transitionMode,
        anchorStartIso,
        null,       // frozenCommunityOffsetMinutes — managed by ResyncContext
        undefined,
        Date.now(),
        undefined,
      );
    } catch {
      return null;
    }

    // Attach convenience fields consumed directly by the Home Screen
    return {
      ...(result as unknown as UserPrediction),
      communitySyncMeta,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      offsetMinutes,
      expectedOnDurationLabel: prediction.expectedOnRange
        ? fmtDurationRange(prediction.expectedOnRange.minMin, prediction.expectedOnRange.maxMin)
        : null,
      expectedOffDurationLabel: prediction.expectedOffRange
        ? fmtDurationRange(prediction.expectedOffRange.minMin, prediction.expectedOffRange.maxMin)
        : null,
    } as UserPrediction;

    // tick forces re-evaluation every 30s for ATC zone transitions
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick]);

  return { userPrediction, loading };
}
