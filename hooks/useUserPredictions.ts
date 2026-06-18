/**
 * useUserPredictions — Layered Scheduling Engine
 *
 * Formula:
 *   Effective User Timeline
 *     = Master Pattern (from utility_predictions)
 *     + User Offset
 *     + Growatt Adjustments (auto-applied via master update)
 *     + Community Sync Adjustments
 *     + ATC Decision Layer
 *
 * ─────────────────────────────────────────────────────────────────────
 * THREE-USER MODEL (spec §OFFSET BEHAVIOR):
 *
 * User A (offset < 0 — AHEAD of Growatt):
 *   - Reaches predicted cycle end BEFORE Growatt.
 *   - Enters UNCERTAIN_ZONE at predicted end.
 *   - Stays there until: user report | community confirm | Growatt flip.
 *   - On Growatt flip: immediately exits, backdates start:
 *       UserCycleStart = GrowattTransitionTime + Offset   (< GrowattTime)
 *   - "منذ" shows elapsed since UserCycleStart, never "للتو".
 *
 * User B (offset > 0 — BEHIND Growatt):
 *   - When Growatt flips, compute scheduledTransitionIso:
 *       scheduledTransitionIso = GrowattTransitionTime + positiveOffset
 *   - Show countdown banner: "سيتم تغيير حالتك تلقائياً عند الساعة [HH:MM]"
 *   - At scheduledTransitionIso: auto-transition, elapsed starts at that time.
 *   - WAITING_FOR_GROWATT only fires if scheduledTransitionIso has passed
 *     and the slot still hasn't activated (should be very rare).
 *
 * User C (offset = 0 — NEUTRAL):
 *   - Transitions with Growatt.
 *   - Brief GRACE_MODE (15 min) before WAITING_FOR_GROWATT if late.
 * ─────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Prediction, ScheduleSlot } from './usePredictions';
import { ResyncPoint } from '../contexts/ResyncContext';

// ── Client-side accuracy logger ───────────────────────────────────────────────
// Called when exiting UNCERTAIN_ZONE (User A) or POSITIVE_OFFSET_PENDING (User B)
// via reconciliation. Logs predicted vs actual transition time to DB.
// Non-blocking: errors are swallowed so UI is never affected.
async function logClientAccuracy(
  predictedTransitionIso: string,
  actualTransitionIso: string,
  targetState: 'ON' | 'OFF',
  offsetMinutes: number,
  exitMode: 'UNCERTAIN_ZONE' | 'POSITIVE_OFFSET_PENDING',
): Promise<void> {
  try {
    const MAX_ALLOWED_ERROR_MIN = 150;
    const predictedMs  = new Date(predictedTransitionIso).getTime();
    const actualMs     = new Date(actualTransitionIso).getTime();
    const errorMin     = Math.abs((actualMs - predictedMs) / 60_000);
    const accuracyScore = Math.max(0, 100 - (errorMin / MAX_ALLOWED_ERROR_MIN) * 100);
    const eventType    = targetState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF';
    const slotId       = `client_${exitMode.toLowerCase()}_offset${offsetMinutes}`;

    await supabase.from('prediction_accuracy_logs').insert({
      predicted_event_time:    predictedTransitionIso,
      actual_event_time:       actualTransitionIso,
      predicted_state:         eventType,
      actual_state:            eventType,
      error_minutes:           Math.round(errorMin * 100) / 100,
      accuracy_score:          Math.round(accuracyScore * 100) / 100,
      confidence_score:        null,
      prediction_generated_at: null,
      slot_id:                 slotId,
    });
    console.log(`[useUserPredictions] Accuracy logged (${exitMode}): offset=${offsetMinutes}min error=${errorMin.toFixed(1)}min score=${accuracyScore.toFixed(1)}%`);
  } catch (err) {
    // Non-fatal
    console.warn('[useUserPredictions] Accuracy log failed:', err);
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING'; // User B: Growatt already changed, countdown to user's scheduled time

/** TMMS transition authority modes (spec: TRANSITION MODES) */
export type TransitionMode = 'AUTO' | 'MANUAL';

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  communityElevated: boolean;
  statusLine: string | null;
  /** True when Growatt changed state but validation window is still active */
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  /** TMMS: active transition authority mode */
  transitionMode: TransitionMode;
  /**
   * User B (+offset): ISO of the exact scheduled auto-transition time.
   * = GrowattTransitionTime + positiveOffset
   * Shown as countdown banner on Home screen.
   * Null for all other modes / users.
   */
  scheduledAutoTransitionIso: string | null;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  syncedState: 'ON' | 'OFF';
}

export interface ShiftedTransition {
  type: 'UTILITY_ON' | 'UTILITY_OFF';
  /** Formatted range — e.g. "7:00 م → 8:03 م" */
  rangeLabel: string;
  /** ISO strings for the range start and end */
  rangeStartIso: string;
  rangeEndIso: string;
  minFromNowMin: number;
  maxFromNowMin: number;
  waitLabel: string;
  /** True if current time has entered the prediction range window */
  inRangeWindow: boolean;
}

