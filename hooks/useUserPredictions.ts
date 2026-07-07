/**
 * usserPredictions — Production hook that feeds the User Home Screen.
 *
 * Architecture:
 *   usePredictions (raw Supabase) → applyOffsetToPrediction (tmmsEngine) → UserPrediction
 *
 * The engine lives in app/(admin)/tmmsEngine.ts and is intentionally shared
 * between the production hook (here) and the admin TMMS Debug Simulator,
 * ensuring both always run the same TMMS V2 logic.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.1 MIGRATION NOTES
 * ───────────────────────────────────────────────────────────────────────────
 * This hook is now a THIN INTEGRATION LAYER around the TMMS V2 engine,
 * PLUS a V2.1 orchestration layer on top that adds the three concepts the
 * PDF introduces:
 *
 *   A. Generated ON — when an ON report is accepted (by reporter or
 *      approver), a permanent timeline event is created that becomes the
 *      user's current state. Its duration is copied from the nearest
 *      logical ON (finished or active). See `applyGeneratedOn`.
 *
 *   B. Offset State — the engine's offset is a single signed number; V2.1
 *      splits it into State (Positive/Negative/Neutral) and Value (number).
 *      The corrected V2.1 engine NEVER produces PendingNegative — >50%
 *      yields immediately NEGATIVE, and <50% yields immediately POSITIVE.
 *      The state is LOCKED by the >50%/<50% rule and never changes.
 *      auto-resolves to Negative when Growatt transitions to ON. See
 *      `useGrowattOnResolution` and `deriveOffsetState`.
 *
 *   C. Approver Cloning — when a YES response comes in, the user's
 *      offset/state/alignment are CLONED from the reporter, never
 *      recalculated. This is handled in useResyncNotifications; this hook
 *      simply reads back the cloned values from resync_history.
 *
 * Original V2 responsibilities preserved:
 *   1. Fetch raw prediction from Supabase (via usePredictions)
 *   2. Build the CommunitySyncMeta display object from the resync point
 *   3. Freeze the community offset after its first computation (Rule Q2-A)
 *   4. Persist accuracy events to Supabase
 *   5. Re-derive the UserPrediction every 30 seconds (ATC mode refresh)
 *
 * V2.1 additions:
 *   6. Layer Generated ON on top of the engine's daySchedule
 *   7. Compute Offset State (Positive/Negative/Neutral — never PendingNegative)
 *   8. Mark future ON slots as "Estimated" when the offset is tentative
 *      (before Growatt confirms the actual ON time)
 *   9. Subscribe to Growatt power_events to recompute the offset VALUE
 *      when Growatt turns ON (the STATE stays locked)
 *  10. Rebuild future predictions whenever Offset State changes
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePredictions } from './usePredictions';
import { supabase } from '../lib/supabase';
import {
  applyOffsetToPrediction as _applyOffsetToPrediction,
  fmtYemenTime,
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
 */
export type ScheduleStateMode = _EngineScheduleStateMode;

/**
 * CommunitySyncMeta — re-exported from the engine.
 */
export type CommunitySyncMeta = _EngineCommunitySyncMeta;

/**
 * ShiftedScheduleSlot — re-exported from the engine, augmented with V2.1
 * fields used by the schedule UI to render Generated ON badges and
 * Estimated (Pending Offset) labels.
 */
export type ShiftedScheduleSlot = _EngineShiftedScheduleSlot & {
  /**
   * V2.1: true when this slot was created as a Generated ON event (i.e.
   * the user pressed "Report ON" and the slot was injected into the
   * timeline as a first-class event). The Schedule screen renders an
   * "⚡ مُولّدة" badge for these slots.
   */
  isGeneratedOn?: boolean;
  /**
   * V2.1: true when this is a FUTURE ON slot whose start time cannot be
   * precisely computed because the user's offset is currently
   * PendingNegative (no numeric OffsetValue yet). The Schedule screen
   * renders a "تقديري (فارق معلّق)" badge for these slots.
   */
  isEstimatedPendingOffset?: boolean;
};

