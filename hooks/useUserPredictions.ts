/**
 * useUserPredictions — Layered Scheduling Engine
 *
 * Implements the formula:
 *   Effective User Timeline
 *     = Master Pattern (from utility_predictions)
 *     + User Offset
 *     + Growatt Expansion/Shortening Adjustments  (auto-applied via master update)
 *     + Community Sync Adjustments
 *
 * ── KEY DESIGN RULES ───────────────────────────────────────────────────────
 *
 * 1. MASTER PATTERN IS THE ONLY SOURCE OF CYCLE DURATIONS
 *    The user schedule inherits every ON/OFF duration exactly from the master.
 *    No independent pattern generation is allowed.
 *
 * 2. GROWATT CORRECTIONS FLOW AUTOMATICALLY
 *    When analyze-patterns updates utility_predictions, the Realtime channel
 *    fires, rawPrediction updates, and the entire effective timeline is rebuilt
 *    from scratch. Positive-offset users get extended cycles; negative-offset
 *    users get corrections applied to future cycles.
 *
 * 3. COMMUNITY SYNC IS A TIMELINE SHIFT, NOT A TERMINAL STATE
 *    A resync point sets a "delta" — the difference between where the master
 *    says the current cycle started and where it actually started.
 *    That delta shifts the current AND ALL FUTURE cycles uniformly.
 *    The schedule never ends after a community sync.
 *
 * 4. PRIORITY ORDER: Community > Growatt > Master
 *    Community-adjusted cycles are never overwritten by Growatt corrections
 *    because the delta is reapplied on top of every master update.
 *
 * 5. EXTENDED FUTURE SCHEDULE
 *    The master daySchedule may cover only 24h. We extend it to 48h by
 *    repeating the master's ON/OFF cycle durations so future slots are
 *    always visible.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Prediction, ScheduleSlot } from './usePredictions';
import { ResyncPoint } from '../contexts/ResyncContext';

// ── Public types ──────────────────────────────────────────────────────────────

// ── ATC types ────────────────────────────────────────────────────────────────

/**
 * ATC Schedule State Mode
 *
 * NORMAL              — Cycle is operating within expected parameters
 * PREDICTION_RANGE    — Now is inside the predicted transition window (transition likely)
 * UNCERTAIN_ZONE      — Prediction window ended, real transition not yet confirmed
 * COMMUNITY_SYNCED    — Cycle was started/confirmed via community report
 * WAITING_FOR_GROWATT — Waiting for Growatt sensor to confirm transition (positive offset)
 */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT';

export interface ATCState {
  mode: ScheduleStateMode;
  /** How many minutes the current cycle has exceeded the expected max duration (≥0) */
  overrunMinutes: number;
  /** True when community reports should carry elevated priority */
  communityElevated: boolean;
  /** User-visible status line (Arabic) */
  statusLine: string | null;
}

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
  /** True when this slot has been moved by a community sync */
  isResynced?: boolean;
}

export interface UserPrediction {
  /** ATC: describes the current decision-layer state */
  atc: ATCState;
  nextTransition: ShiftedTransition | null;
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  currentState: 'ON' | 'OFF';
  currentStateDurationLabel: string;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  /** True when we are holding the current state (not blindly transitioning) because ATC hasn't approved */
  isHoldingState: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

function fmtYemenTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Returns the zone label for a given ISO timestamp, matching the same
 * getZone() logic used by the analyze-patterns Edge Function.
 *
 * Yemen time is UTC+3 so we shift before extracting the hour.
 */
function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  if (h < 6)  return 'Night';
  if (h < 10) return 'Morning';
  if (h < 16) return 'Midday';
  if (h < 20) return 'Evening';
  return 'Late Night';
}

function fmtWait(min: number): string {
  if (min <= 0) return 'قريباً';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `~${m}د`;
  if (m === 0) return `~${h}س`;
  return `~${h}س ${m}د`;
}

function durationLabelFromMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : `${h}س`;
  return `${h}س ${m}د`;
}

// ── Step 1: Extend master schedule to 48 h ────────────────────────────────────
/**
 * The master daySchedule typically covers 24 h.
 * We extend it by repeating the ACTUAL ON/OFF durations extracted from
 * the master slots themselves — never from aggregate averages.
 *
 * Strategy:
 *   1. Find the last complete ON→OFF pair in master slots to get real durations.
 *   2. Fall back to the last single complete slot's duration if no pair found.
 *   3. Only fall back to aggregate stats as a last resort.
 *
 * This ensures the extension mirrors the real cycle structure (e.g. 2h ON /
 * 7h OFF) rather than introducing phantom extra cycles from wrong averages.
 */