export interface ShiftedScheduleSlot extends ScheduleSlot {
  // Core ScheduleSlot properties re-declared for standalone type-checking.
  // In the full project these come from ScheduleSlot via the import above;
  // the re-declaration is a no-op at runtime but lets tsc resolve them
  // when ./usePredictions cannot be found (e.g. CI without node_modules).
  state: 'ON' | 'OFF';
  startIso: string;
  endIso?: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string;
  zone: string;
  isEstimated?: boolean;
  // ShiftedScheduleSlot-only additions
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

export interface UserPrediction {
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
  /** ISO of when the current state started (for elapsed timer) */
  currentStateStartIso: string | null;
  daySchedule: ShiftedScheduleSlot[];
  reasoning: string[];
  learningMode: string;
  computedAt: string | null;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;
  isResynced: boolean;
  resyncedAtIso: string | null;
  isHoldingState: boolean;
  communitySyncMeta: CommunitySyncMeta | null;
  /**
   * TMMS Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE):
   * When exiting UNCERTAIN_ZONE via Growatt confirmation, the next cycle
   * start is backdated to: GrowattTransitionTime + Offset.
   * This ISO is that backdated start so the elapsed timer shows the correct
   * time already elapsed, not "للتو".
   */
  reconciledCycleStartIso: string | null;
  /**
   * TMMS V2 — populated whenever a Community Report / Confirmation produced a
   * schedule-based generated cycle.  null when no resync point is active.
   * Exposed for UI display (offset badge, progress %, generated-cycle countdown)
   * and for debug screens.
   */
  communityTransitionMeta: {
    /** POSITIVE (progress<50%) | NEGATIVE (progress>50%) | NEUTRAL (exact match) */
    offsetType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    /** Exact ratio — elapsedMs / plannedDurationMs, never rounded */
    progressRatio: number;
    /** ISO — when the generated cycle started (= syncedAtIso) */
    generatedCycleStartIso: string;
    /** ISO — when the generated cycle ends (= syncedAtIso + schedule duration) */
    generatedCycleEndIso: string;
    /** The community-confirmed state that was assigned to the generated cycle */
    generatedCycleState: 'ON' | 'OFF';
    /** True while now < generatedCycleEndIso */
    generatedCycleActive: boolean;
  } | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

// Western numerals + Arabic AM/PM suffix, LTR (spec §20)
function fmtYemenTime(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return raw.replace('AM', 'ص').replace('PM', 'م');
}

function getZoneFromIso(iso: string): string {
  const h = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000).getUTCHours();
  if (h < 6) return 'Night';
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

const EMPTY_ATC: ATCState = {
  mode: 'NORMAL',
  overrunMinutes: 0,
  communityElevated: false,
  statusLine: null,
  inValidationWindow: false,
  validationWindowRemainingMin: 0,
  transitionMode: 'AUTO',
  scheduledAutoTransitionIso: null,
};

// ── Step 1: Extend master schedule to 48h ────────────────────────────────────
function extendScheduleTo48h(masterSlots: ScheduleSlot[], prediction: Prediction): ScheduleSlot[] {
  if (masterSlots.length === 0) return [];

  let realOnMin: number | null = null;
  let realOffMin: number | null = null;

  for (let i = masterSlots.length - 1; i >= 0; i--) {
    const s = masterSlots[i];
    if (!s.endIso) continue;
    const durMin = (new Date(s.endIso).getTime() - new Date(s.startIso).getTime()) / 60_000;
    if (durMin < 5) continue;
    if (s.state === 'ON' && realOnMin === null) realOnMin = durMin;
    if (s.state === 'OFF' && realOffMin === null) realOffMin = durMin;
    if (realOnMin !== null && realOffMin !== null) break;
  }

  const extOnMin  = realOnMin  ?? prediction.expectedOnRange?.minMin  ?? prediction.allPattern?.avgOnMin  ?? prediction.dayPattern?.avgOnMin  ?? 120;
  const extOffMin = realOffMin ?? prediction.expectedOffRange?.minMin ?? prediction.allPattern?.avgOffMin ?? prediction.dayPattern?.avgOffMin ?? 360;

  const horizonMs = Date.now() + 48 * 60 * 60 * 1000;
  const slots: ScheduleSlot[] = [...masterSlots];

  while (slots.length < 40) {
    const last = slots[slots.length - 1];
    if (!last.endIso) break;
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

// ── Step 2: Apply offset ──────────────────────────────────────────────────────
function applyOffsetToSlots(slots: ScheduleSlot[], offsetMs: number): ShiftedScheduleSlot[] {
  return slots.map((slot) => {
    const startIso = shiftMs(slot.startIso, offsetMs);
    const endIso = slot.endIso ? shiftMs(slot.endIso, offsetMs) : null;
    return {
      ...slot,
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

// ── TMMS V2: Schedule-Based Community Transition ──────────────────────────────
//
// Replaces the old applyCommunityDelta (which merely shifted schedule timestamps).
//
// When a trusted Community Confirmation or User Report fires, this function
// executes the full 8-step algorithm from the TMMS V2 specification:
//
//   Step 1  End the interrupted cycle at syncedAtIso.
//   Step 2  Start the confirmed state immediately at syncedAtIso.
//   Step 3  Calculate exact progress ratio (ms precision, never rounded).
//   Step 4  Classify offset: NEGATIVE (>50%), POSITIVE (<50%), NEUTRAL (exact match).
//   Step 5  Select new-cycle duration from the schedule:
//             POSITIVE → nearest matching slot BEFORE interrupted cycle
//             NEGATIVE → nearest matching slot AFTER interrupted cycle
//             NEUTRAL  → nearest matching slot AFTER interrupted cycle
//   Step 6  Build a full independent new cycle starting at syncedAtIso.
//   Step 7  Rebuild schedule continuation via logical sequence (not clock-based).
//   Step 8  After the generated cycle ends, apply existing offset rules via
//           derivedOffsetMinutes passed to computeATCState.
//
interface CommunityTransitionResult {
  /** Rebuilt slots: pre-interruption + generated cycle + logical continuation */
  effectiveSlots: ShiftedScheduleSlot[];
  /** syncedAtIso — when the generated cycle starts */
  generatedCycleStartIso: string;
  /** syncedAtIso + selectedDuration — when the generated cycle ends */
  generatedCycleEndIso: string;
  /** The confirmed new state (= resync.syncedState) */
  generatedCycleState: 'ON' | 'OFF';
  /** POSITIVE (progress<50%), NEGATIVE (progress>50%), or NEUTRAL (exact match) */
  offsetType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  /**
   * Exact ratio — never rounded. Uses full millisecond precision.
   * elapsedMs / plannedDurationMs
   */
  progressRatio: number;
  /**
   * Effective offsetMinutes for ATC logic AFTER the generated cycle ends:
   *   NEGATIVE → -1  → UNCERTAIN_ZONE path (User A)
   *   POSITIVE →  0  → GRACE_MODE / short verification window (User C)
   *   NEUTRAL  →  0  → standard neutral path (User C)
   */
  derivedOffsetMinutes: number;
}

function computeCommunityTransition(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
): CommunityTransitionResult | null {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  // Guard: confirmations must be from the past (or present)
  if (syncMs > Date.now() + 60_000) return null;

  const syncState: 'ON' | 'OFF'        = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';

  // ── Step 1: Locate the interrupted cycle ──────────────────────────────────
  // Find the slot that was active at syncMs whose state is interruptedState.
  let interruptedSlotIdx = -1;
  for (let i = 0; i < offsetSlots.length; i++) {
    const s = offsetSlots[i];
    if (s.state !== interruptedState) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    if (syncMs >= startMs && syncMs <= endMs) {
      interruptedSlotIdx = i;
      break;
    }
  }
  // Fallback: most recently started interruptedState slot before syncMs
  if (interruptedSlotIdx === -1) {
    for (let i = offsetSlots.length - 1; i >= 0; i--) {
      if (offsetSlots[i].state !== interruptedState) continue;
      if (new Date(offsetSlots[i].startIso).getTime() <= syncMs) {
        interruptedSlotIdx = i;
        break;
      }
    }
  }
  if (interruptedSlotIdx === -1) return null;

  const interruptedSlot = offsetSlots[interruptedSlotIdx];
  if (!interruptedSlot.endIso) return null;

  // ── Step 3: Exact progress ratio (ms precision, no rounding) ─────────────
  const cycleStartMs      = new Date(interruptedSlot.startIso).getTime();
  const cyclePlannedEndMs = new Date(interruptedSlot.endIso).getTime();
  const plannedDurationMs = cyclePlannedEndMs - cycleStartMs;
  if (plannedDurationMs <= 0) return null;

  const elapsedMs    = syncMs - cycleStartMs;
  const progressRatio = elapsedMs / plannedDurationMs; // exact — never rounded

  // ── Step 4: Classify offset type ─────────────────────────────────────────
  // Neutral ONLY when expected transition timestamp === actual confirmation
  // (within 1 second tolerance for clock precision).
  // Positive / Negative are strictly derived from the progress ratio in ms.
  const isNeutral = Math.abs(syncMs - cyclePlannedEndMs) < 1_000;
  let offsetType: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  if (isNeutral) {
    offsetType = 'NEUTRAL';
  } else if (progressRatio > 0.5) {
    offsetType = 'NEGATIVE'; // > 50% consumed → behind schedule
  } else {
    offsetType = 'POSITIVE'; // < 50% consumed → ahead of schedule
  }

  // ── Step 5: Select new-cycle duration from the schedule ──────────────────
  // POSITIVE: nearest syncState slot BEFORE the interrupted slot
  // NEGATIVE / NEUTRAL: nearest syncState slot AFTER the interrupted slot
  let durationSourceIdx = -1;

  if (offsetType === 'POSITIVE') {
    for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
        durationSourceIdx = i; break;
      }
    }
    // Fallback: look after if nothing before
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
          durationSourceIdx = i; break;
        }
      }
    }
  } else {
    // NEGATIVE or NEUTRAL
    for (let i = interruptedSlotIdx + 1; i < offsetSlots.length; i++) {
      if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
        durationSourceIdx = i; break;
      }
    }
    // Fallback: look before if nothing after
    if (durationSourceIdx === -1) {
      for (let i = interruptedSlotIdx - 1; i >= 0; i--) {
        if (offsetSlots[i].state === syncState && offsetSlots[i].endIso) {
          durationSourceIdx = i; break;
        }
      }
    }
  }

  // Duration from source slot (never invented, never predicted-based)
  let selectedDurationMs: number;
  if (durationSourceIdx !== -1 && offsetSlots[durationSourceIdx].endIso) {
    const src = offsetSlots[durationSourceIdx];
    selectedDurationMs =
      new Date(src.endIso!).getTime() - new Date(src.startIso).getTime();
  } else {
    // Last-resort fallback: use the interrupted cycle's own planned duration
    selectedDurationMs = plannedDurationMs;
  }

  // ── Step 6: Build the full independent generated cycle ────────────────────
  // Never re-uses schedule timestamps. Never uses remaining time.
  // Always a brand-new cycle: start = syncedAtIso, end = syncedAtIso + selectedDuration.
  const generatedCycleStartIso = resync.syncedAtIso;
  const generatedCycleEndMs    = syncMs + selectedDurationMs;
  const generatedCycleEndIso   = new Date(generatedCycleEndMs).toISOString();

  const generatedSlot: ShiftedScheduleSlot = {
    state:                 syncState,
    startIso:              generatedCycleStartIso,
    endIso:                generatedCycleEndIso,
    startFormatted:        fmtYemenTime(generatedCycleStartIso),
    endFormatted:          fmtYemenTime(generatedCycleEndIso),
    shiftedStartFormatted: fmtYemenTime(generatedCycleStartIso),
    shiftedEndFormatted:   fmtYemenTime(generatedCycleEndIso),
    durationLabel:         durationLabelFromMin(Math.round(selectedDurationMs / 60_000)),
    zone:                  getZoneFromIso(generatedCycleStartIso),
    isEstimated:           false,
    isResynced:            true,
  };

  // ── Step 7: Rebuild logical schedule continuation ─────────────────────────
  // Do NOT search for nearest clock-based entry.
  // Continue from the slot AFTER the duration source, using those slot durations
  // in sequence. Each new slot starts exactly where the previous one ends.
  //
  // Fallback durations for when source slots run out (from existing schedule)
  let fallbackOnMs  = 120 * 60_000;
  let fallbackOffMs = 360 * 60_000;
  for (const s of offsetSlots) {
    if (!s.endIso) continue;
    const d = new Date(s.endIso).getTime() - new Date(s.startIso).getTime();
    if (d < 5 * 60_000) continue;
    if (s.state === 'ON')  fallbackOnMs  = d;
    else                   fallbackOffMs = d;
  }

  const continuationStartIdx = durationSourceIdx !== -1 ? durationSourceIdx + 1 : interruptedSlotIdx + 1;
  const horizonMs = Date.now() + 48 * 60 * 60 * 1000;
  const continuationSlots: ShiftedScheduleSlot[] = [];
  let currentStartMs = generatedCycleEndMs;
  let srcIdx         = continuationStartIdx;

  while (currentStartMs < horizonMs && continuationSlots.length < 24) {
    let slotDurationMs: number;
    let slotState: 'ON' | 'OFF';

    if (srcIdx < offsetSlots.length) {
      const src = offsetSlots[srcIdx];
      if (!src.endIso) { srcIdx++; continue; }
      slotDurationMs = new Date(src.endIso).getTime() - new Date(src.startIso).getTime();
      if (slotDurationMs <= 0) { srcIdx++; continue; }
      slotState = src.state;
    } else {
      // Extend with alternating pattern using last-known durations
      const lastState = continuationSlots.length > 0
        ? continuationSlots[continuationSlots.length - 1].state
        : syncState;
      slotState      = lastState === 'ON' ? 'OFF' : 'ON';
      slotDurationMs = slotState === 'ON' ? fallbackOnMs : fallbackOffMs;
    }

    const slotStartIso = new Date(currentStartMs).toISOString();
    const slotEndMs    = currentStartMs + slotDurationMs;
    const slotEndIso   = new Date(slotEndMs).toISOString();

    continuationSlots.push({
      state:                 slotState,
      startIso:              slotStartIso,
      endIso:                slotEndIso,
      startFormatted:        fmtYemenTime(slotStartIso),
      endFormatted:          fmtYemenTime(slotEndIso),
      shiftedStartFormatted: fmtYemenTime(slotStartIso),
      shiftedEndFormatted:   fmtYemenTime(slotEndIso),
      durationLabel:         durationLabelFromMin(Math.round(slotDurationMs / 60_000)),
      zone:                  getZoneFromIso(slotStartIso),
      isEstimated:           srcIdx >= offsetSlots.length,
      isResynced:            false,
    });

    currentStartMs = slotEndMs;
    srcIdx++;
  }

  // Keep all slots that occurred before the interrupted cycle unchanged.
  const preCycleSlots = offsetSlots.slice(0, interruptedSlotIdx);

  // ── Step 8 (prep): Derived offset for post-cycle ATC ─────────────────────
  // NEGATIVE → -1 activates User A path → UNCERTAIN_ZONE after generated cycle ends
  // POSITIVE →  0 activates User C path → GRACE_MODE (short verification window)
  // NEUTRAL  →  0 activates User C path → standard neutral
  const derivedOffsetMinutes = offsetType === 'NEGATIVE' ? -1 : 0;

  return {
    effectiveSlots: [...preCycleSlots, generatedSlot, ...continuationSlots],
    generatedCycleStartIso,
    generatedCycleEndIso,
    generatedCycleState: syncState,
    offsetType,
    progressRatio,
    derivedOffsetMinutes,
  };
}

// ── Validation Window (20 min) — Growatt changed while sync is active ─────────
const VALIDATION_WINDOW_MS = 20 * 60_000;

// ── ATC Decision Engine ───────────────────────────────────────────────────────
//
// THREE-USER MODEL IMPLEMENTATION:
//
// User A (offsetMinutes < 0 — AHEAD of Growatt):
//   Scans for the most recently ended slot. If that slot's end has passed
//   AND Growatt has NOT yet confirmed the matching transition → UNCERTAIN_ZONE.
//   If Growatt HAS confirmed → still return UNCERTAIN_ZONE so that the exit
//   block in applyOffsetToPrediction can compute the backdated start.
//
// User B (offsetMinutes > 0 — BEHIND Growatt):
//   When Growatt has already flipped and the user's scheduled transition time
//   (= GrowattTransitionTime + positiveOffset) is still in the future:
//   → POSITIVE_OFFSET_PENDING with scheduledAutoTransitionIso set.
//   When scheduledTransitionIso has passed → NORMAL (schedule slot is now active).
//   If the slot somehow overruns past scheduledTransitionIso + 15min → WAITING_FOR_GROWATT.
//
// User C (offsetMinutes = 0 — NEUTRAL):
//   Transitions with Growatt. Brief GRACE_MODE (15 min) then WAITING_FOR_GROWATT.
//
function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = 'AUTO',
  // ── TMMS V2: community transition result from computeCommunityTransition ──
  communityTransition?: CommunityTransitionResult | null,
): ATCState {
  const nowMs = Date.now();

  // ── Community Sync path (TMMS V2) ─────────────────────────────────────────
  //
  // Two phases:
  //
  // Phase A — INSIDE generated cycle (nowMs < generatedCycleEndMs):
  //   Return COMMUNITY_SYNCED so the UI shows the community-confirmed state.
  //   Validation window (20 min) warns if Growatt disagrees.
  //
  // Phase B — AFTER generated cycle ends (nowMs >= generatedCycleEndMs):
  //   The generated cycle is now history.  Re-run ATC using derivedOffsetMinutes
  //   so the correct post-cycle behavior fires:
  //     NEGATIVE derivedOffset (-1) → User A path → UNCERTAIN_ZONE
  //     POSITIVE/NEUTRAL derivedOffset (0) → User C path → GRACE_MODE / NORMAL
  //
  if (resyncPoint && communityTransition) {
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();

    if (nowMs < generatedCycleEndMs) {
      // ── Phase A: inside generated cycle ───────────────────────────────────
      const syncedState    = resyncPoint.syncedState;
      const growattDiffers = (syncedState === 'ON') !== (prediction.currentState === 'ON');
      const syncAgeMs      = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
      const inValidationWindow      = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
      const validationRemainingMin  = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;

      return {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        communityElevated: inValidationWindow,
        statusLine: inValidationWindow
          ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
          : null,
        inValidationWindow,
        validationWindowRemainingMin: validationRemainingMin,
        transitionMode,
        scheduledAutoTransitionIso: null,
      };
    }

    // ── Phase B: generated cycle ended → apply derived offset ATC ─────────
    // Re-enter without resyncPoint/communityTransition so the standard
    // User A / User B / User C branches handle the post-cycle state.
    // derivedOffsetMinutes encodes the TMMS V2 offset classification:
    //   -1 → UNCERTAIN_ZONE (NEGATIVE),  0 → GRACE_MODE/NORMAL (POSITIVE/NEUTRAL)
    return computeATCState(
      effectiveSlots,
      communityTransition.derivedOffsetMinutes,
      null,            // skip community path → no infinite recursion
      prediction,
      transitionMode,
      null,            // no communityTransition → no recursion
    );
  }

  // ── Legacy: resyncPoint without a community transition object ─────────────
  // (backward compatibility — old resync points stored before TMMS V2)
  if (resyncPoint) {
    const syncedState    = resyncPoint.syncedState;
    const growattDiffers = (syncedState === 'ON') !== (prediction.currentState === 'ON');
    const syncAgeMs      = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
    const inValidationWindow     = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
    const validationRemainingMin = inValidationWindow ? (VALIDATION_WINDOW_MS - syncAgeMs) / 60_000 : 0;

    return {
      mode: 'COMMUNITY_SYNCED',
      overrunMinutes: 0,
      communityElevated: inValidationWindow,
      statusLine: inValidationWindow
        ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
        : null,
      inValidationWindow,
      validationWindowRemainingMin: validationRemainingMin,
      transitionMode,
      scheduledAutoTransitionIso: null,
    };
  }

  const halfSpreadMs = 15 * 60_000;
  const GRACE_PERIOD_MS = 15 * 60_000;

  // ── USER A: NEGATIVE OFFSET ────────────────────────────────────────────────
  //
  // The user reaches the predicted cycle end BEFORE Growatt does.
  // After the predicted end, the user MUST enter UNCERTAIN_ZONE until:
  //   Priority 1: User report
  //   Priority 2: Community confirmation
  //   Priority 3: Growatt state change (AUTO mode only)
  //
  // CRITICAL: We cannot rely on the "currently active slot" check because
  // after the old slot ends, the schedule advances to the NEW slot (new state).
  // We must check the MOST RECENTLY ENDED slot instead.
  //
  if (offsetMinutes < 0) {
    // Find the most recently ended slot (endIso is in the past)
    let justEndedSlot: ShiftedScheduleSlot | null = null;

    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      const endMs = new Date(s.endIso).getTime();
      if (endMs <= nowMs) {
        justEndedSlot = s;
      } else {
        break; // ordered slots — once future found, stop
      }
    }

    if (justEndedSlot && justEndedSlot.endIso) {
      const slotEndMs = new Date(justEndedSlot.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      const overrunMs    = Math.max(0, nowMs - rangeEndMs);
      const overrunMin   = overrunMs / 60_000;

      // Inside prediction range window of the just-ended slot
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return {
          ...EMPTY_ATC,
          mode: 'PREDICTION_RANGE',
          statusLine: 'نطاق التوقع نشط — التغيير محتمل',
          transitionMode,
        };
      }

      // Past the range end — check if Growatt confirmed
      //
      // Growatt confirmed = prediction.currentState has already flipped to the
      // expected new state AND prediction.lastTransitionAt ≥ rangeStartMs.
      // (The check uses rangeStartMs so we don't match stale unrelated events.)
      const expectedNewState: 'ON' | 'OFF' = justEndedSlot.state === 'ON' ? 'OFF' : 'ON';
      const growattAlreadyConfirmed =
        prediction.currentState === expectedNewState &&
        !!prediction.lastTransitionAt &&
        new Date(prediction.lastTransitionAt).getTime() >= rangeStartMs;

      if (nowMs > rangeStartMs) {
        // Whether Growatt confirmed or not, return UNCERTAIN_ZONE so that:
        // - deriveCurrentStateATC holds the OLD (just-ended) slot's state
        // - applyOffsetToPrediction's exit block fires when growattAlreadyConfirmed
        return {
          ...EMPTY_ATC,
          mode: 'UNCERTAIN_ZONE',
          overrunMinutes: overrunMin,
          communityElevated: !growattAlreadyConfirmed, // elevate community while waiting
          statusLine: growattAlreadyConfirmed
            ? null // reconciliation will handle this
            : overrunMin < 1
              ? 'نطاق التوقع انتهى — بانتظار تأكيد تغير الحالة'
              : `تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد`,
          transitionMode,
        };
      }
    }

    // No slot has ended yet — check currently active slot near its end
    let activeSlotNeg: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlotNeg = slot; break; }
    }
    if (activeSlotNeg?.endIso) {
      const slotEndMs   = new Date(activeSlotNeg.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };
      }
    }

    return { ...EMPTY_ATC, transitionMode };
  }

  // ── USER B: POSITIVE OFFSET ────────────────────────────────────────────────
  //
  // The user is BEHIND Growatt. When Growatt flips, we know exactly when the
  // user will transition: scheduledTransitionIso = GrowattTransitionTime + offset.
  //
  // States:
  //   1. Growatt has NOT yet flipped for the next cycle → NORMAL (schedule-driven)
  //   2. Growatt has flipped AND scheduledTransitionIso is in the future →
  //      POSITIVE_OFFSET_PENDING — show countdown banner
  //   3. scheduledTransitionIso has passed → NORMAL (shifted schedule slot is active)
  //   4. Shifted schedule slot somehow overruns by >15 min → WAITING_FOR_GROWATT
  //
  if (offsetMinutes > 0) {
    // Check if Growatt has already transitioned for the UPCOMING user cycle.
    // We detect this by seeing if prediction.currentState differs from the
    // state of the currently-active shifted slot.
    //
    // Find current shifted-schedule state (what the schedule says should be now)
    let activeSlotPos: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) { activeSlotPos = slot; break; }
    }

    // Find the slot that starts next (future)
    let nextSlotPos: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() > nowMs) { nextSlotPos = slot; break; }
    }

    // Determine what state the SCHEDULE says we are currently in
    const scheduleCurrentState = activeSlotPos?.state ?? (nextSlotPos ? (nextSlotPos.state === 'ON' ? 'OFF' : 'ON') : null);

    // Has Growatt already flipped to the opposite of our schedule's current state?
    const growattFlippedAhead =
      scheduleCurrentState !== null &&
      prediction.currentState !== scheduleCurrentState &&
      !!prediction.lastTransitionAt;

        if (growattFlippedAhead && transitionMode === 'AUTO') {
      // Compute the exact time the user will transition
      const offsetMs = offsetMinutes * 60_000;
      const scheduledMs = new Date(prediction.lastTransitionAt!).getTime() + offsetMs;
      const scheduledAutoTransitionIso = new Date(scheduledMs).toISOString();

      // Return POSITIVE_OFFSET_PENDING unconditionally so the exit block
      // in applyOffsetToPrediction can apply accurate reconciliation.
      return {
        ...EMPTY_ATC,
        mode: 'POSITIVE_OFFSET_PENDING',
        statusLine: scheduledMs > nowMs 
          ? ` سيتم   تغيير   حالتك   تلقائياً   في  ${fmtYemenTime(scheduledAutoTransitionIso)} ·  بعد  ${Math.round((scheduledMs - nowMs) / 60_000)} د ` 
          : null,
        scheduledAutoTransitionIso,
        transitionMode,
      };
    }


    // Normal active-slot check for positive offset
    if (!activeSlotPos || !activeSlotPos.endIso) {
      return { ...EMPTY_ATC, transitionMode };
    }

    const slotEndMs    = new Date(activeSlotPos.endIso).getTime();
    const rangeStartMs = slotEndMs - halfSpreadMs;
    const rangeEndMs   = slotEndMs + halfSpreadMs;
    const overrunMs    = Math.max(0, nowMs - rangeEndMs);
    const overrunMin   = overrunMs / 60_000;

    if (nowMs < rangeStartMs)                         return { ...EMPTY_ATC, transitionMode };
    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };

    // Overrun beyond range → WAITING_FOR_GROWATT
    return {
      ...EMPTY_ATC,
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMin,
      communityElevated: transitionMode === 'MANUAL',
      statusLine: transitionMode === 'MANUAL'
        ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي'
        : 'بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي',
      transitionMode,
    };
  }

  // ── USER C: NEUTRAL OFFSET (= 0) ──────────────────────────────────────────
  //
  // Transitions align with Growatt. GRACE_MODE (15 min) before WAITING_FOR_GROWATT.
  //
  let activeSlot: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    const start = new Date(slot.startIso).getTime();
    const end   = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    if (nowMs >= start && nowMs < end) { activeSlot = slot; break; }
  }

  if (!activeSlot?.endIso) return { ...EMPTY_ATC, transitionMode };

  const slotEndMs    = new Date(activeSlot.endIso).getTime();
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs   = slotEndMs + halfSpreadMs;
  const overrunMs    = Math.max(0, nowMs - rangeEndMs);
  const overrunMin   = overrunMs / 60_000;

  if (nowMs < rangeStartMs)                         return { ...EMPTY_ATC, transitionMode };
  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) return { ...EMPTY_ATC, mode: 'PREDICTION_RANGE', statusLine: 'نطاق التوقع نشط — التغيير محتمل', transitionMode };

  if (overrunMs <= GRACE_PERIOD_MS) {
    return {
      ...EMPTY_ATC,
      mode: 'GRACE_MODE',
      overrunMinutes: overrunMin,
      statusLine: 'تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع',
      transitionMode,
    };
  }

  return {
    ...EMPTY_ATC,
    mode: 'WAITING_FOR_GROWATT',
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: transitionMode === 'MANUAL'
      ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي لإنهاء الدورة'
      : 'النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة',
    transitionMode,
  };
}

