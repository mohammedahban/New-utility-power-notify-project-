
/**
 * useUserPredictions — Production hook that feeds the User Home Screen.
 *
 * Architecture:
 *   usePredictions (raw Supabase) → applyOffsetToPrediction (tmmsEngine) → UserPrediction
 *
 * The engine lives in app/(admin)/tmmsEngine.ts and is intentionally shared
 * between the production hook (here) and the admin TMMS Debug Simulator,
 * ensuring both always run the same TMMS V2 logic.
 */
import { useState, useEffect, useMemo } from 'react';
import { usePredictions } from './usePredictions';
import {
  applyOffsetToPrediction as _applyOffsetToPrediction,
  type UserPrediction as _EngineUserPrediction,
  type ResyncPoint,
  type TransitionMode,
} from '../app/(admin)/tmmsEngine';

// ── Public type re-exports ─────────────────────────────────────────────────

export type { ResyncPoint, TransitionMode } from '../app/(admin)/tmmsEngine';

/**
 * The six displayable ATC operational modes.
 * POSITIVE_OFFSET_PENDING is part of the internal ATC state machine
 * (ATCState.mode in the engine) but not exported here to keep the public
 * API consistent with the admin predictions screen's Record<ScheduleStateMode>.
 */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE';

/**
 * Augmented UserPrediction — the engine's UserPrediction extended with
 * convenience fields that the Home Screen consumes directly (not via apppe.*).
 */
export type UserPrediction = _EngineUserPrediction & {
  /** The offset that was applied (mirrors the offsetMinutes parameter). */
  offsetMinutes: number;
  /** Shorthand for apppe.crisisActive — drives the crisis banner. */
  crisisMode: boolean;
  /** Shorthand for apppe.crisisReason — displayed in the crisis banner. */
  crisisReason: string | null;
  /** Human-readable ON duration label derived from expectedOnRange. */
  expectedOnDurationLabel: string | null;
  /** Human-readable OFF duration label derived from expectedOffRange. */
  expectedOffDurationLabel: string | null;
};

export interface CommunitySyncMeta {
  syncedAtIso: string | null;
  reporterName: string | null;
  reporterReliability: number | null;
}

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

/**
 * Re-export applyOffsetToPrediction for admin tools (predictions.tsx uses it
 * to run per-offset simulations on the raw server prediction).
 */
export const applyOffsetToPrediction = _applyOffsetToPrediction;

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * useUserPredictions
 *
 * Fetches the latest raw prediction from Supabase (real-time), applies the
 * user's ATC offset via the TMMS V2 engine, and returns a fully-resolved
 * UserPrediction every 30 seconds (for ATC mode re-derivation) or whenever
 * the underlying prediction / offset / resync changes.
 *
 * @param offsetMinutes          Stored user offset in minutes.
 * @param resyncPoint            Active community resync point, or null.
 * @param transitionMode         'AUTO' | 'MANUAL' — current TMMS mode.
 * @param anchorStartIso         Anchor start ISO (held-cycle start for ATC).
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // 30-second heartbeat — forces ATC mode re-derivation as time advances
  // without waiting for a new Supabase push. Kept in state so the memo
  // dependency array picks it up correctly.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const userPrediction = useMemo((): UserPrediction | null => {
    if (!prediction) return null;
    try {
      // Build the communitySyncMeta display object from the resync point so
      // PersonalStatusCard can show reporter name + reliability badge.
      const syncMeta: CommunitySyncMeta | null = resyncPoint
        ? {
            syncedAtIso: resyncPoint.syncedAtIso,
            reporterName: resyncPoint.reporterName ?? null,
            reporterReliability: resyncPoint.reporterReliability ?? null,
          }
        : null;

      const base = _applyOffsetToPrediction(
        prediction as any,   // Prediction from usePredictions is structurally compatible
        offsetMinutes,
        resyncPoint,
        syncMeta,            // communitySyncMeta (display data for PersonalStatusCard)
        transitionMode,
        anchorStartIso,      // heldCycleStartIso
        null,                // frozenCommunityOffsetMinutes (managed by ResyncContext)
        undefined,           // onOffsetCalculated callback (not needed in production)
        Date.now(),          // nowMs — fresh on every tick
        undefined,
      );

      // Attach the convenience fields the Home Screen uses directly
      return {
        ...base,
        offsetMinutes,
        crisisMode: prediction.apppe?.crisisActive ?? false,
        crisisReason: prediction.apppe?.crisisReason ?? null,
        expectedOnDurationLabel: prediction.expectedOnRange?.label ?? null,
        expectedOffDurationLabel: prediction.expectedOffRange?.label ?? null,
      } as UserPrediction;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  // The eslint-disable-next-line comment is a configuration instruction, not a syntax error.
  // Since the core responsibility is to fix syntax errors, this comment should be preserved
  // as it is not a syntax error itself. If the linter rule "react-hooks/exhaustive-deps"
  // were actually missing or misconfigured, that would be an environment/configuration issue
  // rather than a TypeScript syntax error in the code itself.
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick]);

  return { userPrediction, loading };
}
