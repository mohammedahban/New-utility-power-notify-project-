
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
 * TMMS V2.3 — NEGATIVE OFFSET IMMEDIATE ON FLIP (2026-07-08)
 * ───────────────────────────────────────────────────────────────────────────
 *
 * SCENARIO: User has negative offset (e.g. −60 min). Their predicted OFF
 * ended 60 minutes ago and they've been in UNCERTAIN_ZONE / WAITING_FOR_GROWATT.
 * When Growatt finally turns ON:
 *
 *   BEFORE this patch:
 *     1. poll-growatt inserts UTILITY_ON into power_events  ✓  (instant)
 *     2. poll-growatt triggers analyze-patterns             ✓  (instant)
 *     3. analyze-patterns updates utility_predictions       ⚠  (~10-30 s)
 *     4. usePredictions real-time push fires                ⚠  (depends on 3)
 *     5. Home screen flips to ON with correct elapsed       ⚠  (depends on 4)
 *
 *     During the gap (steps 3-5) the home screen still showed OFF even
 *     though Growatt was already ON.
 *
 *   AFTER this patch:
 *     1. power_events INSERT fires useGrowattOnWatcher      ✓  (instant)
 *     2. growattOnIso is set, growattOnTick bumped          ✓  (instant)
 *     3. useMemo re-runs with growattOnIso available        ✓  (instant)
 *     4. "immediate ON flip" branch synthesises ON state:
 *          userOnStart = growattOnIso + offsetMinutes
 *          e.g. G − 60 min → elapsed shows 60 min          ✓  (instant)
 *     5. Home screen flips to ON immediately                ✓  (instant)
 *     6. When utility_predictions finally updates, the
 *        engine derives the real slot and takes over from
 *        the synthetic slot                                  ✓  (clean handover)
 *
 * The elapsed displayed = |offsetMinutes| = how long ago the electricity
 * came on relative to the Growatt confirmation time.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * TMMS V2.1 MIGRATION NOTES (preserved)
 * ───────────────────────────────────────────────────────────────────────────
 *   A. Generated ON — permanent timeline event from ON report.
 *   B. Offset State — POSITIVE/NEGATIVE/NEUTRAL (never PendingNegative from engine).
 *   C. Approver Cloning — YES response clones reporter's offset triple.
 */
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
export type { ResyncPoint, TransitionMode } from '../app/(admin)/tmmsEngine';
export type ScheduleStateMode = _EngineScheduleStateMode;
export type CommunitySyncMeta = _EngineCommunitySyncMeta;

export type ShiftedScheduleSlot = _EngineShiftedScheduleSlot & {
  isGeneratedOn?: boolean;
  isEstimatedPendingOffset?: boolean;
};

// ── TMMS V2.1: Offset State types ──────────────────────────────────────────
export type OffsetState = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'PENDING_NEGATIVE';
export type OffsetValue = number | 'PENDING';
export type TimelineAlignment = string;

export interface GeneratedOnInfo {
  startIso: string;
  durationMin: number;
  referenceIso: string;
  referenceKind: 'completed' | 'active';
  inheritsReferenceLifecycle: boolean;
}

export type UserPrediction = _EngineUserPrediction & {
  offsetState?: OffsetState;
  offsetValue?: OffsetValue;
  timelineAlignment?: TimelineAlignment;
  generatedOnInfo?: GeneratedOnInfo | null;
  pendingNegativeResolutionIso?: string | null;
  isPendingNegative?: boolean;
  isGeneratedOnCurrent?: boolean;
  reconciledCycleStartIso?: string | null;
};

export const applyOffsetToPrediction = _applyOffsetToPrediction;

// ── Accuracy write-guard ─────────────────────────────────────────────────
// Persisted Set of already-logged (predictedEventTime|actualEventTime) pairs
// at minute precision. Prevents the ~88% duplicate rows that occur when the
// 30-second heartbeat tick causes useMemo to re-call handleAccuracyEvent
// with the same event multiple times before utility_predictions refreshes.
const ACCURACY_LOGGED_KEY = 'tmms_accuracy_logged_pairs';
const ACCURACY_LOG_MAX_SIZE = 300; // cap to avoid unbounded AsyncStorage growth