// ── TMMS V2.1: Offset State types ──────────────────────────────────────────
// PDF §"OFFSET CALCULATION ENGINE": four possible states. Mirrors the
// definitions in useResyncNotifications.ts — duplicated here as a local
// re-export so consumers can import from either hook without a circular
// dependency.
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
// V2.1 CORRECTED: PENDING_NEGATIVE is kept for backwards compatibility with
// legacy DB rows, but the corrected engine NEVER produces it. The >50%/<50%
// rule is ABSOLUTE:
//   >50% → NEGATIVE (always, locked, never changes)
//   <50% → POSITIVE (always, locked, never changes)
// The IMPORTANT NOTICE confirms (not flips) the state when Growatt turns ON.
export type OffsetValue = number | 'PENDING';
export type TimelineAlignment = string;

/**
 * V2.1: Generated ON metadata — attached to UserPrediction whenever the
 * user's current state is a Generated ON event.
 *
 * PDF §"GENERATED ON IS A REAL TIMELINE EVENT": "Generated ON must: be
 * stored, remain in history, become part of the permanent timeline. Never
 * delete Generated ON later. Never replace it. Never hide it."
 */
export interface GeneratedOnInfo {
  /** ISO when the Generated ON began (= the report's effective transition time) */
  startIso: string;
  /** Duration in minutes, copied from the nearest logical ON */
  durationMin: number;
  /** ISO of the reference ON used to compute duration */
  referenceIso: string;
  /** Whether the reference was already finished (Case 1) or still active (Case 2) */
  referenceKind: 'completed' | 'active';
  /**
   * When referenceKind='active', this Generated ON inherits the reference
   * ON's lifecycle — verification window, UNCERTAIN_ZONE, duration
   * reconciliation. The UI surfaces this as "🔄 متابعة دورة مرجعية".
   */
  inheritsReferenceLifecycle: boolean;
}

/**
 * UserPrediction — the engine's type, augmented with V2.1 fields.
 *
 * V2.1 augmentation fields (all optional so existing engine output still
 * type-checks):
 *   - offsetState              — Positive | Negative | Neutral (never PendingNegative)
 *   - offsetValue              — number (recomputed as T − G when Growatt ON arrives)
 *   - timelineAlignment        — iso string anchor
 *   - generatedOnInfo          — present when current state is a Generated ON
 *   - pendingNegativeResolutionIso — DEPRECATED (always null in corrected logic)
 *   - isPendingNegative        — DEPRECATED (always false in corrected logic)
 *   - isGeneratedOnCurrent     — convenience boolean for UI conditionals
 *   - isGeneratedOnCurrent     — convenience boolean for UI conditionals
 */
export type UserPrediction = _EngineUserPrediction & {
  offsetState?: OffsetState;
  offsetValue?: OffsetValue;
  timelineAlignment?: TimelineAlignment;
  generatedOnInfo?: GeneratedOnInfo | null;
  pendingNegativeResolutionIso?: string | null;
  isPendingNegative?: boolean; // DEPRECATED: always false in corrected V2.1
  isGeneratedOnCurrent?: boolean;
  /**
   * V2.2 (#4): set when an UNCERTAIN_ZONE deduction has been applied — the
   * backdated start of the current ON cycle. The Home screen gives this
   * TOP priority as the elapsed-time ("منذ") source.
   */
  reconciledCycleStartIso?: string | null;
};

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
//
// V2.1: we also freeze the Offset State and Timeline Alignment alongside
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

// ── V2.1: Derive Offset State from a numeric offset ────────────────────────
// Used as a fallback when resync_history doesn't yet have the V2.1
// offset_state column populated (i.e. for reports created under V2 and
// not yet re-confirmed under V2.1).
//
// PDF §"Rule 1": positive offset → report time was AFTER the previous
// Growatt ON started. Negative → before. Zero → neutral.
function deriveOffsetState(offsetMinutes: number): OffsetState {
  if (offsetMinutes > 0) return 'POSITIVE';
  if (offsetMinutes < 0) return 'NEGATIVE';
  return 'NEUTRAL';
}

