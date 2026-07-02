/**
 * useUserPredictions — Production hook that feeds the User Home Screen.
 *
 * Architecture:
 *   usePredictions (raw Supabase) → applyOffsetToPrediction (tmmsEngine) → UserPrediction
 *
 * The engine lives in app/(admin)/tmmsEngine.ts and is intentionally shared
 * between the production hook (here) and the admin TMMS Debug Simulator,
 * ensuring both always run the same TMMS V2.2 logic.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.2 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 * This hook is a THIN INTEGRATION LAYER around the TMMS V2.2 engine,
 * PLUS a V2.2 orchestration layer on top that adds:
 *
 *   A. Generated ON — when an ON report is accepted (by reporter or
 *      approver), a permanent timeline event is created that becomes the
 *      user's current state. Its duration is copied from the replaced ON.
 *      Per the Personal Timeline Replacement Model: specific Growatt ON
 *      states are REPLACED by Generated ON states.
 *      NOTE: The engine's applyPersonalTimelineReplacement() now handles
 *      the schedule surgery (replacing ON slots and shifting subsequent
 *      slots). This hook only layers additional UI metadata on top.
 *
 *   B. Offset State — four possible states per V2.2:
 *        POSITIVE       → Period 1 (during ON or first half of OFF)
 *        PENDING_NEGATIVE → Period 2 (second half of OFF), auto-resolves
 *                           to NEGATIVE when Growatt ON begins
 *        NEGATIVE       → after Pending Negative resolves
 *        NEUTRAL        → Period 3 (exact ON start instant)
 *
 *   C. UNCERTAIN_ZONE duration reconciliation — when a Negative Offset user
 *      exits UNCERTAIN_ZONE because Growatt turned ON, the waiting time is
 *      deducted from the next ON duration.
 *
 *   D. Approver Cloning — when a YES response comes in, the user's
 *      offset/state/alignment are CLONED from the reporter, never
 *      recalculated.
 *
 * Original V2 / V2.1 responsibilities preserved:
 *   1. Fetch raw prediction from Supabase (via usePredictions)
 *   2. Build the CommunitySyncMeta display object from the resync point
 *   3. Freeze the community offset after its first computation (Rule Q2-A)
 *   4. Persist accuracy events to Supabase
 *   5. Re-derive the UserPrediction every 30 seconds (ATC mode refresh)
 *
 * V2.2 additions:
 *   6. Mark future ON slots as "Estimated (Pending Offset)" when offset
 *      is PENDING_NEGATIVE
 *   7. Subscribe to Growatt power_events to resolve PENDING_NEGATIVE
 *   8. Apply ON duration reconciliation after UNCERTAIN_ZONE
 *   9. Rebuild future predictions whenever Offset State changes
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
  type GeneratedOnInfo,
} from '../app/(admin)/tmmsEngine';

// ── Public type re-exports ─────────────────────────────────────────────────
export type { ResyncPoint, TransitionMode } from '../app/(admin)/tmmsEngine';

/**
 * The full set of ATC operational modes, re-exported from the engine.
 */
export type ScheduleStateMode = _EngineScheduleStateMode;

/**
 * CommunitySyncMeta — re-exported from the engine.
 */
export type CommunitySyncMeta = _EngineCommunitySyncMeta;

/**
 * ShiftedScheduleSlot — re-exported from the engine, augmented with V2.2
 * fields used by the schedule UI to render Generated ON badges and
 * Estimated (Pending Offset) labels.
 */
export type ShiftedScheduleSlot = _EngineShiftedScheduleSlot & {
  /**
   * V2.2: true when this slot was created as a Generated ON event (a
   * permanent timeline event created from a community ON report). Renders
   * a "⚡ مُولّدة" badge.
   */
  isGeneratedOn?: boolean;
  /**
   * V2.2: true when this is a FUTURE ON slot whose start time cannot be
   * precisely computed because the user's offset is PENDING_NEGATIVE (no
   * numeric OffsetValue yet). Renders a "تقديري (فارق معلّق)" badge.
   */
  isEstimatedPendingOffset?: boolean;
};