// ── Frozen community-offset cache keys ────────────────────────────────────
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
function deriveOffsetState(offsetMinutes: number): OffsetState {
  if (offsetMinutes > 0) return 'POSITIVE';
  if (offsetMinutes < 0) return 'NEGATIVE';
  return 'NEUTRAL';
}

// ── V2.1: Apply Generated ON on top of the engine's daySchedule ────────────
function applyGeneratedOnToSchedule(
  schedule: ShiftedScheduleSlot[],
  generatedOn: GeneratedOnInfo | null,
  nowMs: number,
): ShiftedScheduleSlot[] {
  if (!generatedOn) return schedule;
  const startMs = new Date(generatedOn.startIso).getTime();
  const endMs = startMs + generatedOn.durationMin * 60_000;
  if (endMs < nowMs) return schedule;

  const existingIdx = schedule.findIndex(s =>
    Math.abs(new Date(s.startIso).getTime() - startMs) < 60_000,
  );
  if (existingIdx >= 0) {
    const updated = [...schedule];
    updated[existingIdx] = { ...updated[existingIdx], isGeneratedOn: true };
    return updated;
  }

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

// ── V2.1 CORRECTED: no-op (PENDING_NEGATIVE never produced by engine) ──────
function markEstimatedPendingOffset(
  schedule: ShiftedScheduleSlot[],
  isPendingNegative: boolean,
  nowMs: number,
): ShiftedScheduleSlot[] {
  return schedule;
}

// ── V2.2 (#4): UNCERTAIN_ZONE exceeded-time deduction ────────────────────
const UNCERTAIN_ZONE_ENTRY_KEY = 'tmms_uncertain_zone_entry_iso';
const UNCERTAIN_DEDUCTION_CAP_MS = 6 * 3600_000;

function applyUncertainZoneDeduction(
  pred: UserPrediction,
  entryIso: string,
  nowMs: number,
): UserPrediction {
  const entryMs = new Date(entryIso).getTime();
  if (!Number.isFinite(entryMs)) return pred;
  const slots = (pred.daySchedule ?? []) as ShiftedScheduleSlot[];

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
  if (entryMs >= oldStartMs) return pred;
  if (oldStartMs - entryMs > UNCERTAIN_DEDUCTION_CAP_MS) return pred;

  const spanMs = oldEndMs - oldStartMs;
  const newStartMs = entryMs;
  const newEndMs = newStartMs + spanMs;
  const delta = newEndMs - oldEndMs;

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

  const active = newSlots.find(s => {
    const st = new Date(s.startIso).getTime();
    const en = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= st && nowMs < en;
  }) ?? null;
  const currentState = active?.state ?? pred.currentState;
  const currentStateStartIso = active?.startIso ?? new Date(newStartMs).toISOString();

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

// ── V2.3 FIX: Unified Growatt-ON watcher ──────────────────────────────────
//
// Subscribes to power_events for UTILITY_ON inserts whenever the user has
// a negative offset. Records growattOnIso + bumps tick to trigger useMemo.
//
// CRITICAL GUARDS (V2.3.1 patch):
//   1. growattOnIso is cleared to null when:
//        a) A UTILITY_OFF power_event arrives (new OFF cycle started)
//        b) Growatt subscription detects an OFF transition from inverter_state
//      This prevents a stale growattOnIso from the previous ON cycle from
//      triggering a synthetic flip in the NEXT OFF cycle.
//   2. The useMemo guards shouldImmediateFlip with a timestamp check:
//        growattOnMs >= uncertainEntryMs (Growatt ON happened AFTER the
//        uncertain zone entry). If growattOnIso predates the uncertain zone
//        entry it means it's from a previous ON cycle and must be ignored.
function useGrowattOnWatcher(
  resyncPoint: ResyncPoint | null,
  isPendingNegative: boolean,
  isNegativeOffset: boolean,
): { growattOnTick: number; growattOnIso: string | null; clearGrowattOn: () => void } {
  const [tick, setTick] = useState(0);
  const [growattOnIso, setGrowattOnIso] = useState<string | null>(null);

  const shouldSubscribe = isPendingNegative || isNegativeOffset;

  const clearGrowattOn = useCallback(() => {
    setGrowattOnIso(null);
  }, []);

  // Subscribe to power_events for new UTILITY_ON / UTILITY_OFF rows
  useEffect(() => {
    if (!shouldSubscribe) return;
    const channel = supabase
      .channel(`growatt_on_watcher_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'power_events' },
        (payload: any) => {
          const newRow = payload.new as { event_type?: string; occurred_at?: string };
          if (newRow.event_type === 'UTILITY_ON') {
            if (newRow.occurred_at) setGrowattOnIso(newRow.occurred_at);
            setTick(t => t + 1);
          } else if (newRow.event_type === 'UTILITY_OFF') {
            // New OFF cycle started — clear any previous ON iso so it
            // doesn't bleed into the next UNCERTAIN_ZONE check.
            setGrowattOnIso(null);
            setTick(t => t + 1);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [shouldSubscribe, resyncPoint?.syncedAtIso]);

  // Secondary: inverter_state real-time for edge cases (e.g. power_events delayed)
  useEffect(() => {
    if (!shouldSubscribe) return;
    const channel = supabase
      .channel(`growatt_inv_state_${Math.random().toString(36).slice(2)}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'inverter_state' },
        async (payload: any) => {
          const row = payload.new as { utility_on?: boolean; last_polled?: string };
          const old = payload.old as { utility_on?: boolean };
          if (row.utility_on === true && old.utility_on !== true) {
            // ON transition: record approximate time (power_events has precise time)
            const approxOnIso = row.last_polled ?? new Date().toISOString();
            setGrowattOnIso(prev => prev ?? approxOnIso);
            setTick(t => t + 1);
          } else if (row.utility_on === false && old.utility_on === true) {
            // OFF transition: clear growattOnIso so next UNCERTAIN_ZONE doesn't
            // inherit the previous cycle's Growatt ON timestamp.
            setGrowattOnIso(null);
            setTick(t => t + 1);
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [shouldSubscribe]);

  return { growattOnTick: tick, growattOnIso, clearGrowattOn };
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode,
  anchorStartIso: string | null = null,
  onCommunityOffsetComputed?: (computedOffsetMinutes: number) => void,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  // 30-second heartbeat
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Accuracy write-guard: in-memory + persisted Set ────────────────────
  const loggedPairsRef = useRef<Set<string>>(new Set());
  const loggedPairsLoadedRef = useRef(false);

  // Load persisted pairs once on mount
  useEffect(() => {
    AsyncStorage.getItem(ACCURACY_LOGGED_KEY)
      .then(raw => {
        if (raw) {
          try {
            const arr: string[] = JSON.parse(raw);
            loggedPairsRef.current = new Set(arr);
          } catch { /* ignore corrupt data */ }
        }
        loggedPairsLoadedRef.current = true;
      })
      .catch(() => { loggedPairsLoadedRef.current = true; });
  }, []);

  // ── Frozen community offset (Rule Q2-A) ──────────────────────────────────
  const frozenOffsetRef = useRef<number | null>(null);
  const frozenOffsetStateRef = useRef<OffsetState | null>(null);
  const frozenAlignmentRef = useRef<TimelineAlignment | null>(null);
  const [frozenOffsetLoaded, setFrozenOffsetLoaded] = useState(false);

  // ── UNCERTAIN_ZONE entry anchor ──────────────────────────────────────────
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
      uncertainEntryRef.current = null;
      AsyncStorage.removeItem(UNCERTAIN_ZONE_ENTRY_KEY).catch(() => {});
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
        if (rawState !== null) frozenOffsetStateRef.current = rawState as OffsetState;
        if (rawAlign !== null) frozenAlignmentRef.current = rawAlign;
        setFrozenOffsetLoaded(true);
      })
      .catch(() => setFrozenOffsetLoaded(true));
  }, [resyncPoint?.syncedAtIso]);

  // ── V2.1: Read Generated ON + Offset State from resync_history ──────────
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
        const { data: primaryData, error: primaryError } = await supabase
          .from('resync_history')
          .select('offset_state, offset_value, timeline_alignment, generated_on_start_iso, generated_on_duration_min, generated_on_reference_iso, generated_on_reference_kind, reverted_at')
          .order('confirmed_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        let data: any = primaryData;
        let error = primaryError;
        if (error && (error.message.includes('reverted_at') || error.message.includes('column'))) {
          const fallback = await supabase
            .from('resync_history')
            .select('offset_state, offset_value, timeline_alignment, generated_on_start_iso, generated_on_duration_min, generated_on_reference_iso, generated_on_reference_kind')
            .order('confirmed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          data = fallback.data;
          error = fallback.error;
        }
        if (cancelled || error || !data) return;
        if (data.reverted_at) {
          setV21Meta({ offsetState: null, offsetValue: null, timelineAlignment: null, generatedOn: null });
          return;
        }
        let genOn: GeneratedOnInfo | null = null;
        if (data.generated_on_start_iso && data.generated_on_duration_min) {
          genOn = {
            startIso: data.generated_on_start_iso,
            durationMin: data.generated_on_duration_min,
            referenceIso: data.generated_on_reference_iso ?? data.generated_on_start_iso,
            referenceKind: data.generated_on_reference_kind ?? 'completed',
            inheritsReferenceLifecycle: data.generated_on_reference_kind === 'active',
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

  // ── V2.3 FIX: Growatt-ON watcher (negative offset + pending negative) ───
  // isPendingNegative: must re-read resync_history after offset resolves
  // isNegativeOffset: must immediately flip UI to ON without waiting for analyze-patterns
  const isPendingNegativeV21 = v21Meta.offsetState === 'PENDING_NEGATIVE';
  const isNegativeOffset = offsetMinutes < 0;
  const { growattOnTick, growattOnIso, clearGrowattOn } = useGrowattOnWatcher(
    resyncPoint,
    isPendingNegativeV21,
    isNegativeOffset,
  );
  const resolutionTick = growattOnTick;

  // Track whether the "immediate ON" synthetic state is active so we can
  // clear growattOnIso once utility_predictions catches up.
  const immediateOnActiveRef = useRef(false);
  // Ref to drive post-memo growattOnIso cleanup without rendering side-effects.
  const shouldClearGrowattOnRef = useRef(false);

  const userPrediction = useMemo((): UserPrediction | null => {
    if (!prediction) return null;
    if (!frozenOffsetLoaded) return null;
    try {
      const nowV22 = Date.now();

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
            ? 'POSITIVE' : _meta.sign === 'NEGATIVE' ? 'NEGATIVE' : 'NEUTRAL';
          frozenOffsetStateRef.current = derivedState;
          frozenAlignmentRef.current = _meta.referenceIso ?? resyncPoint.syncedAtIso;
          AsyncStorage.setItem(frozenOffsetStorageKey(resyncPoint.syncedAtIso), String(computedOffsetMinutes)).catch(() => {});
          AsyncStorage.setItem(frozenOffsetStateStorageKey(resyncPoint.syncedAtIso), derivedState).catch(() => {});
          AsyncStorage.setItem(frozenAlignmentStorageKey(resyncPoint.syncedAtIso), frozenAlignmentRef.current).catch(() => {});
          onCommunityOffsetComputed?.(computedOffsetMinutes);
        }
      };

      const handleAccuracyEvent = (event: AccuracyLogEvent) => {
        // ── Write-guard: deduplicate using minute-precision composite key ──────
        // Truncate both timestamps to the minute so that sub-second retiming
        // differences between successive 30-second ticks don't produce a
        // different key for the same logical event.
        const predKey = event.predictedTransitionIso.slice(0, 16); // YYYY-MM-DDTHH:MM
        const actKey  = event.actualTransitionIso.slice(0, 16);
        const pairKey = `${predKey}|${actKey}`;

        if (loggedPairsRef.current.has(pairKey)) {
          // Already persisted — skip silently
          return;
        }

        // Optimistically mark as logged BEFORE the async insert so that any
        // re-render triggered by the insert response doesn't fire a second insert.
        loggedPairsRef.current.add(pairKey);

        // Persist the updated set (fire-and-forget, capped at MAX_SIZE)
        const pairsArray = Array.from(loggedPairsRef.current);
        const trimmed = pairsArray.length > ACCURACY_LOG_MAX_SIZE
          ? pairsArray.slice(pairsArray.length - ACCURACY_LOG_MAX_SIZE)
          : pairsArray;
        if (trimmed.length !== pairsArray.length) {
          loggedPairsRef.current = new Set(trimmed);
        }
        AsyncStorage.setItem(ACCURACY_LOGGED_KEY, JSON.stringify(trimmed)).catch(() => {});

        supabase
          .from('prediction_accuracy_logs')
          .insert({
            predicted_event_time: event.predictedTransitionIso,
            actual_event_time: event.actualTransitionIso,
            predicted_state: event.targetState,
            actual_state: event.targetState,
            error_minutes: Math.round(Math.abs(event.errorMinutes) * 100) / 100,
            accuracy_score: Math.round(Math.max(0, Math.min(100, event.accuracyScore)) * 100) / 100,
            slot_id: `client_hook_${event.targetState === 'UTILITY_ON' ? 'ON' : 'OFF'}`,
            created_at: new Date().toISOString(),
          })
          .then(({ error }) => {
            if (error) {
              // Roll back the optimistic mark so it can be retried next cycle
              loggedPairsRef.current.delete(pairKey);
              console.error('[useUserPredictions] accuracy log insert error:', error.message);
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
        nowV22,
        handleAccuracyEvent,
      );

      // ── V2.1 layer: Offset State / Value / Alignment ─────────────────────
      const finalOffsetState: OffsetState =
        v21Meta.offsetState ?? frozenOffsetStateRef.current ?? deriveOffsetState(offsetMinutes);
      const finalOffsetValue: OffsetValue =
        v21Meta.offsetValue ?? (frozenOffsetRef.current !== null ? frozenOffsetRef.current : offsetMinutes);
      const finalTimelineAlignment: TimelineAlignment =
        v21Meta.timelineAlignment ?? frozenAlignmentRef.current ?? resyncPoint?.syncedAtIso ?? new Date().toISOString();

      const isPendingNegative = finalOffsetState === 'PENDING_NEGATIVE';
      const isGeneratedOnCurrent = !!v21Meta.generatedOn
        && new Date(v21Meta.generatedOn.startIso).getTime() <= nowV22
        && (new Date(v21Meta.generatedOn.startIso).getTime() + v21Meta.generatedOn.durationMin * 60_000) > nowV22;

      let v21Schedule = (engineResult.daySchedule ?? []) as ShiftedScheduleSlot[];
      v21Schedule = applyGeneratedOnToSchedule(v21Schedule, isGeneratedOnCurrent ? v21Meta.generatedOn : null, nowV22);
      v21Schedule = markEstimatedPendingOffset(v21Schedule, isPendingNegative, nowV22);

      const pendingNegativeResolutionIso =
        isPendingNegative && engineResult.nextTransition?.type === 'UTILITY_ON'
          ? engineResult.nextTransition.rangeStartIso : null;

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

      // ── UNCERTAIN_ZONE / WAITING_FOR_GROWATT state tracking ──────────────
      const modeV22 = v21Result.atc.mode;
      // inUncertainFamily: the engine placed the user in UNCERTAIN_ZONE,
      // GRACE_MODE, or WAITING_FOR_GROWATT AND is actively HOLDING the OFF
      // state. isHoldingState=true is the authoritative signal — we must NOT
      // enter this branch for a NORMAL OFF (e.g. neutral/positive users whose
      // shifted schedule has a brief gap and the engine correctly set NORMAL).
      const inUncertainFamily =
        v21Result.currentState === 'OFF' &&
        v21Result.isHoldingState === true &&
        (modeV22 === 'UNCERTAIN_ZONE' || modeV22 === 'GRACE_MODE' || modeV22 === 'WAITING_FOR_GROWATT');

      // Record entry anchor (when predicted OFF slot ended)
      if (inUncertainFamily && !uncertainEntryRef.current) {
        const entryIso = new Date(
          nowV22 - Math.max(0, v21Result.atc.overrunMinutes) * 60_000,
        ).toISOString();
        uncertainEntryRef.current = entryIso;
        AsyncStorage.setItem(UNCERTAIN_ZONE_ENTRY_KEY, entryIso).catch(() => {});
      }

      let finalResult: UserPrediction = v21Result;

      // ── V2.3 FIX: Immediate ON flip for negative-offset users ─────────────
      //
      // Activation conditions (ALL must be true):
      //   1. growattOnIso is set AND is from the CURRENT uncertain zone cycle
      //      (growattOnMs >= uncertainEntryMs — prevents stale Growatt ON from
      //       a previous cycle triggering a spurious flip in the next OFF cycle)
      //   2. Engine still shows OFF with isHoldingState=true (in uncertain family)
      //   3. Not community-synced (community sync takes priority)
      //   4. User has a negative offset
      //
      // Guard against stale growattOnIso: if the uncertain zone entry hasn't
      // been set yet, the flip cannot be valid — we don't know when the
      // UNCERTAIN_ZONE started so we can't verify the Growatt ON is from
      // the correct cycle.
      const growattOnMs = growattOnIso ? new Date(growattOnIso).getTime() : 0;
      const uncertainEntryMs = uncertainEntryRef.current
        ? new Date(uncertainEntryRef.current).getTime()
        : Infinity; // no entry set → never flip

      // Growatt ON must have happened AFTER the uncertain zone began.
      // This rejects any stale growattOnIso from a previous ON cycle.
      const growattOnIsCurrentCycle =
        growattOnIso !== null &&
        growattOnMs >= uncertainEntryMs - 60_000; // 1-min tolerance for sub-second ordering

      const shouldImmediateFlip =
        growattOnIsCurrentCycle &&
        inUncertainFamily &&
        modeV22 !== 'COMMUNITY_SYNCED' &&
        offsetMinutes < 0;

      if (shouldImmediateFlip && growattOnIso) {
        const growattOnMs = new Date(growattOnIso).getTime();
        // User's ON started = Growatt ON time + offset (negative → shifts backward)
        // Example: G = 18:00, offset = −60 → userOnStart = 17:00
        // Elapsed when watcher fires: now − 17:00 ≈ 60 min = |offset|
        const userOnStartMs = growattOnMs + offsetMinutes * 60_000;
        const userOnStartIso = new Date(userOnStartMs).toISOString();

        // Estimate ON duration from the shifted schedule
        const scheduledOnSlot = (v21Result.daySchedule ?? []).find(
          (s: ShiftedScheduleSlot) => s.state === 'ON' && new Date(s.startIso).getTime() >= growattOnMs - 2 * 3600_000,
        );
        const onDurationMs = scheduledOnSlot?.endIso
          ? new Date(scheduledOnSlot.endIso).getTime() - new Date(scheduledOnSlot.startIso).getTime()
          : 120 * 60_000; // 2h default
        const userOnEndMs = userOnStartMs + onDurationMs;
        const userOnEndIso = new Date(userOnEndMs).toISOString();

        const fmtLocal = (iso: string) => new Date(iso).toLocaleString('en-US', {
          timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
        }).replace('AM', ' ص').replace('PM', ' م');

        const durMin = Math.round(onDurationMs / 60_000);
        const durH = Math.floor(durMin / 60); const durM = durMin % 60;
        const durationLabel = durH === 0 ? `${durM}د`
          : durM === 0 ? (durH === 1 ? 'ساعة' : `${durH}س`)
          : `${durH}س ${durM}د`;

        const syntheticOnSlot: ShiftedScheduleSlot = {
          state: 'ON',
          startIso: userOnStartIso,
          endIso: userOnEndIso,
          startFormatted: fmtLocal(userOnStartIso),
          endFormatted: fmtLocal(userOnEndIso),
          shiftedStartFormatted: fmtLocal(userOnStartIso),
          shiftedEndFormatted: fmtLocal(userOnEndIso),
          durationLabel,
          zone: 'DAY',
          isEstimated: true,
        };

        const nextOffMs = userOnEndMs;
        const nextTransition = {
          type: 'UTILITY_OFF' as const,
          earliestTime: userOnEndIso,
          latestTime: userOnEndIso,
          earliestFormatted: fmtLocal(userOnEndIso),
          latestFormatted: fmtLocal(userOnEndIso),
          minFromNowMin: Math.max(0, (nextOffMs - nowV22) / 60_000),
          maxFromNowMin: Math.max(0, (nextOffMs - nowV22) / 60_000),
          rangeLabel: fmtLocal(userOnEndIso),
          rangeStartIso: userOnEndIso,
          rangeEndIso: userOnEndIso,
          inRangeWindow: false,
        };

        immediateOnActiveRef.current = true;
        shouldClearGrowattOnRef.current = false; // keep active while holding

        // Save the UNCERTAIN_ZONE entry as userOnStartIso so that when
        // utility_predictions eventually updates, applyUncertainZoneDeduction
        // uses the correct backdated start.
        if (!uncertainEntryRef.current || new Date(uncertainEntryRef.current).getTime() > userOnStartMs) {
          uncertainEntryRef.current = userOnStartIso;
          AsyncStorage.setItem(UNCERTAIN_ZONE_ENTRY_KEY, userOnStartIso).catch(() => {});
        }

        finalResult = {
          ...v21Result,
          currentState: 'ON',
          currentStateStartIso: userOnStartIso,
          // reconciledCycleStartIso is the TOP priority for the Home screen
          // elapsed timer — shows |offset| minutes of elapsed immediately.
          reconciledCycleStartIso: userOnStartIso,
          isHoldingState: false,
          daySchedule: [syntheticOnSlot, ...(v21Result.daySchedule ?? [])],
          nextTransition,
          atc: {
            ...v21Result.atc,
            mode: 'NORMAL' as any,
            statusLine: '',
            overrunMinutes: 0,
            communityElevated: false,
            isHoldingState: false,
          },
        };
      } else {
        immediateOnActiveRef.current = false;
        // If the engine has caught up (v21Result shows ON), schedule growattOnIso
        // cleanup so the next OFF cycle starts clean. We use a ref flag rather
        // than calling clearGrowattOn() inside useMemo to avoid state updates
        // during render.
        if (v21Result.currentState === 'ON' && growattOnIso !== null) {
          shouldClearGrowattOnRef.current = true;
        }

        // ── Standard UNCERTAIN_ZONE deduction (utility_predictions updated) ──
        if (uncertainEntryRef.current) {
          const entryAgeMs = nowV22 - new Date(uncertainEntryRef.current).getTime();
          const isStale = !Number.isFinite(entryAgeMs) || entryAgeMs >= 12 * 3600_000;

          if (!isStale && v21Result.currentState === 'ON' && modeV22 !== 'COMMUNITY_SYNCED') {
            // utility_predictions has updated → backdate ON cycle to entry anchor
            // so elapsed shows the full wait time and remaining = predicted − wait.
            finalResult = applyUncertainZoneDeduction(v21Result, uncertainEntryRef.current, nowV22);
          } else if (
            isStale ||
            modeV22 === 'COMMUNITY_SYNCED' ||
            // Only clear the anchor when the user is genuinely back to NORMAL OFF
            // (not holding — i.e. they have completed a full ON→OFF cycle after
            // the UNCERTAIN_ZONE resolved). Never clear while still in uncertain family.
            (!inUncertainFamily && v21Result.currentState === 'OFF' && modeV22 === 'NORMAL' && !v21Result.isHoldingState)
          ) {
            // ON cycle completed normally → clear anchor
            uncertainEntryRef.current = null;
            AsyncStorage.removeItem(UNCERTAIN_ZONE_ENTRY_KEY).catch(() => {});
          }
        }
      }

      return finalResult;
    } catch (e) {
      console.error('[useUserPredictions] engine error:', e);
      return null;
    }
  // frozenOffsetRef, frozenOffsetStateRef, frozenAlignmentRef intentionally
  // excluded from deps (Rule Q2-A freeze). growattOnIso and resolutionTick
  // are included so the memo re-runs immediately when the watcher fires.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick, frozenOffsetLoaded, v21Meta, resolutionTick, growattOnIso, onCommunityOffsetComputed]);

  // ── Clear stale growattOnIso after engine catches up ─────────────────────
  // Runs after the memo settles. Prevents the previous ON cycle's growattOnIso
  // from triggering a synthetic flip in the next OFF/UNCERTAIN_ZONE cycle.
  useEffect(() => {
    if (shouldClearGrowattOnRef.current) {
      shouldClearGrowattOnRef.current = false;
      clearGrowattOn();
    }
  });

  // ── Precise auto-transition timer ─────────────────────────────────────────
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