// ── V2.1: Apply Generated ON on top of the engine's daySchedule ────────────
// PDF §"GENERATED ON IS A REAL TIMELINE EVENT": the Generated ON slot
// must be INSERTED into the daySchedule so future calculations can see it,
// not just rendered as a transient UI banner.
//
// We mutate the engine's output: if generatedOnInfo is present and the
// current state is ON, we ensure the first ON slot in the schedule is
// marked isGeneratedOn=true. If no slot matches the Generated ON start
// time, we unshift a synthetic slot — this mirrors what the engine does
// for POSITIVE_OFFSET_PENDING.
function applyGeneratedOnToSchedule(
  schedule: ShiftedScheduleSlot[],
  generatedOn: GeneratedOnInfo | null,
  nowMs: number,
): ShiftedScheduleSlot[] {
  if (!generatedOn) return schedule;
  const startMs = new Date(generatedOn.startIso).getTime();
  const endMs = startMs + generatedOn.durationMin * 60_000;
  // If the Generated ON has already ended, no slot mutation is needed —
  // it's a historical event the engine has already incorporated.
  if (endMs < nowMs) return schedule;

  // Check if the schedule already contains a slot at the Generated ON
  // start time (the engine may have placed one there via POSITIVE_OFFSET_PENDING
  // or COMMUNITY_SYNCED). If so, just tag it.
  const existingIdx = schedule.findIndex(s =>
    Math.abs(new Date(s.startIso).getTime() - startMs) < 60_000,
  );
  if (existingIdx >= 0) {
    const updated = [...schedule];
    updated[existingIdx] = { ...updated[existingIdx], isGeneratedOn: true };
    return updated;
  }

  // Otherwise, unshift a synthetic Generated ON slot.
  // We reuse the formatting helpers from the slot at index 0 (or defaults
  // if the schedule is empty) so the UI's time-formatting logic doesn't
  // break.
  const refSlot = schedule[0];
  const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
  const synthetic: ShiftedScheduleSlot = {
    state: 'ON',
    startIso: generatedOn.startIso,
    endIso: new Date(endMs).toISOString(),
    startFormatted: fmt(generatedOn.startIso),
    endFormatted: fmt(new Date(endMs).toISOString()),
    shiftedStartFormatted: fmt(generatedOn.startIso),
    shiftedEndFormatted: fmt(new Date(endMs).toISOString()),
    durationLabel: generatedOn.durationMin >= 60
      ? `${Math.floor(generatedOn.durationMin / 60)}س ${generatedOn.durationMin % 60}د`
      : `${generatedOn.durationMin}د`,
    zone: refSlot?.zone ?? 'NIGHT',
    isEstimated: false,
    isGeneratedOn: true,
  } as ShiftedScheduleSlot;
  return [synthetic, ...schedule];
}

// ── V2.1 CORRECTED: This function is now a no-op ───────────────────────────
// The corrected V2.1 engine NEVER produces PENDING_NEGATIVE — >50% yields
// immediately NEGATIVE, and <50% yields immediately POSITIVE. The state is
// LOCKED and never changes. Future ON predictions are always shown with the
// current offset value. Kept for backwards compatibility with any code that
// still references it.
function markEstimatedPendingOffset(
  schedule: ShiftedScheduleSlot[],
  isPendingNegative: boolean,
  nowMs: number,
): ShiftedScheduleSlot[] {
  // V2.1 CORRECTED: isPendingNegative is always false — no marking needed.
  return schedule;
  return schedule.map(s => {
    if (s.state === 'ON' && new Date(s.startIso).getTime() > nowMs) {
      return { ...s, isEstimatedPendingOffset: true };
    }
    return s;
  });
}

// ── V2.2 (#4): UNCERTAIN_ZONE exceeded-time deduction ────────────────────
// While the user waits in UNCERTAIN_ZONE (predicted OFF exceeded, Growatt
// not yet ON), the exceeded wait must be DEDUCTED from the next ON cycle:
//   exceeded = GrowattON − predictedOffEnd
//   ON start = predictedOffEnd  → "منذ" shows the exceeded time
//   ON end   = start + predicted ON duration → remaining = predicted − exceeded
// The entry anchor is persisted so it survives app restarts.
const UNCERTAIN_ZONE_ENTRY_KEY = 'tmms_uncertain_zone_entry_iso';
// Never backdate by more than 6 hours — protects against stale anchors.
const UNCERTAIN_DEDUCTION_CAP_MS = 6 * 3600_000;