function extendScheduleTo48h(
  masterSlots: ScheduleSlot[],
  prediction: Prediction,
): ScheduleSlot[] {
  if (masterSlots.length === 0) return [];

  // ── Extract real ON and OFF durations from the master slot sequence ──────
  // Walk the master slots to find the most recent complete ON duration and
  // the most recent complete OFF duration.
  let realOnMin: number | null = null;
  let realOffMin: number | null = null;

  for (let i = masterSlots.length - 1; i >= 0; i--) {
    const s = masterSlots[i];
    if (!s.endIso) continue; // skip open-ended (current) slot
    const durMin = (new Date(s.endIso).getTime() - new Date(s.startIso).getTime()) / 60_000;
    if (durMin < 5) continue; // skip suspiciously short slots (noise)
    if (s.state === 'ON' && realOnMin === null) realOnMin = durMin;
    if (s.state === 'OFF' && realOffMin === null) realOffMin = durMin;
    if (realOnMin !== null && realOffMin !== null) break;
  }

  // Last-resort fallbacks — prefer range labels over aggregate averages
  // because aggregates can include stale/outlier cycles.
  const extOnMin = realOnMin ??
    prediction.expectedOnRange?.minMin ??
    prediction.allPattern?.avgOnMin ??
    prediction.dayPattern?.avgOnMin ??
    120;
  const extOffMin = realOffMin ??
    prediction.expectedOffRange?.minMin ??
    prediction.allPattern?.avgOffMin ??
    prediction.dayPattern?.avgOffMin ??
    360;

  const horizonMs = Date.now() + 48 * 60 * 60 * 1000;
  const slots: ScheduleSlot[] = [...masterSlots];

  // Safety: cap at 40 slots to avoid infinite loop
  while (slots.length < 40) {
    const last = slots[slots.length - 1];
    if (!last.endIso) break; // open-ended slot — can't extend safely

    const lastEndMs = new Date(last.endIso).getTime();
    if (lastEndMs >= horizonMs) break;

    const nextState: 'ON' | 'OFF' = last.state === 'ON' ? 'OFF' : 'ON';
    const durationMin = nextState === 'OFF' ? extOffMin : extOnMin;
    const nextStartIso = last.endIso;
    const nextEndMs = lastEndMs + durationMin * 60_000;
    const nextEndIso = new Date(nextEndMs).toISOString();

    slots.push({
      state: nextState,
      startIso: nextStartIso,
      endIso: nextEndIso,
      startFormatted: fmtYemenTime(nextStartIso),
      endFormatted: fmtYemenTime(nextEndIso),
      durationLabel: durationLabelFromMin(Math.round(durationMin)),
      zone: getZoneFromIso(nextStartIso),
      isEstimated: true,
    });
  }

  return slots;
}

// ── Step 2: Apply user offset to all slots ────────────────────────────────────
function applyOffsetToSlots(
  slots: ScheduleSlot[],
  offsetMs: number,
): ShiftedScheduleSlot[] {
  return slots.map((slot) => {
    const startIso = shiftMs(slot.startIso, offsetMs);
    const endIso = slot.endIso ? shiftMs(slot.endIso, offsetMs) : null;
    return {
      ...slot,
      // Keep original ISO references so community delta can be applied on top
      startIso,
      endIso,
      startFormatted: fmtYemenTime(startIso),
      endFormatted: endIso ? fmtYemenTime(endIso) : null,
      shiftedStartFormatted: fmtYemenTime(startIso),
      shiftedEndFormatted: endIso ? fmtYemenTime(endIso) : null,
      isResynced: false,
    };
  });
}

// ── Step 3: Apply community sync delta ────────────────────────────────────────
/**
 * Community sync logic:
 *
 * 1. Find the slot in the offset-adjusted schedule whose state matches
 *    resync.syncedState and whose time window contains resync.syncedAtIso.
 *    (If the resync point is slightly before the slot's predicted start —
 *    e.g. grid came ON earlier than predicted — we still match the first
 *    slot with the correct state near that time.)
 *
 * 2. Compute delta = resync.syncedAtIso - slot.startIso
 *    (can be negative if the real transition was earlier than predicted)
 *
 * 3. Apply delta to the matched slot AND every subsequent slot uniformly.
 *    Slots before the matched slot are untouched.
 *
 * 4. Mark the matched slot as isResynced = true for visual decoration.
 *
 * This ensures:
 * - The schedule never ends after a resync (Issue #3).
 * - All future cycles shift together, preserving master durations (Issue #1).
 * - Community priority > Growatt because the delta is reapplied on every
 *   master update (Issue #2 priority rule).
 */
