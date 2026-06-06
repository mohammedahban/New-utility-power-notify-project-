/**
 * useUserPredictions
 *
 * Applies the user's personal offset AND an optional community resync point
 * to the master prediction to produce a personalised schedule view.
 *
 * When a resync point is active:
 *   - The "current state" shown on the home screen is the resynced state.
 *   - The "next transition" countdown is recalculated from the resynced
 *     state start time + expected duration for that state, using the
 *     existing prediction's duration ranges — NOT a new schedule.
 *   - The day-schedule slots are adjusted so the current slot's start
 *     time reflects the resync point.
 *
 * Nothing about Growatt data, the master prediction, offsets, or other
 * users is ever modified.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Prediction, ScheduleSlot } from './usePredictions';
import { ResyncPoint } from '../contexts/ResyncContext';

export interface ShiftedTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  rangeLabel: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
}

export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  /** True when this slot is the currently-active resynced slot */
  isResynced?: boolean;
}

export interface UserPrediction {
  nextTransition: ShiftedTransition | null;
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  /** Current utility state (may be overridden by resync point) */
  currentState: 'ON' | 'OFF';
  currentStateDurationLabel: string;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  /** True when a community resync is actively shaping this prediction */
  isResynced: boolean;
  /** ISO timestamp when the resynced state started (for display) */
  resyncedAtIso: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shiftIsoByMinutes(iso: string, offsetMin: number): string {
  return new Date(new Date(iso).getTime() + offsetMin * 60000).toISOString();
}

function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function fmtWait(min: number): string {
  if (min <= 0) return 'soon';
  const h = Math.floor(min / 60);
  const m = Math.floor(min % 60);
  if (h === 0) return `~${m}m`;
  if (m === 0) return `~${h}h`;
  return `~${h}h ${m}m`;
}

function minutesFromNow(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / 60000;
}

// ── Core offset-only transform (no resync) ────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
): UserPrediction {
  let nextTransition: ShiftedTransition | null = null;
  if (prediction.nextTransition && !prediction.isUnstable) {
    const nt = prediction.nextTransition;
    const shiftedEarliest = shiftIsoByMinutes(nt.earliestTime, offsetMinutes);
    const shiftedLatest = shiftIsoByMinutes(nt.latestTime, offsetMinutes);
    const shiftedRangeLabel = `${fmtYemenTime(shiftedEarliest)} → ${fmtYemenTime(shiftedLatest)}`;
    const shiftedMin = nt.minFromNowMin + offsetMinutes;
    const shiftedMax = nt.maxFromNowMin + offsetMinutes;
    nextTransition = {
      type: nt.type,
      rangeLabel: shiftedRangeLabel,
      minFromNowMin: Math.max(0, shiftedMin),
      maxFromNowMin: Math.max(0, shiftedMax),
      waitLabel: `${fmtWait(shiftedMin)} → ${fmtWait(shiftedMax)}`,
    };
  }

  const daySchedule: ShiftedScheduleSlot[] = (prediction.daySchedule ?? []).map((slot) => {
    const shiftedStart = shiftIsoByMinutes(slot.startIso, offsetMinutes);
    const shiftedEnd = slot.endIso ? shiftIsoByMinutes(slot.endIso, offsetMinutes) : null;
    return {
      ...slot,
      shiftedStartFormatted: fmtYemenTime(shiftedStart),
      shiftedEndFormatted: shiftedEnd ? fmtYemenTime(shiftedEnd) : null,
    };
  });

  return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange?.label ?? null,
    expectedOnDurationLabel: prediction.expectedOnRange?.label ?? null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState: prediction.currentState,
    currentStateDurationLabel: prediction.currentStateDurationLabel,
    daySchedule,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: false,
    resyncedAtIso: null,
  };
}

// ── Resync overlay transform ──────────────────────────────────────────────────
/**
 * Applies a community resync point on top of the offset-adjusted prediction.
 *
 * Logic:
 * 1. The resynced state is now the "current state".
 * 2. Find the next slot in the day schedule whose state is OPPOSITE to
 *    the resynced state — that is the next transition target.
 * 3. Build a countdown to that slot's (offset-adjusted) start time.
 * 4. Mark the current slot as "resynced" for visual distinction.
 */