function atcShouldHold(mode: ScheduleStateMode): boolean {
  return (
    mode === 'UNCERTAIN_ZONE' ||
    mode === 'WAITING_FOR_GROWATT' ||
    mode === 'PREDICTION_RANGE' ||
    mode === 'GRACE_MODE' ||
    mode === 'POSITIVE_OFFSET_PENDING'
  );
}

// ── Derive next transition ────────────────────────────────────────────────────
function deriveNextTransition(
  effectiveSlots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  prediction: Prediction,
): ShiftedTransition | null {
  const nowMs = Date.now();
  const oppositeState: 'ON' | 'OFF' = currentState === 'ON' ? 'OFF' : 'ON';

  for (const slot of effectiveSlots) {
    if (slot.state !== oppositeState) continue;
    const slotMs = new Date(slot.startIso).getTime();
    if (slotMs <= nowMs) continue;

    const minFromNow = (slotMs - nowMs) / 60_000;
    let halfSpread = 15;
    if (prediction.nextTransition) {
      halfSpread = Math.max(10, (prediction.nextTransition.maxFromNowMin - prediction.nextTransition.minFromNowMin) / 2);
    }

    const minMin      = Math.max(0, minFromNow - halfSpread);
    const maxMin      = Math.max(0, minFromNow + halfSpread);
    const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    const latestIso   = shiftMs(slot.startIso, halfSpread * 60_000);

    const rangeStartMs = new Date(earliestIso).getTime();
    const rangeEndMs   = new Date(latestIso).getTime();
    const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

    return {
      type: oppositeState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      rangeLabel: `${fmtYemenTime(earliestIso)} → ${fmtYemenTime(latestIso)}`,
      rangeStartIso: earliestIso,
      rangeEndIso: latestIso,
      minFromNowMin: minMin,
      maxFromNowMin: maxMin,
      waitLabel: `${fmtWait(minMin)} → ${fmtWait(maxMin)}`,
      inRangeWindow,
    };
  }

  return null;
}