function applyCommunityDelta(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
): ShiftedScheduleSlot[] {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  const syncState = resync.syncedState;
  const LOOKAHEAD_MS = 90 * 60_000; // look 90 min ahead/behind for the slot

  // Find the best matching slot index
  let matchIdx = -1;

  // First pass: find slot that actually contains the sync time
  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== syncState) continue;
    const sMs = new Date(s.startIso).getTime();
    const eMs = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= sMs - LOOKAHEAD_MS && syncMs < eMs + LOOKAHEAD_MS) {
      matchIdx = i;
      break;
    }
  }

  // Second pass: if not found, use the first future slot with the right state
  if (matchIdx === -1) {
    const nowMs = Date.now();
    for (let i = 0; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state !== syncState) continue;
      const sMs = new Date(offsetSlots[i].startIso).getTime();
      if (sMs >= nowMs - LOOKAHEAD_MS) {
        matchIdx = i;
        break;
      }
    }
  }

  // No match — return unchanged (community sync can't be applied safely)
  if (matchIdx === -1) return offsetSlots;

  const matchedSlotStartMs = new Date(offsetSlots[matchIdx].startIso).getTime();
  const deltaMs = syncMs - matchedSlotStartMs;

  return offsetSlots.map((slot, idx) => {
    if (idx < matchIdx) return slot; // earlier slots unchanged

    const newStartIso = shiftMs(slot.startIso, deltaMs);
    const newEndIso = slot.endIso ? shiftMs(slot.endIso, deltaMs) : null;
    return {
      ...slot,
      startIso: newStartIso,
      endIso: newEndIso,
      startFormatted: fmtYemenTime(newStartIso),
      endFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      shiftedStartFormatted: fmtYemenTime(newStartIso),
      shiftedEndFormatted: newEndIso ? fmtYemenTime(newEndIso) : null,
      isResynced: idx === matchIdx,
    };
  });
}

// ── ATC Decision Engine ───────────────────────────────────────────────────────
/**
 * Determines whether the schedule should hold its current state or proceed
 * to the next slot, and which ATC mode applies.
 *
 * Rules:
 * 1. Community Sync always wins — mode = COMMUNITY_SYNCED, no hold
 * 2. Inside prediction range → PREDICTION_RANGE (no transition yet)
 * 3. Past prediction range end:
 *    - Negative offset (< 0):  enter UNCERTAIN_ZONE immediately
 *    - Positive offset (> 0):  enter WAITING_FOR_GROWATT
 *    - Neutral offset (= 0):   15-min grace period, then UNCERTAIN_ZONE
 * 4. Before prediction range → NORMAL
 */
function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
): ATCState {
  const nowMs = Date.now();

  // ── Community Sync shortcut ────────────────────────────────────────────────
  if (resyncPoint) {
    return {
      mode: 'COMMUNITY_SYNCED',
      overrunMinutes: 0,
      communityElevated: false,
      statusLine: null,
    };
  }

  // ── Find the active (current) slot ────────────────────────────────────────
  let activeSlot: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) {
      activeSlot = slot;
      break;
    }
  }

  if (!activeSlot || !activeSlot.endIso) {
    // No active slot or open-ended → normal
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null };
  }

  const slotEndMs = new Date(activeSlot.endIso).getTime();
  const expectedMaxMin = prediction.isUnstable ? 0 : (() => {
    // Use the prediction's expected max duration for the next transition
    // as a proxy for the end of the "safe" window
    if (prediction.nextTransition) {
      return prediction.nextTransition.maxFromNowMin;
    }
    return 0;
  })();

  // Build a nominal "range" around the slot end.
  // We define the range as ±halfSpread around the predicted slot end.
  const halfSpreadMs = 15 * 60_000; // default 15 minutes
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs   = slotEndMs + halfSpreadMs;
  const overrunMs = Math.max(0, nowMs - rangeEndMs);
  const overrunMin = overrunMs / 60_000;

  // ── Before range start → NORMAL ───────────────────────────────────────────
  if (nowMs < rangeStartMs) {
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null };
  }

  // ── Inside range → PREDICTION_RANGE ───────────────────────────────────────
  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
    return {
      mode: 'PREDICTION_RANGE',
      overrunMinutes: 0,
      communityElevated: false,
      statusLine: 'نطاق التوقع نشط — التغيير محتمل',
    };
  }

  // ── Past range end — decide based on offset ────────────────────────────────
  const GRACE_PERIOD_MS = 15 * 60_000; // 15 minutes grace for neutral offset

  if (offsetMinutes < 0) {
    // Negative offset: enter UNCERTAIN_ZONE immediately after range ends
    return {
      mode: 'UNCERTAIN_ZONE',
      overrunMinutes: overrunMin,
      communityElevated: true,
      statusLine: 'استمرار غير معتاد — بانتظار تأكيد تغير الحالة',
    };
  }

  if (offsetMinutes > 0) {
    // Positive offset: Growatt already transitioned — wait for Growatt confirmation
    return {
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMin,
      communityElevated: true,
      statusLine: 'بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي',
    };
  }

  // Neutral offset (= 0): 15-min grace, then UNCERTAIN_ZONE
  if (overrunMs <= GRACE_PERIOD_MS) {
    return {
      mode: 'PREDICTION_RANGE',  // still in extended grace window
      overrunMinutes: overrunMin,
      communityElevated: false,
      statusLine: 'تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع',
    };
  }

  return {
    mode: 'UNCERTAIN_ZONE',
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: 'النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة',
  };
}