function applyResyncToPrediction(
  base: UserPrediction,
  resync: ResyncPoint,
  offsetMinutes: number,
  prediction: Prediction,
): UserPrediction {
  const resyncState = resync.syncedState; // 'ON' | 'OFF'
  const resyncAtMs = new Date(resync.syncedAtIso).getTime();
  const nowMs = Date.now();
  const elapsedMin = (nowMs - resyncAtMs) / 60000;

  // Mark day-schedule: find which slot contains the resync point and mark it
  const daySchedule = base.daySchedule.map((slot) => {
    const slotStartMs = new Date(
      shiftIsoByMinutes(slot.startIso, offsetMinutes),
    ).getTime();
    const slotEndMs = slot.endIso
      ? new Date(shiftIsoByMinutes(slot.endIso, offsetMinutes)).getTime()
      : Infinity;

    const containsResync =
      resyncAtMs >= slotStartMs && resyncAtMs < slotEndMs && slot.state === resyncState;

    return { ...slot, isResynced: containsResync };
  });

  // Find the next slot whose state differs from resynced state
  // Search from the resync point forward in the schedule
  let nextTransition: ShiftedTransition | null = null;
  const oppositeState = resyncState === 'ON' ? 'OFF' : 'ON';

  for (const slot of daySchedule) {
    if (slot.state !== oppositeState) continue;
    const slotStartMs = new Date(
      shiftIsoByMinutes(slot.startIso, offsetMinutes),
    ).getTime();
    // Must be after the resync point
    if (slotStartMs <= resyncAtMs) continue;

    const minFromNow = (slotStartMs - nowMs) / 60000;
    // Build a narrow range using the slot's expected start ± half the
    // original uncertainty range from the master prediction
    let halfSpreadMin = 15; // default fallback
    if (base.nextTransition) {
      halfSpreadMin = Math.max(
        5,
        (base.nextTransition.maxFromNowMin - base.nextTransition.minFromNowMin) / 2,
      );
    }

    const minMin = Math.max(0, minFromNow - halfSpreadMin);
    const maxMin = Math.max(0, minFromNow + halfSpreadMin);

    const shiftedSlotStart = shiftIsoByMinutes(slot.startIso, offsetMinutes);
    const shiftedEarliest = shiftIsoByMinutes(
      slot.startIso,
      offsetMinutes - halfSpreadMin,
    );
    const shiftedLatest = shiftIsoByMinutes(
      slot.startIso,
      offsetMinutes + halfSpreadMin,
    );

    nextTransition = {
      type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeLabel: `${fmtYemenTime(shiftedEarliest)} → ${fmtYemenTime(shiftedLatest)}`,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
    };
    break;
  }

  // Fallback: use the base next transition if no schedule slot found
  if (!nextTransition) {
    nextTransition = base.nextTransition;
  }

  // Duration label for resynced state
  const elapsedLabel =
    elapsedMin < 60
      ? `${Math.round(elapsedMin)}m`
      : `${Math.floor(elapsedMin / 60)}h ${Math.round(elapsedMin % 60)}m`;

  return {
    ...base,
    currentState: resyncState,
    currentStateDurationLabel: `${elapsedLabel} (community synced)`,
    nextTransition,
    daySchedule,
    isResynced: true,
    resyncedAtIso: resync.syncedAtIso,
  };
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [computedAt, setComputedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error('[useUserPredictions] fetch error:', error.message);
        if (data) {
          setRawPrediction(data.prediction as Prediction);
          setComputedAt(data.computed_at);
        }
        setLoading(false);
      });

    const channel = supabase
      .channel(`user_predictions_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'utility_predictions',
      }, (payload) => {
        const row = payload.new as any;
        if (row?.prediction) {
          setRawPrediction(row.prediction as Prediction);
          setComputedAt(row.computed_at);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  let userPrediction: UserPrediction | null = null;
  if (rawPrediction) {
    const base = applyOffsetToPrediction(rawPrediction, offsetMinutes);
    if (resyncPoint) {
      userPrediction = applyResyncToPrediction(
        base,
        resyncPoint,
        offsetMinutes,
        rawPrediction,
      );
    } else {
      userPrediction = base;
    }
  }

  return { userPrediction, rawPrediction, loading };
}