// ── ATC-aware current state derivation ───────────────────────────────────────
//
// CRITICAL: For negative-offset users in UNCERTAIN_ZONE, the schedule may have
// advanced to the NEXT slot. We MUST hold the most-recently-ENDED slot's state,
// not the currently-starting slot's state.
//
// For User B in POSITIVE_OFFSET_PENDING: hold the current (pre-transition) state
// — the schedule's shifted new slot hasn't started yet (it starts at scheduledMs).
//
function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  // ── TMMS V2 ───────────────────────────────────────────────────────────────
  communityTransition?: CommunityTransitionResult | null,
): { state: 'ON' | 'OFF'; startIso: string | null } {
  // ── TMMS V2: Community Transition state derivation ─────────────────────────
  //
  // Phase A (inside generated cycle): return syncedState anchored at syncedAtIso.
  // Phase B (after generated cycle ends): fall through to normal ATC derivation
  //   so the rebuilt continuation schedule drives the displayed state.
  //
  if (resyncPoint && communityTransition) {
    const nowMs = Date.now();
    const generatedCycleEndMs = new Date(communityTransition.generatedCycleEndIso).getTime();

    if (nowMs < generatedCycleEndMs) {
      // Inside generated cycle — show the community-confirmed state
      return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
    }
    // After generated cycle — let the rebuilt schedule + ATC mode drive state below
  } else if (resyncPoint) {
    // Legacy path (no community transition object)
    return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  const nowMs = Date.now();

  const derivePreScheduleState = (): { state: 'ON' | 'OFF'; startIso: string | null } => {
    if (effectiveSlots.length > 0) {
      const preState: 'ON' | 'OFF' = effectiveSlots[0].state === 'ON' ? 'OFF' : 'ON';
      return { state: preState, startIso: null };
    }
    return { state: masterCurrentState, startIso: null };
  };

  if (atcShouldHold(atcMode)) {
    if (atcMode === 'UNCERTAIN_ZONE') {
      // NEGATIVE OFFSET HOLD: find the most recently ENDED slot.
      // That is the slot whose predicted end triggered UNCERTAIN_ZONE.
      // The NEXT slot (new state) may have already started in the schedule —
      // we ignore it until a valid exit condition fires.
      let heldSlot: ShiftedScheduleSlot | null = null;
      for (let i = 0; i < effectiveSlots.length; i++) {
        const s = effectiveSlots[i];
        if (!s.endIso) continue;
        const endMs = new Date(s.endIso).getTime();
        if (endMs <= nowMs) { heldSlot = s; }
        else { break; }
      }
      if (heldSlot) return { state: heldSlot.state, startIso: heldSlot.startIso };
      return derivePreScheduleState();
    }

    if (atcMode === 'POSITIVE_OFFSET_PENDING') {
      // User B: Growatt flipped ahead, but user's scheduled time is still future.
      // Hold the current (pre-transition) schedule state.
      let best: ShiftedScheduleSlot | null = null;
      for (const slot of effectiveSlots) {
        if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
        else break;
      }
      if (best) return { state: best.state, startIso: best.startIso };
      return derivePreScheduleState();
    }

    // WAITING_FOR_GROWATT / GRACE_MODE / PREDICTION_RANGE:
    // hold the last slot that started before now
    let best: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
      else break;
    }
    if (best) return { state: best.state, startIso: best.startIso };
    return derivePreScheduleState();
  }

  // Normal schedule-driven path
  let best: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
    else break;
  }
  if (best) return { state: best.state, startIso: best.startIso };
  return derivePreScheduleState();
}