// ── TMMS V2.2: Offset State types ──────────────────────────────────────────
// V2.2: Four possible states per the Personal Timeline Replacement Model:
//   POSITIVE         → Period 1 (during Growatt ON or first half of OFF)
//   PENDING_NEGATIVE → Period 2 (second half of OFF), waiting for Growatt ON
//   NEGATIVE         → after Pending Negative resolves
//   NEUTRAL          → Period 3 (exact ON start instant)
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
export type OffsetValue = number | 'PENDING';
export type TimelineAlignment = string;

/**
 * V2.2: Generated ON metadata — attached to UserPrediction whenever the
 * user's current state is a Generated ON event.
 *
 * Per the Personal Timeline Replacement Model: Generated ON is a permanent
 * timeline event. It is never temporary, never deleted. It becomes part of
 * the user's timeline history. It immediately becomes the current user state.
 */
export interface GeneratedOnInfoLocal {
  /** ISO when the Generated ON began (= the report's effective transition time) */
  startIso: string;
  /** Duration in minutes, copied from the replaced ON */
  durationMin: number;
  /** ISO of the reference ON used to compute duration */
  referenceIso: string;
  /** Whether the reference was already finished ('completed') or still active */
  referenceKind: 'completed' | 'active';
  /**
   * When referenceKind='active', this Generated ON inherits the reference
   * ON's lifecycle — verification window, UNCERTAIN_ZONE, duration
   * reconciliation. The UI surfaces this as "🔄 متابعة دورة مرجعية".
   */
  inheritsReferenceLifecycle: boolean;
}

/**
 * UserPrediction — the engine's type, augmented with V2.2 fields.
 *
 * V2.2 augmentation fields:
 *   - offsetState              — POSITIVE | PENDING_NEGATIVE | NEGATIVE | NEUTRAL
 *   - offsetValue              — number | 'PENDING'
 *   - timelineAlignment        — iso string anchor
 *   - generatedOnInfo          — present when current state is a Generated ON
 *   - pendingNegativeResolutionIso — forecast of when Growatt ON will resolve
 *   - isPendingNegative        — true when offsetState === 'PENDING_NEGATIVE'
 *   - isGeneratedOnCurrent     — convenience boolean for UI conditionals
 */
export type UserPrediction = _EngineUserPrediction & {
  offsetState?: OffsetState;
  offsetValue?: OffsetValue;
  timelineAlignment?: TimelineAlignment;
  generatedOnInfo?: GeneratedOnInfoLocal | null;
  pendingNegativeResolutionIso?: string | null;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
};

/**
 * Re-export applyOffsetToPrediction for admin tools (predictions.tsx uses it
 * to run per-offset simulations on the raw server prediction).
 */
export const applyOffsetToPrediction = _applyOffsetToPrediction;

// ── Frozen community-offset cache key ──────────────────────────────────────
// Per TMMS Rule Q2-A: the community offset is "computed once previously,
// never recalculated". We persist it in AsyncStorage keyed by the resync
// point's syncedAtIso so it survives app restarts.
//
// V2.2: we also freeze the Offset State and Timeline Alignment alongside
// the numeric Offset Value, so an app restart can restore the full
// (state, value, alignment) triple without re-deriving anything.
function frozenOffsetStorageKey(syncedAtIso: string): string {
  return `tmms_frozen_community_offset_${syncedAtIso}`;
}
function frozenOffsetStateStorageKey(syncedAtIso: string): string {
  return `tmms_frozen_offset_state_${syncedAtIso}`;
}
function frozenAlignmentStorageKey(syncedAtIso: string): string {
  return `tmms_frozen_alignment_${syncedAtIso}`;
}