function applyUncertainZoneDeduction(
  pred: UserPrediction,
  entryIso: string,
  nowMs: number,
): UserPrediction {
  const entryMs = new Date(entryIso).getTime();
  if (!Number.isFinite(entryMs)) return pred;
  const slots = (pred.daySchedule ?? []) as ShiftedScheduleSlot[];

  // Locate the ON cycle that began with the Growatt confirmation.
  const idx = slots.findIndex(s => {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return s.state === 'ON' && nowMs >= st && nowMs < en;
  });
  if (idx < 0) return pred;
  const slot = slots[idx];
  if (!slot.endIso) return pred;

  const oldStartMs = new Date(slot.startIso).getTime();
  const oldEndMs = new Date(slot.endIso).getTime();
  if (entryMs >= oldStartMs) return pred;                       // nothing exceeded
  if (oldStartMs - entryMs > UNCERTAIN_DEDUCTION_CAP_MS) return pred; // stale anchor

  const spanMs = oldEndMs - oldStartMs; // predicted ON duration (preserved)
  const newStartMs = entryMs;
  const newEndMs = newStartMs + spanMs;
  const delta = newEndMs - oldEndMs;    // negative — everything moves earlier

  const newSlots = slots.map((s, i) => {
    if (i < idx) return s;
    const stMs = i === idx ? newStartMs : new Date(s.startIso).getTime() + delta;
    const enMs = i === idx ? newEndMs : (s.endIso ? new Date(s.endIso).getTime() + delta : null);
    const stIso = new Date(stMs).toISOString();
    const enIso = enMs !== null ? new Date(enMs).toISOString() : null;
    return {
      ...s,
      startIso: stIso,
      endIso: enIso,
      startFormatted: fmtYemenTime(stIso),
      endFormatted: enIso ? fmtYemenTime(enIso) : null,
      shiftedStartFormatted: fmtYemenTime(stIso),
      shiftedEndFormatted: enIso ? fmtYemenTime(enIso) : null,
    };
  });

  // Re-derive the current state from the adjusted slots — the deducted ON
  // may already be over when the wait consumed most of its budget.
  const active = newSlots.find(s => {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= st && nowMs < en;
  }) ?? null;
  const currentState = active?.state ?? pred.currentState;
  const currentStateStartIso = active?.startIso ?? new Date(newStartMs).toISOString();

  // Rebuild nextTransition from the adjusted slots.
  const target: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';
  const nextSlot = newSlots.find(s =>
    s.state === target && new Date(s.startIso).getTime() > nowMs,
  ) ?? null;
  let nextTransition: any = pred.nextTransition;
  if (nextSlot) {
    const min = Math.max(0, (new Date(nextSlot.startIso).getTime() - nowMs) / 60_000);
    nextTransition = {
      type: target === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      earliestTime: nextSlot.startIso,
      latestTime: nextSlot.startIso,
      earliestFormatted: fmtYemenTime(nextSlot.startIso),
      latestFormatted: fmtYemenTime(nextSlot.startIso),
      minFromNowMin: min,
      maxFromNowMin: min,
      rangeLabel: fmtYemenTime(nextSlot.startIso),
      rangeStartIso: nextSlot.startIso,
      rangeEndIso: nextSlot.startIso,
      inRangeWindow: min <= 0,
    };
  }

  const result: any = {
    ...pred,
    daySchedule: newSlots,
    currentState,
    currentStateStartIso,
    nextTransition,
    reconciledCycleStartIso: currentStateStartIso,
  };
  return result as UserPrediction;
}