// ── Human-friendly Arabic duration range label (spec §23) ────────────────────
function arabicDurationRange(minMin: number, maxMin: number): string {
  const fmtSingle = (min: number): string => {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (h === 0) return m === 1 ? 'دقيقة' : m === 2 ? 'دقيقتان' : `${m} دقيقة`;
    const hoursAr = h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
    if (m === 0) return hoursAr;
    return `${hoursAr} و ${m} دقيقة`;
  };
  if (Math.round(minMin) === Math.round(maxMin)) return fmtSingle(minMin);
  return `من ${fmtSingle(minMin)} إلى ${fmtSingle(maxMin)}`;
}

// ── Duration label from startIso ──────────────────────────────────────────────
function elapsedLabel(startIso: string | null): string {
  if (!startIso) return '';
  const elapsedMin = Math.round((Date.now() - new Date(startIso).getTime()) / 60_000);
  if (elapsedMin < 1) return 'للتو';
  const eH = Math.floor(elapsedMin / 60);
  const eM = elapsedMin % 60;
  if (eH === 0) return `${elapsedMin}د`;
  if (eM === 0) return `${eH}س`;
  return `${eH}س ${eM}د`;
}

// ── Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE) ──────────────────
//
// FORMULA:
//   UserCycleStartTime = GrowattTransitionTime + UserOffset
//
//   Negative offset (-60 min): GrowattTime=04:00 → UserStart=03:00 (in the past ✅)
//   Neutral offset (0):        GrowattTime=05:00 → UserStart=05:00 (in the past ✅)
//   Positive offset (+60 min): GrowattTime=05:00 → UserStart=06:00 (in the future ❌ → return null)
//     For positive offset the transition happens at scheduledMs via POSITIVE_OFFSET_PENDING
//     and then naturally via the shifted schedule slot becoming active.
//
function computeReconciledCycleStart(
  growattLastTransitionAt: string | null,
  offsetMs: number,
  heldState: 'ON' | 'OFF',
  masterCurrentState: 'ON' | 'OFF',
): string | null {
  if (heldState === masterCurrentState) return null;
  if (!growattLastTransitionAt) return null;

  const reconciledStartMs = new Date(growattLastTransitionAt).getTime() + offsetMs;
  // Only valid if the reconciled start is already in the past
  if (reconciledStartMs >= Date.now()) return null;

  return new Date(reconciledStartMs).toISOString();
}