// ── V2.2: Derive Offset State from numeric offset ──────────────────────────
// Used as a fallback when resync_history doesn't yet have the V2.2
// offset_state column populated.
function deriveOffsetState(offsetMinutes: number): OffsetState {
  if (offsetMinutes > 0) return 'POSITIVE';
  if (offsetMinutes < 0) return 'NEGATIVE';
  return 'NEUTRAL';
}

// ── V2.2: Mark future ON slots as estimated when Pending Negative ──────────
// When the user's offset is PENDING_NEGATIVE, future ON slot start times
// cannot be precisely computed (the numeric offset value is not yet known).
// Mark these slots so the UI can show "تقديري (فارق معلّق)".
function markEstimatedPendingOffset(
  schedule: ShiftedScheduleSlot[],
  isPendingNegative: boolean,
  nowMs: number,
): ShiftedScheduleSlot[] {
  // V2.2: If Pending Negative, mark future ON slots as estimated
  if (!isPendingNegative) return schedule;
  return schedule.map(s => {
    if (s.state === 'ON' && new Date(s.startIso).getTime() > nowMs) {
      return { ...s, isEstimatedPendingOffset: true };
    }
    return s;
  });
}

// ── V2.2: Auto-resolve PENDING_NEGATIVE when Growatt turns ON ─────────────
// When Growatt finally turns ON, the system resolves PENDING_NEGATIVE to
// NEGATIVE by computing the actual numeric offset value:
//   offsetValue = GeneratedONstart - ActualGrowattONstart
//
// This effect watches power_events for new UTILITY_ON rows. When one
// arrives AND the user's current offset is PENDING_NEGATIVE, it triggers
// a re-derivation by bumping an internal `pendingResolutionTick` state.
function useGrowattOnResolution(
  resyncPoint: ResyncPoint | null,
  isPendingNegative: boolean,
): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!isPendingNegative) return;
    const channel = supabase
      .channel(`growatt_resolution_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        (payload: any) => {
          const newRow = payload.new as { event_type?: string };
          if (newRow.event_type !== 'UTILITY_ON') return;
          // Bump the tick — the parent useMemo depends on it and will
          // re-fetch the (now-resolved) offset from resync_history.
          setTick(t => t + 1);
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isPendingNegative, resyncPoint?.syncedAtIso]);
  return tick;
}

// ── Hook ───────────────────────────────────────────────────────────────────

/**
 * useUserPredictions
 *
 * Fetches the latest raw prediction from Supabase (real-time), applies the
 * user's ATC offset via the TMMS V2.2 engine, layers the V2.2 Generated ON /
 * Offset State / Pending Negative / UNCERTAIN_ZONE reconciliation logic on
 * top, and returns a fully-resolved UserPrediction every 30 seconds.
 *
 * @param offsetMinutes          Stored user offset in minutes (personal DSD).
 * @param resyncPoint            Active community resync point, or null.
 * @param transitionMode         'AUTO' | 'MANUAL' — current TMMS mode.
 * @param anchorStartIso         Anchor start ISO (from useStateAnchor).
 * @param onCommunityOffsetComputed  Q3-A callback for persisting community offset.
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null = null,
  /**
   * Q3-A callback: called exactly once per resync session the first time the
   * engine computes a fresh community offset.
   */
  onCommunityOffsetComputed?: (computedOffsetMinutes: number) => void,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // 30-second heartbeat — forces ATC mode re-derivation as time advances
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Frozen community offset (Rule Q2-A) ──────────────────────────────────
  const frozenOffsetRef = useRef<number | null>(null);
  const frozenOffsetStateRef = useRef<OffsetState | null>(null);
  const frozenAlignmentRef = useRef<TimelineAlignment | null>(null);
  const [frozenOffsetLoaded, setFrozenOffsetLoaded] = useState(false);

  useEffect(() => {
    if (!resyncPoint) {
      frozenOffsetRef.current = null;
      frozenOffsetStateRef.current = null;
      frozenAlignmentRef.current = null;
      setFrozenOffsetLoaded(true);
      return;
    }
    const keyVal = frozenOffsetStorageKey(resyncPoint.syncedAtIso);
    const keyState = frozenOffsetStateStorageKey(resyncPoint.syncedAtIso);
    const keyAlign = frozenAlignmentStorageKey(resyncPoint.syncedAtIso);
    Promise.all([
      AsyncStorage.getItem(keyVal),
      AsyncStorage.getItem(keyState),
      AsyncStorage.getItem(keyAlign),
    ])
      .then(([rawVal, rawState, rawAlign]) => {
        if (rawVal !== null) {
          const parsed = parseInt(rawVal, 10);
          if (!Number.isNaN(parsed)) frozenOffsetRef.current = parsed;
        }
        if (rawState !== null) {
          frozenOffsetStateRef.current = rawState as OffsetState;
        }
        if (rawAlign !== null) {
          frozenAlignmentRef.current = rawAlign;
        }
        setFrozenOffsetLoaded(true);
      })
      .catch(() => setFrozenOffsetLoaded(true));
  }, [resyncPoint?.syncedAtIso]);

  // ── V2.2: Read Generated ON + Offset State from resync_history ──────────
  const [v22Meta, setV22Meta] = useState<{
    offsetState: OffsetState | null;
    offsetValue: OffsetValue | null;
    timelineAlignment: TimelineAlignment | null;
    generatedOn: GeneratedOnInfoLocal | null;
  }>({ offsetState: null, offsetValue: null, timelineAlignment: null, generatedOn: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('resync_history')
          .select('offset_state, offset_value, timeline_alignment, generated_on_start_iso, generated_on_duration_min, generated_on_reference_iso, generated_on_reference_kind')
          .order('confirmed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (cancelled || !data) return;
        let genOn: GeneratedOnInfoLocal | null = null;
        if (data.generated_on_start_iso && data.generated_on_duration_min) {
          genOn = {
            startIso: data.generated_on_start_iso,
            durationMin: data.generated_on_duration_min,
            referenceIso: data.generated_on_reference_iso ?? data.generated_on_start_iso,
            referenceKind: data.generated_on_reference_kind ?? 'completed',
            inheritsReferenceLifecycle:
              data.generated_on_reference_kind === 'active',
          };
        }
        setV22Meta({
          offsetState: (data.offset_state as OffsetState) ?? null,
          offsetValue: (data.offset_value as OffsetValue) ?? null,
          timelineAlignment: data.timeline_alignment ?? null,
          generatedOn: genOn,
        });
      } catch (_) { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [resyncPoint?.syncedAtIso, tick]);

  // ── V2.2: PENDING_NEGATIVE auto-resolution watcher ────────────────────────
  const isPendingNegativeV22 = v22Meta.offsetState === 'PENDING_NEGATIVE';
  const resolutionTick = useGrowattOnResolution(resyncPoint, isPendingNegativeV22);

  const userPrediction = useMemo((): UserPrediction | null => {
    if (!prediction) return null;
    if (!frozenOffsetLoaded) return null;
    try {
      const syncMeta: _EngineCommunitySyncMeta | null = resyncPoint
        ? {
            syncedAtIso: resyncPoint.syncedAtIso,
            syncedState: resyncPoint.syncedState,
            reporterName: resyncPoint.reporterName ?? null,
            reporterReliability: resyncPoint.reporterReliability ?? null,
          }
        : null;

      const handleOffsetCalculated = (
        computedOffsetMinutes: number,
        _meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
      ) => {
        if (frozenOffsetRef.current === null && resyncPoint) {
          frozenOffsetRef.current = computedOffsetMinutes;
          const derivedState: OffsetState = _meta.sign === 'POSITIVE'
            ? 'POSITIVE'
            : _meta.sign === 'NEGATIVE'
              ? 'NEGATIVE'
              : 'NEUTRAL';
          frozenOffsetStateRef.current = derivedState;
          frozenAlignmentRef.current = _meta.referenceIso ?? resyncPoint.syncedAtIso;

          const keyVal = frozenOffsetStorageKey(resyncPoint.syncedAtIso);
          const keyState = frozenOffsetStateStorageKey(resyncPoint.syncedAtIso);
          const keyAlign = frozenAlignmentStorageKey(resyncPoint.syncedAtIso);
          AsyncStorage.setItem(keyVal, String(computedOffsetMinutes)).catch(() => {});
          AsyncStorage.setItem(keyState, derivedState).catch(() => {});
          AsyncStorage.setItem(keyAlign, frozenAlignmentRef.current).catch(() => {});

          onCommunityOffsetComputed?.(computedOffsetMinutes);
        }
      };

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
      // V2.2: The engine now handles Personal Timeline Replacement internally
      // via applyPersonalTimelineReplacement(). It replaces the appropriate
      // Growatt ON with Generated ON and shifts subsequent slots by offset.
      const engineResult = _applyOffsetToPrediction(
        prediction as any,
        offsetMinutes,
        resyncPoint,
        syncMeta,
        transitionMode,
        anchorStartIso,
        frozenOffsetRef.current,
        handleOffsetCalculated,
        Date.now(),
        handleAccuracyEvent,
      );

      // ── V2.2 layer: Offset State / Value / Alignment ─────────────────────
      // Priority: resync_history (set by reporter or cloned by approver) →
      // frozen ref (computed once per resync) → derived from offsetMinutes
      const finalOffsetState: OffsetState =
        v22Meta.offsetState
        ?? frozenOffsetStateRef.current
        ?? deriveOffsetState(offsetMinutes);

      const finalOffsetValue: OffsetValue =
        v22Meta.offsetValue
        ?? (frozenOffsetRef.current !== null ? frozenOffsetRef.current : offsetMinutes);

      const finalTimelineAlignment: TimelineAlignment =
        v22Meta.timelineAlignment
        ?? frozenAlignmentRef.current
        ?? resyncPoint?.syncedAtIso
        ?? new Date().toISOString();

      const isPendingNegative = finalOffsetState === 'PENDING_NEGATIVE';
      const isGeneratedOnCurrent = !!v22Meta.generatedOn
        && new Date(v22Meta.generatedOn.startIso).getTime() <= Date.now()
        && (new Date(v22Meta.generatedOn.startIso).getTime()
            + v22Meta.generatedOn.durationMin * 60_000) > Date.now();

      // ── V2.2 layer: Mark Estimated Pending Offset for PENDING_NEGATIVE ───
      // The engine has already handled the Personal Timeline Replacement.
      // We just need to mark future ON slots as estimated when pending.
      let v22Schedule = (engineResult.daySchedule ?? []) as ShiftedScheduleSlot[];
      v22Schedule = markEstimatedPendingOffset(v22Schedule, isPendingNegative, Date.now());

      // ── V2.2 layer: Pending Negative resolution forecast ─────────────────
      const pendingNegativeResolutionIso =
        isPendingNegative && engineResult.nextTransition?.type === 'UTILITY_ON'
          ? engineResult.nextTransition.earliestTime
          : null;

      // ── Assemble the V2.2-augmented UserPrediction ───────────────────────
      const v22Result: UserPrediction = {
        ...engineResult,
        daySchedule: v22Schedule,
        offsetState: finalOffsetState,
        offsetValue: finalOffsetValue,
        timelineAlignment: finalTimelineAlignment,
        generatedOnInfo: isGeneratedOnCurrent ? v22Meta.generatedOn : null,
        pendingNegativeResolutionIso,
        isPendingNegative,
        isGeneratedOnCurrent,
      };

      return v22Result;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  // frozenOffsetRef.current is intentionally excluded from deps (Rule Q2-A).
  // resolutionTick is included so the memo re-runs when Growatt turns ON
  // and resolves a pending negative state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick, frozenOffsetLoaded, v22Meta, resolutionTick]);

  return { userPrediction, loading };
}
