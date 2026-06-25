/**
 * useUserPredictions — Production hook that feeds the User Home Screen.
 *
 * Architecture:
 *   usePredictions (raw Supabase) → applyOffsetToPrediction (tmmsEngine) → UserPrediction
 *
 * The engine lives in app/(admin)/tmmsEngine.ts and is intentionally shared
 * between the production hook (here) and the admin TMMS Debug Simulator,
 * ensuring both always run the same TMMS V2 logic.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 * This hook is now a THIN INTEGRATION LAYER around the TMMS V2 engine.
 * No transition logic, offset calculation, schedule generation, or community
 * confirmation logic is duplicated here.  Every rule lives in the engine.
 *
 * Responsibilities of this hook (I/O only):
 *   1. Fetch raw prediction from Supabase (via usePredictions)
 *   2. Build the CommunitySyncMeta display object from the resync point
 *   3. Freeze the community offset after its first computation (Rule Q2-A)
 *   4. Persist accuracy events to Supabase (UNCERTAIN_ZONE / POSITIVE_OFFSET_PENDING exits)
 *   5. Re-derive the UserPrediction every 30 seconds (ATC mode refresh)
 *
 * Responsibilities REMOVED from this hook (now delegated to engine):
 *   - Schedule extension to 48h          → engine.extendScheduleTo48h
 *   - Offset application to slots        → engine.applyOffsetToSlots
 *   - Community offset calculation       → engine.computeCommunityOffset
 *   - Community transition computation   → engine.computeCommunityTransition
 *   - ATC state derivation               → engine.computeATCState
 *   - Current-state derivation           → engine.deriveCurrentStateATC
 *   - Next-transition derivation         → engine.deriveNextTransition
 *   - Lost-time reconciliation           → engine.computeReconciledCycleStart
 *   - Accuracy event math                → engine.computeAccuracyLogEvent
 *   - Full pipeline orchestration        → engine.applyOffsetToPrediction
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePredictions } from './usePredictions';
import { supabase } from '../lib/supabase';
import {
  applyOffsetToPrediction as _applyOffsetToPrediction,
  type UserPrediction as _EngineUserPrediction,
  type ResyncPoint,
  type TransitionMode,
  type CommunitySyncMeta as _EngineCommunitySyncMeta,
  type ShiftedScheduleSlot as _EngineShiftedScheduleSlot,
  type ScheduleStateMode as _EngineScheduleStateMode,
  type AccuracyLogEvent,
} from '../app/(admin)/tmmsEngine';

// ── Public type re-exports ─────────────────────────────────────────────────
// All types are re-exported DIRECTLY from the engine.  No local redeclarations
// — the engine is the single source of truth for all TMMS-related types.
export type { ResyncPoint, TransitionMode } from '../app/(admin)/tmmsEngine';

/**
 * The full set of ATC operational modes, re-exported from the engine.
 *
 * MIGRATION: The previous version of this file omitted POSITIVE_OFFSET_PENDING
 * from the exported ScheduleStateMode, which hid a real engine state from the
 * UI.  The engine CAN return POSITIVE_OFFSET_PENDING (User B path) and the UI
 * must be able to display it.  We now re-export the engine's complete type.
 */
export type ScheduleStateMode = _EngineScheduleStateMode;

/**
 * CommunitySyncMeta — re-exported from the engine.
 *
 * MIGRATION: The previous version redeclared this type locally, omitting the
 * `syncedState` field and making `syncedAtIso` nullable.  Both differences
 * were structural mismatches with the engine.  We now re-export the engine's
 * type directly.
 */
export type CommunitySyncMeta = _EngineCommunitySyncMeta;

/**
 * ShiftedScheduleSlot — re-exported from the engine.
 *
 * MIGRATION: The previous version redeclared this type locally, making
 * `shiftedStartFormatted` and `shiftedEndFormatted` optional.  The engine
 * always populates them.  We now re-export the engine's type directly.
 */
export type ShiftedScheduleSlot = _EngineShiftedScheduleSlot;

/**
 * UserPrediction — the engine's type, used directly.
 *
 * MIGRATION: The previous version augmented the engine's UserPrediction with
 * `offsetMinutes`, `crisisMode`, `crisisReason`, `expectedOnDurationLabel`,
 * and `expectedOffDurationLabel`.  All five fields are ALREADY present on the
 * engine's UserPrediction (see tmmsEngine.ts lines 1476-1528), so the
 * augmentation was redundant.  The engine's versions are also more correct:
 *   - crisisMode falls back to apppe.crisisMode (more robust)
 *   - expectedOn/OffDurationLabel use arabicDurationRange() (TMMS spec §23)
 */
export type UserPrediction = _EngineUserPrediction;

/**
 * Re-export applyOffsetToPrediction for admin tools (predictions.tsx uses it
 * to run per-offset simulations on the raw server prediction).
 */
export const applyOffsetToPrediction = _applyOffsetToPrediction;