// ── Main pipeline ─────────────────────────────────────────────────────────────
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  communitySyncMeta?: CommunitySyncMeta | null,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso?: string | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction);
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  const hasResync = !!resyncPoint;

  // ── TMMS V2: Run Schedule-Based Community Transition ──────────────────────
  //
  // computeCommunityTransition REPLACES applyCommunityDelta.
  // It executes the full 8-step algorithm:
  //   • Terminates the interrupted cycle at syncedAtIso
  //   • Classifies offset type via exact progress ratio (ms precision)
  //   • Selects a schedule-derived duration (never predicted / never invented)
  //   • Builds a full independent generated cycle
  //   • Rebuilds logical schedule continuation (never clock-based)
  //   • Returns derivedOffsetMinutes to drive post-cycle ATC behaviour
  //
  let communityTransition: CommunityTransitionResult | null = null;
  if (resyncPoint) {
    communityTransition = computeCommunityTransition(effectiveSlots, resyncPoint);
    if (communityTransition) {
      // Use the rebuilt schedule (generated cycle + logical continuation)
      effectiveSlots = communityTransition.effectiveSlots;
    }
    // If computeCommunityTransition returns null (edge case: no usable interrupted
    // slot found) we leave effectiveSlots as-is — no delta is applied.
  }

  // Pass communityTransition to both ATC and state derivation so each function
  // can distinguish "inside generated cycle" (COMMUNITY_SYNCED) from "after
  // generated cycle ended" (derived-offset ATC path).
  const atcState = computeATCState(
    effectiveSlots,
    offsetMinutes,
    resyncPoint ?? null,
    prediction,
    transitionMode,
    communityTransition,  // ← TMMS V2
  );

  let { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(
      effectiveSlots,
      atcState.mode,
      prediction.currentState,
      resyncPoint ?? null,
      transitionMode,
      communityTransition,  // ← TMMS V2
    );

  let isHolding = atcShouldHold(atcState.mode);
  let finalAtcState = atcState;
  let reconciledCycleStartIso: string | null = null;

  // ── USER A EXIT: UNCERTAIN_ZONE → Growatt confirmed (AUTO mode only) ──────
  //
  // Two sub-cases:
  //
  // A1. Standard negative-offset user (stored offsetMinutes < 0):
  //     BackdatedStart = GrowattTransitionTime + offsetMs
  //
  // A2. TMMS V2 community-derived negative offset (communityTransition present,
  //     offsetType === 'NEGATIVE', generated cycle has ended):
  //     BackdatedStart = generatedCycleEndIso
  //     Rationale: the user's next state started exactly when the generated
  //     cycle ended — that is the precise no-gap anchor, not GrowattTime+offset.
  //
  if (
    atcState.mode === 'UNCERTAIN_ZONE' &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState
  ) {
    // ── A2: community-derived negative offset ─────────────────────────────
    if (communityTransition && communityTransition.offsetType === 'NEGATIVE') {
      const generatedCycleEnd = communityTransition.generatedCycleEndIso;
      const generatedCycleEndMs = new Date(generatedCycleEnd).getTime();

      // Only exit UNCERTAIN_ZONE once the generated cycle has actually ended
      if (generatedCycleEndMs <= Date.now()) {
        reconciledCycleStartIso = generatedCycleEnd;
        currentState            = prediction.currentState as 'ON' | 'OFF';
        currentStateStartIso    = generatedCycleEnd;
        isHolding               = false;
        finalAtcState           = {
          ...atcState,
          mode: 'NORMAL',
          overrunMinutes: 0,
          statusLine: null,
          communityElevated: false,
        };

        if (prediction.lastTransitionAt) {
          logClientAccuracy(
            generatedCycleEnd,
            prediction.lastTransitionAt,
            prediction.currentState as 'ON' | 'OFF',
            offsetMinutes,
            'UNCERTAIN_ZONE',
          );
        }
      }
    } else {
      // ── A1: standard negative-offset exit ───────────────────────────────
      //   BackdatedStart = GrowattTransitionTime + UserOffset
      //   Example: Growatt OFF at 12:00, offset -60 → UserStart = 11:00
      //   Display: "طافية — منذ ساعة" ✅   NOT "منذ للتو" ❌
      const backdatedStart = computeReconciledCycleStart(
        prediction.lastTransitionAt,
        offsetMs,
        currentState,
        prediction.currentState,
      );

      if (backdatedStart) {
        reconciledCycleStartIso = backdatedStart;
        currentState            = prediction.currentState as 'ON' | 'OFF';
        currentStateStartIso    = backdatedStart;
        isHolding               = false;
        finalAtcState           = {
          ...atcState,
          mode: 'NORMAL',
          overrunMinutes: 0,
          statusLine: null,
          communityElevated: false,
        };

        if (prediction.lastTransitionAt) {
          logClientAccuracy(
            backdatedStart,
            prediction.lastTransitionAt,
            prediction.currentState as 'ON' | 'OFF',
            offsetMinutes,
            'UNCERTAIN_ZONE',
          );
        }
      } else if (prediction.lastTransitionAt) {
        // Safety fallback (should not reach here for genuine negative offsets)
        currentState         = prediction.currentState as 'ON' | 'OFF';
        currentStateStartIso = prediction.lastTransitionAt;
        isHolding            = false;
        finalAtcState        = {
          ...atcState,
          mode: 'NORMAL',
          overrunMinutes: 0,
          statusLine: null,
          communityElevated: false,
        };
      }
    }
  }

  // ── USER B EXIT: POSITIVE_OFFSET_PENDING → scheduled time has passed ──────
  //
  // If scheduledAutoTransitionIso has now passed, exit the hold.
  // UserCycleStartTime = scheduledAutoTransitionIso (which = GrowattTime + offset).
  // Since computeReconciledCycleStart returns null for future times, we use
  // scheduledAutoTransitionIso directly.
  //
  if (
    atcState.mode === 'POSITIVE_OFFSET_PENDING' &&
    transitionMode === 'AUTO' &&
    atcState.scheduledAutoTransitionIso
  ) {
    const scheduledMs = new Date(atcState.scheduledAutoTransitionIso).getTime();
    if (scheduledMs <= Date.now()) {
      // Transition time has passed — user transitions to Growatt's confirmed state
      const newState = prediction.currentState as 'ON' | 'OFF';
      reconciledCycleStartIso = atcState.scheduledAutoTransitionIso;
      currentState            = newState;
      currentStateStartIso    = atcState.scheduledAutoTransitionIso;
      isHolding               = false;
      finalAtcState           = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, scheduledAutoTransitionIso: null };

      // Log accuracy: predicted = scheduledAutoTransitionIso,
      // actual = prediction.lastTransitionAt (when Growatt actually changed)
      if (prediction.lastTransitionAt) {
        logClientAccuracy(
          atcState.scheduledAutoTransitionIso,
          prediction.lastTransitionAt,
          newState,
          offsetMinutes,
          'POSITIVE_OFFSET_PENDING',
        );
      }
    }
  }

  // ── USER C / NEUTRAL EXIT: WAITING_FOR_GROWATT / GRACE_MODE ──────────────
  if (
    (atcState.mode === 'WAITING_FOR_GROWATT' || atcState.mode === 'GRACE_MODE') &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      offsetMs,
      currentState,
      prediction.currentState,
    );

    if (backdatedStart) {
      reconciledCycleStartIso = backdatedStart;
      currentState            = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso    = backdatedStart;
      isHolding               = false;
      finalAtcState           = { ...atcState, mode: 'NORMAL', overrunMinutes: 0, statusLine: null, communityElevated: false };
    }
  }
  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction);
    
  const durLabel = elapsedLabel(reconciledCycleStartIso ?? currentStateStartIso);

  // ── POSITIVE OFFSET FIX: INJECT SYNTHETIC LINGERING SLOT ──
  // سد "فجوة الجدول" للمستخدم الموجب: إضافة الفترة الحالية المتبقية التي ينتظر انتهاءها
  let finalDaySchedule = [...effectiveSlots];
  if (finalAtcState.mode === 'POSITIVE_OFFSET_PENDING' && finalAtcState.scheduledAutoTransitionIso) {
    const currentStart = reconciledCycleStartIso ?? currentStateStartIso ?? new Date().toISOString();
    finalDaySchedule.unshift({
      state: currentState,
      startIso: currentStart,
      endIso: finalAtcState.scheduledAutoTransitionIso,
      startFormatted: fmtYemenTime(currentStart),
      endFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmtYemenTime(currentStart),
      shiftedEndFormatted: fmtYemenTime(finalAtcState.scheduledAutoTransitionIso),
      durationLabel: '', 
      zone: getZoneFromIso(currentStart),
      isEstimated: true,
    });
  }

  return {
    nextTransition,
    expectedOffDurationLabel: prediction.expectedOffRange
      ? arabicDurationRange(prediction.expectedOffRange.minMin, prediction.expectedOffRange.maxMin)
      : null,
    expectedOnDurationLabel: prediction.expectedOnRange
      ? arabicDurationRange(prediction.expectedOnRange.minMin, prediction.expectedOnRange.maxMin)
      : null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    currentState,
    currentStateDurationLabel: durLabel,
    currentStateStartIso,
    daySchedule: finalDaySchedule, // <-- تم التعديل هنا فقط لربط الفترة الوهمية
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisActive ?? prediction.apppe?.crisisMode ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    isResynced: hasResync,
    resyncedAtIso: resyncPoint?.syncedAtIso ?? null,
    atc: finalAtcState,
    isHoldingState: isHolding,
    reconciledCycleStartIso,
    communitySyncMeta: communitySyncMeta
      ?? (resyncPoint ? {
          reporterName: resyncPoint.reporterName ?? null,
          reporterReliability: resyncPoint.reporterReliability ?? null,
          syncedAtIso: resyncPoint.syncedAtIso,
          syncedState: resyncPoint.syncedState,
        } : null),
    // ── TMMS V2: community transition metadata ────────────────────────────────
    // Exposed so UI / debug screens can display offset classification, progress
    // ratio, and generated-cycle boundaries without re-deriving them.
    // null when no resync point is active.
    communityTransitionMeta: communityTransition
      ? {
          offsetType:              communityTransition.offsetType,
          progressRatio:           communityTransition.progressRatio,
          generatedCycleStartIso:  communityTransition.generatedCycleStartIso,
          generatedCycleEndIso:    communityTransition.generatedCycleEndIso,
          generatedCycleState:     communityTransition.generatedCycleState,
          generatedCycleActive:    Date.now() < new Date(communityTransition.generatedCycleEndIso).getTime(),
        }
      : null,
  };

  
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  heldCycleStartIso?: string | null,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  const stableStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string | null } | null>(null);
  // Track the last reconciled start separately so re-renders don't clobber it
  const reconciledStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string } | null>(null);
  const prevOffsetRef = useRef<number>(offsetMinutes);

  const fetchPrediction = () => {
    supabase
      .from('utility_predictions')
      .select('*')
      .eq('id', 1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) console.error('[useUserPredictions] fetch error:', error.message);
        if (data?.prediction) setRawPrediction(data.prediction as Prediction);
        setLoading(false);
      });
  };

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

    const timeout = setTimeout(() => {
      if (cancelled) return;
      setLoading(false);
    }, 8000);

    const { AppState } = require('react-native') as typeof import('react-native');
    const handleAppState = (nextState: string) => {
      if (nextState === 'active') fetchPrediction();
    };
    const appStateSub = AppState.addEventListener('change', handleAppState);

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
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (prevOffsetRef.current !== offsetMinutes) {
      prevOffsetRef.current       = offsetMinutes;
      stableStartRef.current      = null;
      reconciledStartRef.current  = null;
      fetchPrediction();
    }
  }, [offsetMinutes]);

  const userPrediction: UserPrediction | null = rawPrediction
    ? (() => {
        const pred = applyOffsetToPrediction(
          rawPrediction, offsetMinutes, resyncPoint, null, transitionMode, heldCycleStartIso ?? null,
        );

        // ── Stabilize currentStateStartIso ────────────────────────────────────
        //
        // Priority order (highest first):
        //
        // 1. reconciledCycleStartIso just computed this render
        //    → Store in reconciledStartRef (keyed by new state) AND stableStartRef.
        //    → This is the backdated start (e.g. 11:00 for -60 offset) and MUST
        //      survive subsequent re-renders where reconciledCycleStartIso = null.
        //
        // 2. reconciledStartRef holds a reconciled start for the CURRENT state
        //    → Re-use it. This prevents re-renders from resetting to stale starts.
        //
        // 3. stableStartRef holds the same state → re-use (no-jitter on re-renders).
        //
        // 4. State flipped or first render → adopt computed startIso, clear refs.
        //
        if (pred.reconciledCycleStartIso) {
          // Fresh reconciliation this render — persist for subsequent renders
          reconciledStartRef.current = { state: pred.currentState, startIso: pred.reconciledCycleStartIso };
          stableStartRef.current     = { state: pred.currentState, startIso: pred.reconciledCycleStartIso };
          pred.currentStateStartIso  = pred.reconciledCycleStartIso;
        } else if (
          reconciledStartRef.current &&
          reconciledStartRef.current.state === pred.currentState
        ) {
          // Re-render after reconciliation — keep the backdated start alive
          pred.currentStateStartIso  = reconciledStartRef.current.startIso;
          pred.reconciledCycleStartIso = reconciledStartRef.current.startIso;
          stableStartRef.current     = reconciledStartRef.current;
        } else if (
          stableStartRef.current &&
          stableStartRef.current.state === pred.currentState
        ) {
          // Same state, no reconciliation — reuse stable anchor
          pred.currentStateStartIso = stableStartRef.current.startIso;
        } else {
          // State changed or first render
          reconciledStartRef.current = null;
          stableStartRef.current     = { state: pred.currentState, startIso: pred.currentStateStartIso };
        }

        pred.currentStateDurationLabel = elapsedLabel(pred.currentStateStartIso);

        return pred;
      })()
    : null;

  return { userPrediction, rawPrediction, loading };
}