// ── V2.1: Auto-resolve Pending Negative when Growatt turns ON ──────────────
// PDF §Rule 2: "When Growatt finally turns ON ... the system immediately
// replaces Pending Negative → Negative. This replacement must happen
// automatically."
//
// This effect watches power_events for new UTILITY_ON rows. When one
// arrives AND the user's current offset is PendingNegative, it triggers a
// re-derivation by bumping an internal `pendingResolutionTick` state. The
// re-derivation reads the now-resolved offset from resync_history (which
// useResyncNotifications.resolvePendingNegativeOffsets has just updated).
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
 * user's ATC offset via the TMMS V2 engine, layers the V2.1 Generated ON /
 * Offset State / Pending Negative logic on top, and returns a fully-resolved
 * UserPrediction every 30 seconds (for ATC mode re-derivation) or whenever
 * the underlying prediction / offset / resync changes.
 *
 * @param offsetMinutes          Stored user offset in minutes (personal DSD).
 * @param resyncPoint            Active community resync point, or null.
 * @param transitionMode         'AUTO' | 'MANUAL' — current TMMS mode.
 * @param anchorStartIso         Anchor start ISO (from useStateAnchor; passed
 *                               to the engine as heldCycleStartIso for
 *                               future-use instrumentation).
 * @param onCommunityOffsetComputed  Q3-A callback for persisting community offset.
 */
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null = null,
  /**
   * Q3-A callback: called exactly once per resync session the first time the
   * engine computes a fresh community offset.  The caller (Home screen) uses
   * this to persist the community-derived offset to user_offsets so it
   * survives app restarts.  The in-memory freeze (Q2-A) is handled inside
   * this hook via frozenOffsetRef; this callback adds the DB-persistence layer.
   */
  onCommunityOffsetComputed?: (computedOffsetMinutes: number) => void,
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
  // V2.1: we now freeze THREE things — the numeric value, the Offset State,
  // and the Timeline Alignment — so an app restart can restore the full
  // V2.1 triple without re-deriving anything.
  const frozenOffsetRef = useRef<number | null>(null);
  const frozenOffsetStateRef = useRef<OffsetState | null>(null);
  const frozenAlignmentRef = useRef<TimelineAlignment | null>(null);
  const [frozenOffsetLoaded, setFrozenOffsetLoaded] = useState(false);

  // ── V2.2 (#4): UNCERTAIN_ZONE entry anchor — restored across restarts ──
  const uncertainEntryRef = useRef<string | null>(null);
  useEffect(() => {
    AsyncStorage.getItem(UNCERTAIN_ZONE_ENTRY_KEY)
      .then(v => { if (v) uncertainEntryRef.current = v; })
      .catch(() => {});
  }, []);

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
  }, [resyncPoint?.syncedAtIso]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── V2.1: Read Generated ON + Offset State from resync_history ──────────
  // The user's "current" Generated ON + Offset State lives in the most
  // recent resync_history row. We poll it alongside the 30s tick.
  const [v21Meta, setV21Meta] = useState<{
    offsetState: OffsetState | null;
    offsetValue: OffsetValue | null;
    timelineAlignment: TimelineAlignment | null;
    generatedOn: GeneratedOnInfo | null;
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
        let genOn: GeneratedOnInfo | null = null;
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
        setV21Meta({
          offsetState: (data.offset_state as OffsetState) ?? null,
          offsetValue: (data.offset_value as OffsetValue) ?? null,
          timelineAlignment: data.timeline_alignment ?? null,
          generatedOn: genOn,
        });
      } catch (_) { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [resyncPoint?.syncedAtIso, tick]);

  // ── V2.1: Pending Negative auto-resolution watcher ──────────────────────
  const isPendingNegativeV21 = v21Meta.offsetState === 'PENDING_NEGATIVE';
  const resolutionTick = useGrowattOnResolution(resyncPoint, isPendingNegativeV21);

  const userPrediction = useMemo((): UserPrediction | null => {
    if (!prediction) return null;
    if (!frozenOffsetLoaded) return null; // wait for AsyncStorage load
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
          // V2.1: derive the state from the sign and freeze it too.
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

      // ── V2.1 layer: Offset State / Value / Alignment ─────────────────────
      // Priority: resync_history (set by reporter or cloned by approver) →
      // frozen ref (computed once per resync) → derived from offsetMinutes
      // (legacy V2 fallback).
      const finalOffsetState: OffsetState =
        v21Meta.offsetState
        ?? frozenOffsetStateRef.current
        ?? deriveOffsetState(offsetMinutes);

      const finalOffsetValue: OffsetValue =
        v21Meta.offsetValue
        ?? (frozenOffsetRef.current !== null ? frozenOffsetRef.current : offsetMinutes);

      const finalTimelineAlignment: TimelineAlignment =
        v21Meta.timelineAlignment
        ?? frozenAlignmentRef.current
        ?? resyncPoint?.syncedAtIso
        ?? new Date().toISOString();

      const isPendingNegative = finalOffsetState === 'PENDING_NEGATIVE';
      const isGeneratedOnCurrent = !!v21Meta.generatedOn
        && new Date(v21Meta.generatedOn.startIso).getTime() <= Date.now()
        && (new Date(v21Meta.generatedOn.startIso).getTime()
            + v21Meta.generatedOn.durationMin * 60_000) > Date.now();

      // ── V2.1 layer: Apply Generated ON to the daySchedule ────────────────
      let v21Schedule = (engineResult.daySchedule ?? []) as ShiftedScheduleSlot[];
      v21Schedule = applyGeneratedOnToSchedule(
        v21Schedule,
        isGeneratedOnCurrent ? v21Meta.generatedOn : null,
        Date.now(),
      );
      v21Schedule = markEstimatedPendingOffset(v21Schedule, isPendingNegative, Date.now());

      // ── V2.1 layer: Pending Negative resolution forecast ─────────────────
      // For the countdown UI on the Home Screen, forecast when the next
      // Growatt ON is expected. We use the engine's nextTransition if it's
      // an ON transition; otherwise null.
      const pendingNegativeResolutionIso =
        isPendingNegative && engineResult.nextTransition?.type === 'UTILITY_ON'
          ? engineResult.nextTransition.rangeStartIso
          : null;

      // ── Assemble the V2.1-augmented UserPrediction ───────────────────────
      const v21Result: UserPrediction = {
        ...engineResult,
        daySchedule: v21Schedule,
        offsetState: finalOffsetState,
        offsetValue: finalOffsetValue,
        timelineAlignment: finalTimelineAlignment,
        generatedOnInfo: isGeneratedOnCurrent ? v21Meta.generatedOn : null,
        pendingNegativeResolutionIso,
        isPendingNegative,
        isGeneratedOnCurrent,
      };

      // ── V2.2 layer (#4): UNCERTAIN_ZONE exceeded-time accounting ────────
      // 1. Record when the user's predicted OFF ended (entry into the
      //    UNCERTAIN family). The anchor survives restarts (AsyncStorage).
      // 2. When Growatt confirms ON, backdate the new ON cycle to that
      //    anchor and deduct the exceeded wait from the predicted ON
      //    duration: "منذ" = exceeded time, remaining = predicted − exceeded.
      // 3. Clear the anchor when superseded by a community sync, when the
      //    cycle completes (back to a normal OFF), or when stale.
      const nowV22 = Date.now();
      const modeV22 = v21Result.atc.mode;
      const inUncertainFamily =
        v21Result.currentState === 'OFF' &&
        (modeV22 === 'UNCERTAIN_ZONE' || modeV22 === 'GRACE_MODE' || modeV22 === 'WAITING_FOR_GROWATT');

      if (inUncertainFamily && !uncertainEntryRef.current) {
        const entryIso = new Date(
          nowV22 - Math.max(0, v21Result.atc.overrunMinutes) * 60_000,
        ).toISOString();
        uncertainEntryRef.current = entryIso;
        AsyncStorage.setItem(UNCERTAIN_ZONE_ENTRY_KEY, entryIso).catch(() => {});
      }

      let finalResult: UserPrediction = v21Result;
      if (uncertainEntryRef.current) {
        const entryAgeMs = nowV22 - new Date(uncertainEntryRef.current).getTime();
        const isStale = !Number.isFinite(entryAgeMs) || entryAgeMs >= 12 * 3600_000;
        if (
          !isStale &&
          prediction.currentState === 'ON' &&
          v21Result.currentState === 'ON' &&
          modeV22 !== 'COMMUNITY_SYNCED'
        ) {
          finalResult = applyUncertainZoneDeduction(v21Result, uncertainEntryRef.current, nowV22);
        } else if (
          isStale ||
          modeV22 === 'COMMUNITY_SYNCED' ||
          (!inUncertainFamily && v21Result.currentState === 'OFF')
        ) {
          uncertainEntryRef.current = null;
          AsyncStorage.removeItem(UNCERTAIN_ZONE_ENTRY_KEY).catch(() => {});
        }
      }

      return finalResult;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  // frozenOffsetRef.current is intentionally excluded from deps (Rule Q2-A).
  // V2.1: same exclusion applies to frozenOffsetStateRef and frozenAlignmentRef.
  // resolutionTick is included so the memo re-runs when Growatt turns ON
  // and resolves a pending negative state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick, frozenOffsetLoaded, v21Meta, resolutionTick]);

  // ── Precise auto-transition timer (#2b) ────────────────────────────────
  // POSITIVE_OFFSET_PENDING / COMMUNITY_SYNCED expose a scheduled
  // auto-transition ISO. Re-derive EXACTLY when it arrives (plus a small
  // buffer) instead of waiting up to 30s for the next heartbeat, so the
  // held state flips the moment the countdown reaches zero.
  const scheduledFlipIso = userPrediction?.atc?.scheduledAutoTransitionIso ?? null;
  useEffect(() => {
    if (!scheduledFlipIso) return;
    const delayMs = new Date(scheduledFlipIso).getTime() - Date.now();
    if (Number.isNaN(delayMs) || delayMs <= 0) return;
    const id = setTimeout(() => setTick(t => t + 1), delayMs + 500);
    return () => clearTimeout(id);
  }, [scheduledFlipIso]);

  return { userPrediction, loading };
}