// ── Frozen community-offset cache key ──────────────────────────────────────
// Per TMMS Rule Q2-A: the community offset is "computed once previously,
// never recalculated".  We persist it in AsyncStorage keyed by the resync
// point's syncedAtIso so it survives app restarts and remains stable for the
// lifetime of that resync.
function frozenOffsetStorageKey(syncedAtIso: string): string {
  return `tmms_frozen_community_offset_${syncedAtIso}`;
}

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * useUserPredictions
 *
 * Fetches the latest raw prediction from Supabase (real-time), applies the
 * user's ATC offset via the TMMS V2 engine, and returns a fully-resolved
 * UserPrediction every 30 seconds (for ATC mode re-derivation) or whenever
 * the underlying prediction / offset / resync changes.
 *
 * @param offsetMinutes          Stored user offset in minutes (personal DSD).
 * @param resyncPoint            Active community resync point, or null.
 * @param transitionMode         'AUTO' | 'MANUAL' — current TMMS mode.
 * @param anchorStartIso         Anchor start ISO (from useStateAnchor; passed
 *                               to the engine as heldCycleStartIso for
 *                               future-use instrumentation).
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // 30-second heartbeat — forces ATC mode re-derivation as time advances
  // without waiting for a new Supabase push.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Frozen community offset (Rule Q2-A) ──────────────────────────────────
  // The community offset must be computed ONCE per resync point and then
  // frozen — never recalculated, even if Growatt's state changes during the
  // generated cycle.  We cache it in a ref for the session and also persist
  // it to AsyncStorage so it survives app restarts.
  const frozenOffsetRef = useRef<number | null>(null);
  const [frozenOffsetLoaded, setFrozenOffsetLoaded] = useState(false);

  // When the resync point changes, reset the cache and load from AsyncStorage
  useEffect(() => {
    if (!resyncPoint) {
      frozenOffsetRef.current = null;
      setFrozenOffsetLoaded(true);
      return;
    }
    const key = frozenOffsetStorageKey(resyncPoint.syncedAtIso);
    AsyncStorage.getItem(key)
      .then(raw => {
        if (raw !== null) {
          const parsed = parseInt(raw, 10);
          if (!Number.isNaN(parsed)) {
            frozenOffsetRef.current = parsed;
          }
        }
        setFrozenOffsetLoaded(true);
      })
      .catch(() => setFrozenOffsetLoaded(true));
  }, [resyncPoint?.syncedAtIso]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up stale frozen-offset entries when the resync is cleared
  useEffect(() => {
    if (!resyncPoint) {
      // The resync was cleared — the next time one is applied, a fresh key
      // will be used.  We don't proactively delete old keys here because the
      // 6-hour safety-net in ResyncContext already handles cleanup.
    }
  }, [resyncPoint]);

  const userPrediction = useMemo((): UserPrediction | null => {
    if (!prediction) return null;
    if (!frozenOffsetLoaded) return null; // wait for AsyncStorage load
    try {
      // Build the communitySyncMeta display object from the resync point.
      // The engine accepts this as a display-data override; if null, the
      // engine builds its own fallback from the resyncPoint (see tmmsEngine.ts
      // lines 1504-1510).  We pass it explicitly so the display layer always
      // has the reporter name + reliability badge.
      const syncMeta: _EngineCommunitySyncMeta | null = resyncPoint
        ? {
            syncedAtIso: resyncPoint.syncedAtIso,
            syncedState: resyncPoint.syncedState,
            reporterName: resyncPoint.reporterName ?? null,
            reporterReliability: resyncPoint.reporterReliability ?? null,
          }
        : null;

      // ── onOffsetCalculated callback ──────────────────────────────────────
      // When the engine computes a FRESH community offset (i.e. the frozen
      // value was null), we capture it, persist it, and pass it as
      // frozenCommunityOffsetMinutes on subsequent renders.  This implements
      // Rule Q2-A: "computed once previously, never recalculated".
      const handleOffsetCalculated = (
        computedOffsetMinutes: number,
        _meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
      ) => {
        if (frozenOffsetRef.current === null && resyncPoint) {
          frozenOffsetRef.current = computedOffsetMinutes;
          const key = frozenOffsetStorageKey(resyncPoint.syncedAtIso);
          AsyncStorage.setItem(key, String(computedOffsetMinutes)).catch(() => {});
        }
      };

      // ── onAccuracyEvent callback ─────────────────────────────────────────
      // When the engine detects an ATC exit (UNCERTAIN_ZONE → Growatt
      // confirmed, or POSITIVE_OFFSET_PENDING → scheduled time reached), it
      // produces an AccuracyLogEvent.  We persist it to Supabase for
      // long-term accuracy analytics.
      const handleAccuracyEvent = (event: AccuracyLogEvent) => {
        supabase
          .from('accuracy_events')
          .insert({
            predicted_transition_at: event.predictedTransitionIso,
            actual_transition_at: event.actualTransitionIso,
            target_state: event.targetState,
            offset_minutes: event.offsetMinutes,
            exit_mode: event.exitMode,
            error_minutes: event.errorMinutes,
            accuracy_score: event.accuracyScore,
            created_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) {
              console.error('[useUserPredictions] accuracy event persist error:', error.message);
            }
          });
      };

      // ── Engine pipeline ──────────────────────────────────────────────────
      // All transition / offset / schedule / ATC logic lives inside the
      // engine.  This hook is a pure I/O wrapper.
      const result = _applyOffsetToPrediction(
        prediction as any,                // Prediction from usePredictions
        offsetMinutes,                    // personal DSD offset
        resyncPoint,                      // community resync point
        syncMeta,                         // communitySyncMeta (display data)
        transitionMode,                   // AUTO or MANUAL
        anchorStartIso,                   // heldCycleStartIso (instrumentation)
        frozenOffsetRef.current,          // frozenCommunityOffsetMinutes (Rule Q2-A)
        handleOffsetCalculated,           // onOffsetCalculated (freeze the offset)
        Date.now(),                       // nowMs — fresh on every tick
        handleAccuracyEvent,              // onAccuracyEvent (persist to Supabase)
      );

      return result;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  // frozenOffsetRef.current is intentionally excluded from deps (Rule Q2-A):
  // the frozen offset must NOT trigger re-computation — it is written once
  // inside this very callback (via handleOffsetCalculated) and then frozen
  // for the lifetime of the resync point.  Adding it to deps would cause an
  // immediate re-run that clears the freeze and computes a second offset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick, frozenOffsetLoaded]);

  return { userPrediction, loading };
}