/**
 * ATC Hold Decision
 *
 * Returns true when the schedule should NOT automatically advance to the
 * next slot. The current state is "held" until an external signal arrives
 * (Community Sync, Growatt update, or user report).
 *
 * ATC holds when:
 * - mode is UNCERTAIN_ZONE
 * - mode is WAITING_FOR_GROWATT
 * - mode is PREDICTION_RANGE (transition not yet confirmed)
 *
 * ATC does NOT hold when:
 * - mode is NORMAL
 * - mode is COMMUNITY_SYNCED (community already handled it)
 */
function atcShouldHold(mode: ScheduleStateMode): boolean {
  return mode === 'UNCERTAIN_ZONE' || mode === 'WAITING_FOR_GROWATT' || mode === 'PREDICTION_RANGE';
}

// ── Step 4: Determine next transition from effective schedule ─────────────────
function deriveNextTransition(
  effectiveSlots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  prediction: Prediction,
  offsetMinutes: number,
): ShiftedTransition | null {
  const nowMs = Date.now();
  const oppositeState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';

  for (const slot of effectiveSlots) {
    if (slot.state !== oppositeState) continue;
    const slotMs = new Date(slot.startIso).getTime();
    if (slotMs <= nowMs) continue; // already past

    const minFromNow = (slotMs - nowMs) / 60_000;

    // Spread: half of the original prediction uncertainty, minimum 10 min
    let halfSpread = 15;
    if (prediction.nextTransition) {
      halfSpread = Math.max(
        10,
        (prediction.nextTransition.maxFromNowMin - prediction.nextTransition.minFromNowMin) / 2,
      );
    }

    const minMin = Math.max(0, minFromNow - halfSpread);
    const maxMin = Math.max(0, minFromNow + halfSpread);

    const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    const latestIso = shiftMs(slot.startIso, halfSpread * 60_000);

    return {
      type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
    };
  }

  return null;
}

// ── Step 5: Determine current state from effective schedule (legacy, unused) ──
function deriveCurrentState(
  effectiveSlots: ShiftedScheduleSlot[],
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; label: string } {
  // If there's an active resync, the current state IS the resynced state
  if (resyncPoint) {
    const syncedAtMs = new Date(resyncPoint.syncedAtIso).getTime();
    const elapsedMin = (Date.now() - syncedAtMs) / 60_000;
    const elapsedMin2 = Math.round(elapsedMin);
    const elapsedH = Math.floor(elapsedMin2 / 60);
    const elapsedM = elapsedMin2 % 60;
    const elapsedLabel =
      elapsedH === 0 ? `${elapsedMin2}د`
      : elapsedM === 0 ? `${elapsedH}س`
      : `${elapsedH}س ${elapsedM}د`;
    return {
      state: resyncPoint.syncedState,
      label: `${elapsedLabel} (مزامنة مجتمعية)`,
    };
  }

  // Otherwise derive from the effective schedule
  const nowMs = Date.now();
  for (let i = effectiveSlots.length - 1; i >= 0; i--) {
    const slot = effectiveSlots[i];
    const startMs = new Date(slot.startIso).getTime();
    if (startMs <= nowMs) {
      const elapsedMin = (nowMs - startMs) / 60_000;
      const eH = Math.floor(elapsedMin / 60);
      const eM = Math.round(elapsedMin % 60);
      const label = eH === 0 ? `${Math.round(elapsedMin)}د`
        : eM === 0 ? `${eH}س`
        : `${eH}س ${eM}د`;
      return { state: slot.state, label };
    }
  }

  // Fallback to master prediction
  return { state: masterCurrentState, label: '' };
}

// ── Full pipeline ─────────────────────────────────────────────────────────────

/**
 * ATC-aware current state derivation
 *
 * When ATC is holding the current state (UNCERTAIN_ZONE, WAITING_FOR_GROWATT,
 * PREDICTION_RANGE), we do NOT advance to the next slot even if its startIso
 * has passed. Instead we remain in the previous slot's state.
 */
function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
): { state: 'ON' | 'OFF'; label: string } {
  if (resyncPoint) {
    const syncedAtMs = new Date(resyncPoint.syncedAtIso).getTime();
    const elapsedMin = Math.round((Date.now() - syncedAtMs) / 60_000);
    const eH = Math.floor(elapsedMin / 60);
    const eM = elapsedMin % 60;
    const elapsedLabel = eH === 0 ? `${elapsedMin}د`
      : eM === 0 ? `${eH}س`
      : `${eH}س ${eM}د`;
    return { state: resyncPoint.syncedState, label: `${elapsedLabel} (مزامنة مجتمعية)` };
  }

  const nowMs = Date.now();
  const holding = atcShouldHold(atcMode);

  if (holding) {
    // ATC hold: find the last slot that started before now
    // and return it regardless of whether its endIso has passed
    let bestSlot: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const startMs = new Date(slot.startIso).getTime();
      if (startMs <= nowMs) {
        bestSlot = slot;
      } else {
        break;
      }
    }
    if (bestSlot) {
      const elapsedMin = Math.round((nowMs - new Date(bestSlot.startIso).getTime()) / 60_000);
      const eH = Math.floor(elapsedMin / 60);
      const eM = elapsedMin % 60;
      const label = eH === 0 ? `${Math.round(elapsedMin)}د`
        : eM === 0 ? `${eH}س`
        : `${eH}س ${eM}د`;
      return { state: bestSlot.state, label };
    }
  }

  // Normal (no hold): return the slot that contains now
  for (let i = effectiveSlots.length - 1; i >= 0; i--) {
    const slot = effectiveSlots[i];
    const startMs = new Date(slot.startIso).getTime();
    if (startMs <= nowMs) {
      const elapsedMin = (nowMs - startMs) / 60_000;
      const eH = Math.floor(elapsedMin / 60);
      const eM = Math.round(elapsedMin % 60);
      const label = eH === 0 ? `${Math.round(elapsedMin)}د`
        : eM === 0 ? `${eH}س`
        : `${eH}س ${eM}د`;
      return { state: slot.state, label };
    }
  }

  return { state: masterCurrentState, label: '' };
}

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  // Step 1: Extend master schedule to 48h
  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction);

  // Step 2: Shift all slots by user offset
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  // Step 3: Apply community sync delta (if active)
  const hasResync = !!resyncPoint;
  if (resyncPoint) {
    effectiveSlots = applyCommunityDelta(effectiveSlots, resyncPoint);
  }

  // Step 4: Compute ATC state (before deriving current state)
  const atcState = computeATCState(effectiveSlots, offsetMinutes, resyncPoint ?? null, prediction);

  // Step 5: Derive ATC-aware current state
  const { state: currentState, label: currentStateDurationLabel } =
    deriveCurrentStateATC(effectiveSlots, atcState.mode, prediction.currentState, resyncPoint ?? null);

  // Step 6: Derive next transition from effective schedule
  // When ATC is holding, next transition comes from the NEXT slot after the currently-held slot
  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction, offsetMinutes);

  const isHolding = atcShouldHold(atcState.mode);

  return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange?.label ?? null,
    expectedOnDurationLabel: prediction.expectedOnRange?.label ?? null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState,
    currentStateDurationLabel,
    daySchedule: effectiveSlots,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    atc: atcState,
    isHoldingState: isHolding,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error('[useUserPredictions] fetch error:', error.message);
        if (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });

    // Timeout fallback — don't hang forever
    const timeout = setTimeout(() => {
      if (cancelled) return;
      setLoading(false);
    }, 8000);

    const channel = supabase
      .channel(`user_predictions_live_${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'utility_predictions',
      }, (payload) => {
        const row = payload.new as any;
        if (row?.prediction) setRawPrediction(row.prediction as Prediction);
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      supabase.removeChannel(channel);
    };
  }, []);

  const userPrediction: UserPrediction | null = rawPrediction
    ? applyOffsetToPrediction(rawPrediction, offsetMinutes, resyncPoint)
    : null;

  return { userPrediction, rawPrediction, loading };
}
