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
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
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
    /**
     * Exact ratio — elapsedMs / plannedDurationMs, never rounded.
     * Used ONLY for OFF-interrupted duration selection (Rule 3). Never used
     * for offset (Rule 1 — full independence between the two operations).
     */
    progressRatio: number;
    /** ISO — when the generated cycle started (= syncedAtIso) */
    generatedCycleStartIso: string;
    /** ISO — when the generated cycle ends (= syncedAtIso + schedule duration) */
    generatedCycleEndIso: string;
    /** The community-confirmed state that was assigned to the generated cycle */
    generatedCycleState: 'ON' | 'OFF';
    /** True while now < generatedCycleEndIso */
    generatedCycleActive: boolean;
    /**
     * Rule 4/5 result — signed magnitude in minutes (e.g. +73 / −42 / 0).
     * Computed ONCE per resync and frozen thereafter (Q2-A).
     */
    offsetMinutes: number;
    offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
    offsetReferenceIso: string | null;
    offsetReferenceKind: string | null;
    /**
     * True only on the render where the offset was freshly computed.
     * The hook (useUserPredictions) uses this to persist the offset exactly
     * once and freeze it for all subsequent renders (Q2-A / Q3-A). Not
     * generally needed by UI consumers.
     */
    isFreshOffsetComputation: boolean;
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
// Implements the Critical Rules from the "TMMS V2 Offset & Generated-State
// Migration" spec. Two operations happen here, and per Rule 1 they are
// COMPLETELY INDEPENDENT — neither one's result feeds the other:
//
//   (A) DURATION SELECTION (Rule 3) — what duration does the generated cycle run for?
//       Source: the schedule PATTERN only (durations are offset-invariant, so
//       reading them off the user's current offset-shifted schedule is safe).
//         interruptedState === 'OFF' → 50% rule:
//           progress < 50% → previous same-state duration (before)
//           progress > 50% → next same-state duration (after)
//         interruptedState === 'ON'  → ALWAYS previous same-state duration (before).
//           No 50% rule for ON — ON cycles are short and the 50% rule produces
//           poor results there (Rule 3, explicit).
//
//   (B) OFFSET CALCULATION (Rule 4 + Rule 5) — how far is the user from Growatt?
//       Formula:  Offset = GeneratedStateStartTime − ReferenceGrowattTransitionTime
//       ReferenceGrowattTransitionTime depends ONLY on Growatt's timeline —
//       never on duration selection, never on progress ratio (Rule 1):
//         Growatt currently ON  + Report=ON  → Growatt ON Start Time   (actual)
//         Growatt currently ON  + Report=OFF → Growatt ON End Time     (expected)
//         Growatt currently OFF + Report=ON  → Growatt OFF End Time    (expected — NOT start)
//         Growatt currently OFF + Report=OFF → Growatt OFF Start Time  (actual)
//       Reference is read from the RAW Growatt schedule — never the user's
//       offset-shifted schedule (confirmed: mixing in the OLD offset would
//       compound old+new offset into the new value).
//       Offset > 0 → POSITIVE (user behind Growatt)
//       Offset < 0 → NEGATIVE (user ahead of Growatt)
//       Offset = 0 exactly → NEUTRAL (no tolerance)
//
//       Computed ONCE, immediately, when the generated state is created — and
//       NEVER recomputed or overwritten afterward, even once Growatt's actual
//       transition becomes known later (confirmed design decision). The hook
//       (useUserPredictions) freezes this value across re-renders via
//       frozenOffsetMinutes below — see "Compute-once freezing" near the hook.
//
// Step 6: Build a full independent new cycle starting at syncedAtIso — never
//         reuses schedule timestamps, never uses remaining-time math.
// Step 7: Rebuild the continuation via the LOGICAL schedule sequence (never
//         clock-based nearest-slot search).
// Step 9: After the generated cycle ends, the ALREADY-COMPUTED offset drives
//         standard EXISTING behavior — Positive → verification window
//         (POSITIVE_OFFSET_PENDING), Negative → UNCERTAIN_ZONE, Neutral →
//         normal sync. This reuses computeATCState's existing User A/B/C
//         branches (see Phase B recursion below) — no new offset-handling rules.
//
interface CommunityOffsetResult {
  /** Signed magnitude in minutes, e.g. +73 or −42 — never just a sign category. */
  offsetMinutes: number;
  sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  /** ISO of the Growatt reference point used (Rule 5 case table) */
  referenceIso: string;
  /** Which Rule 5 case fired — for debugging / telemetry */
  referenceKind:
    | 'GROWATT_ON_START_ACTUAL'
    | 'GROWATT_ON_END_EXPECTED'
    | 'GROWATT_OFF_END_EXPECTED'
    | 'GROWATT_OFF_START_ACTUAL';
}

interface CommunityTransitionResult {
  /** Rebuilt slots: pre-interruption + generated cycle + logical continuation */
  effectiveSlots: ShiftedScheduleSlot[];
  /** syncedAtIso — when the generated cycle starts */
  generatedCycleStartIso: string;
  /** syncedAtIso + selectedDuration — when the generated cycle ends */
  generatedCycleEndIso: string;
  /** The confirmed new state (= resync.syncedState) */
  generatedCycleState: 'ON' | 'OFF';
  /**
   * Exact ratio (ms precision, never rounded): elapsedMs / plannedDurationMs.
   * Used ONLY for OFF-interrupted duration selection (Rule 3). Never used for
   * offset calculation (Rule 1 — full independence between the two operations).
   */
  progressRatio: number;
  /**
   * Rule 4/5 result. Computed ONCE per resync and frozen thereafter (Q2-A).
   * Real signed value driving post-cycle ATC behavior (Rule 9):
   *   < 0 → UNCERTAIN_ZONE path,  > 0 → verification-window path,  = 0 → normal.
   */
  derivedOffsetMinutes: number;
  offsetSign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  offsetReferenceIso: string | null;
  offsetReferenceKind: CommunityOffsetResult['referenceKind'] | null;
  /**
   * True only on the render where the offset was FRESHLY computed (no frozen
   * value was supplied). The hook uses this single-shot signal to persist the
   * offset exactly once (Q3-A) and freeze it for all subsequent renders (Q2-A).
   */
  isFreshOffsetComputation: boolean;
}

// ── Rule 5: locate the RAW-schedule slot of a given state active at a moment ──
// Used to find the "expected" Growatt transition time when the report opposes
// Growatt's current state (cases: ON+report-OFF, OFF+report-ON).
function findActiveSlotInRawSchedule(
  rawSchedule: ScheduleSlot[],
  state: 'ON' | 'OFF',
  atMs: number,
): ScheduleSlot | null {
  // 1) Exact match — a slot of this state literally spans atMs.
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = new Date(s.endIso).getTime();
    if (atMs >= startMs && atMs <= endMs) return s;
  }
  // 2) No exact match — atMs falls in a gap (the state's slot already ended
  //    on the predicted schedule, but Growatt's sensor hasn't caught up to
  //    the transition yet — exactly the case GROWATT_*_END_EXPECTED exists
  //    for). The correct reference is the MOST RECENTLY ENDED past
  //    occurrence of this state — never a future one, even if a future
  //    occurrence's *start* happens to be numerically closer to atMs than
  //    the true past occurrence's start (e.g. a report arriving late at
  //    19:00 against an OFF slot that ended at 18:00 must NOT fall through
  //    to tomorrow's 20:00 OFF slot just because |19:00-20:00| < |19:00-13:00|).
  //    Only fall back to the nearest future occurrence if no past one exists
  //    at all (e.g. atMs precedes the entire schedule).
  let bestPast: ScheduleSlot | null = null;
  let bestPastEndMs = -Infinity;
  let bestFuture: ScheduleSlot | null = null;
  let bestFutureStartMs = Infinity;
  for (const s of rawSchedule) {
    if (s.state !== state || !s.endIso) continue;
    const startMs = new Date(s.startIso).getTime();
    const endMs   = new Date(s.endIso).getTime();
    if (endMs <= atMs && endMs > bestPastEndMs) { bestPastEndMs = endMs; bestPast = s; }
    if (startMs > atMs && startMs < bestFutureStartMs) { bestFutureStartMs = startMs; bestFuture = s; }
  }
  return bestPast ?? bestFuture;
}

// ── Rule 4 + Rule 5: compute the offset (sign + magnitude) ─────────────────────
//
// growattCurrentState / growattLastTransitionAt are the values AT THE MOMENT
// the report/confirmation fired — the caller is responsible for freezing these
// (see the hook's compute-once-freezing logic) so this calculation is never
// silently re-derived from drifted, later live data.
function computeCommunityOffset(
  rawSchedule: ScheduleSlot[],
  resync: ResyncPoint,
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
): CommunityOffsetResult | null {
  const startMs = new Date(resync.syncedAtIso).getTime();
  const reportedState = resync.syncedState;

  let referenceIso: string | null;
  let referenceKind: CommunityOffsetResult['referenceKind'];

  if (growattCurrentState === reportedState) {
    // Report MATCHES Growatt's current state → the actual transition INTO
    // that state already happened and is known (prediction.lastTransitionAt).
    referenceIso  = growattLastTransitionAt;
    referenceKind = reportedState === 'ON' ? 'GROWATT_ON_START_ACTUAL' : 'GROWATT_OFF_START_ACTUAL';
  } else {
    // Report OPPOSES Growatt's current state → use the EXPECTED end of the
    // CURRENT Growatt slot, read from the RAW schedule (Q1-A).
    // Explicit spec warning: for OFF+report-ON this is the OFF slot's END
    // time — never its start time.
    const rawActiveSlot = findActiveSlotInRawSchedule(rawSchedule, growattCurrentState, startMs);
    referenceIso  = rawActiveSlot?.endIso ?? null;
    referenceKind = growattCurrentState === 'ON' ? 'GROWATT_ON_END_EXPECTED' : 'GROWATT_OFF_END_EXPECTED';
  }

  if (!referenceIso) return null; // insufficient data — caller falls back to NEUTRAL

  const referenceMs   = new Date(referenceIso).getTime();
  const offsetMsExact = startMs - referenceMs;
  // Rule 8: Neutral ONLY on an exact match — no tolerance, no approximation.
  const sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' =
    offsetMsExact === 0 ? 'NEUTRAL' : offsetMsExact > 0 ? 'POSITIVE' : 'NEGATIVE';

  return {
    offsetMinutes: Math.round(offsetMsExact / 60_000),
    sign,
    referenceIso,
    referenceKind,
  };
}

function computeCommunityTransition(
  offsetSlots: ShiftedScheduleSlot[],
  resync: ResyncPoint,
  rawSchedule: ScheduleSlot[],
  growattCurrentState: 'ON' | 'OFF',
  growattLastTransitionAt: string | null,
  frozenOffsetMinutes: number | null,
): CommunityTransitionResult | null {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  // Guard: confirmations must be from the past (or present)
  if (syncMs > Date.now() + 60_000) return null;

  const syncState: 'ON' | 'OFF'        = resync.syncedState;
  const interruptedState: 'ON' | 'OFF' = syncState === 'ON' ? 'OFF' : 'ON';

  // ── Step 1: Locate the interrupted cycle ──────────────────────────────────
  // Find the slot that was active at syncMs whose state is interruptedState.
  // Uses the user's CURRENT effective (offset-shifted) schedule — intentional:
  // "interrupted cycle" means what the USER currently perceives as active,
  // which is exactly their personal offset-shifted view.
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

  // ── Step 5 (Rule 3): Select new-cycle duration from the schedule ─────────
  //
  // interruptedState === 'OFF' → 50% rule:
  //   progress < 50% → previous same-state duration (before)
  //   progress > 50% → next same-state duration (after)
  //
  // interruptedState === 'ON'  → ALWAYS previous same-state duration (before).
  //   No 50% rule for ON — explicitly forbidden by Rule 3 (ON cycles are short
  //   and the 50% rule produces poor results there). No exceptions.
  //
  let durationSourceIdx = -1;
  const wantsBefore = interruptedState === 'ON' ? true : progressRatio <= 0.5;

  if (wantsBefore) {
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

  // ── Rule 4 + Rule 5: Offset calculation (fully independent of Step 5) ────
  //
  // Q2-A / Q3-A: computed ONCE, persisted immediately, never recomputed.
  // If the hook already froze a value for this resync (frozenOffsetMinutes
  // is non-null), reuse it verbatim — do NOT touch growattCurrentState /
  // growattLastTransitionAt again, even if they've since changed.
  // Otherwise this is the FIRST time this resync is being processed: compute
  // fresh now via the Rule 5 reference-time table.
  let offsetMinutesFinal: number;
  let offsetSignFinal: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  let offsetReferenceIsoFinal: string | null;
  let offsetReferenceKindFinal: CommunityOffsetResult['referenceKind'] | null;
  let isFreshOffsetComputation: boolean;

  if (frozenOffsetMinutes !== null && frozenOffsetMinutes !== undefined) {
    offsetMinutesFinal       = frozenOffsetMinutes;
    offsetSignFinal          = offsetMinutesFinal === 0 ? 'NEUTRAL' : offsetMinutesFinal > 0 ? 'POSITIVE' : 'NEGATIVE';
    offsetReferenceIsoFinal  = null; // not re-derived — was logged at original computation time
    offsetReferenceKindFinal = null;
    isFreshOffsetComputation = false;
  } else {
    const computed = computeCommunityOffset(rawSchedule, resync, growattCurrentState, growattLastTransitionAt);
    if (computed) {
      offsetMinutesFinal       = computed.offsetMinutes;
      offsetSignFinal          = computed.sign;
      offsetReferenceIsoFinal  = computed.referenceIso;
      offsetReferenceKindFinal = computed.referenceKind;
    } else {
      // Insufficient data (no lastTransitionAt / no matching raw slot found) —
      // safe fallback so the pipeline never throws; NEUTRAL is the least
      // disruptive default (continues normal sync rather than guessing).
      offsetMinutesFinal       = 0;
      offsetSignFinal          = 'NEUTRAL';
      offsetReferenceIsoFinal  = null;
      offsetReferenceKindFinal = null;
    }
    isFreshOffsetComputation = true;
  }

  return {
    effectiveSlots: [...preCycleSlots, generatedSlot, ...continuationSlots],
    generatedCycleStartIso,
    generatedCycleEndIso,
    generatedCycleState: syncState,
    progressRatio,
    derivedOffsetMinutes: offsetMinutesFinal,
    offsetSign: offsetSignFinal,
    offsetReferenceIso: offsetReferenceIsoFinal,
    offsetReferenceKind: offsetReferenceKindFinal,
    isFreshOffsetComputation,
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
  //   Re-run ATC using communityTransition.derivedOffsetMinutes — the REAL
  //   Rule 4/5 offset, computed once at creation time and frozen (Q2-A/Q3-A).
  //   This routes into the EXISTING User A/B/C branches below exactly like a
  //   normal stored-offset user (Rule 9 — reuse existing offset behavior,
  //   no new offset-handling rules):
  //     derivedOffsetMinutes < 0 → User A → UNCERTAIN_ZONE
  //     derivedOffsetMinutes > 0 → User B → POSITIVE_OFFSET_PENDING (verification window)
  //     derivedOffsetMinutes = 0 → User C → normal synchronized logic
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

    // ── Phase B: generated cycle ended → apply the already-computed offset ──
    // (Rule 9) Reuses the SAME User A/B/C branches a normal offset user gets —
    // no special-casing, no new rules. communityTransition.derivedOffsetMinutes
    // was computed once at creation time (Rule 4/5) and never recalculated.
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
  /**
   * The previously-frozen Rule 4/5 offset for the CURRENT resyncPoint, if one
   * has already been computed (Q2-A: compute once, never recompute).
   * Pass `null`/`undefined` the first time a given resyncPoint.syncedAtIso is
   * seen; computeCommunityTransition will compute it fresh and report back via
   * onOffsetCalculated below. From the NEXT render onward, the caller (hook)
   * must pass the frozen value back in here so it is never recalculated.
   */
  frozenCommunityOffsetMinutes?: number | null,
  /**
   * Fires exactly once per resyncPoint — only on the render where the offset
   * is FRESHLY computed (i.e. frozenCommunityOffsetMinutes was not supplied).
   * The caller must (a) persist offsetMinutes permanently (Q3-A: immediate,
   * permanent save — never recomputed/overwritten later) and (b) freeze this
   * exact value (e.g. in a ref keyed by resyncPoint.syncedAtIso) so it can be
   * passed back in as frozenCommunityOffsetMinutes on every subsequent render.
   *
   * Formula (Rule 4 + Rule 5):
   *   offsetMinutes = (GeneratedStateStartTime − ReferenceGrowattTransitionTime) / 60_000
   *   > 0 → POSITIVE (user behind Growatt) · < 0 → NEGATIVE (user ahead) · = 0 → NEUTRAL
   */
  onOffsetCalculated?: (
    offsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null },
  ) => void,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction);
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  const hasResync = !!resyncPoint;

  // ── TMMS V2: Run Schedule-Based Community Transition ──────────────────────
  //
  // computeCommunityTransition implements:
  //   • Step 1-2  Terminate interrupted cycle, start confirmed state at syncedAtIso
  //   • Step 3    Exact progress ratio (ms precision, used ONLY for OFF-case duration)
  //   • Rule 3    Schedule-derived duration (ON-interrupted always borrows "before";
  //               OFF-interrupted uses the 50% rule) — never invented/predicted
  //   • Step 6-7  Full independent generated cycle + logical-sequence continuation
  //   • Rule 4/5  Offset (sign + magnitude) computed independently of duration
  //               selection (Rule 1), against the RAW schedule, once and frozen
  //
  let communityTransition: CommunityTransitionResult | null = null;
  if (resyncPoint) {
    communityTransition = computeCommunityTransition(
      effectiveSlots,
      resyncPoint,
      extended,                                   // RAW schedule — Rule 4/5 reference (Q1-A)
      prediction.currentState,
      prediction.lastTransitionAt,
      frozenCommunityOffsetMinutes ?? null,
    );
    if (communityTransition) {
      // Use the rebuilt schedule (generated cycle + logical continuation)
      effectiveSlots = communityTransition.effectiveSlots;

      // Fire the persistence callback ONLY on the render that freshly computed
      // the offset (Q3-A: persist immediately; Q2-A: never again afterward).
      if (communityTransition.isFreshOffsetComputation) {
        onOffsetCalculated?.(communityTransition.derivedOffsetMinutes, {
          sign:          communityTransition.offsetSign,
          referenceIso:  communityTransition.offsetReferenceIso,
          referenceKind: communityTransition.offsetReferenceKind,
        });
      }
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

  // ── Rule 9: post-cycle offset is whatever was computed at creation time ───
  // For a community transition, the offset was ALREADY computed once (Rule 4/5,
  // frozen — Q2-A) inside computeCommunityTransition; reuse it verbatim for every
  // exit block below instead of the (possibly stale) stored offsetMinutes prop.
  // For a non-community user, effectiveOffsetMs is simply the stored offset.
  const effectiveOffsetMinutes = communityTransition ? communityTransition.derivedOffsetMinutes : offsetMinutes;
  const effectiveOffsetMs      = effectiveOffsetMinutes * 60_000;

  // ── USER A EXIT: UNCERTAIN_ZONE → Growatt confirmed (AUTO mode) ───────────
  //
  // BackdatedStart = GrowattTransitionTime + effectiveOffsetMs
  // Example: Growatt OFF at 12:00, offset −60 → UserStart = 11:00
  //   Display: "طافية — منذ ساعة" ✅   NOT "منذ للتو" ❌
  //
  // Applies uniformly to both standard negative-offset users and community
  // transitions whose Rule 4/5 offset came out negative (Rule 9: reuse
  // existing Negative Offset logic — no new offset-handling rules).
  //
  if (
    atcState.mode === 'UNCERTAIN_ZONE' &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      effectiveOffsetMs,
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
          effectiveOffsetMinutes,
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
          effectiveOffsetMinutes,
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
      effectiveOffsetMs,
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
    // Exposed so UI / debug screens can display the real offset, progress ratio,
    // and generated-cycle boundaries without re-deriving them.
    // null when no resync point is active.
    communityTransitionMeta: communityTransition
      ? {
          progressRatio:            communityTransition.progressRatio,
          generatedCycleStartIso:   communityTransition.generatedCycleStartIso,
          generatedCycleEndIso:     communityTransition.generatedCycleEndIso,
          generatedCycleState:      communityTransition.generatedCycleState,
          generatedCycleActive:     Date.now() < new Date(communityTransition.generatedCycleEndIso).getTime(),
          offsetMinutes:            communityTransition.derivedOffsetMinutes,
          offsetSign:               communityTransition.offsetSign,
          offsetReferenceIso:       communityTransition.offsetReferenceIso,
          offsetReferenceKind:      communityTransition.offsetReferenceKind,
          isFreshOffsetComputation: communityTransition.isFreshOffsetComputation,
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
  /**
   * Fires exactly once per resync point, the moment its Rule 4/5 offset is
   * freshly computed (Q3-A: persist immediately when the generated state is
   * created). The caller should write `offsetMinutes` to permanent storage
   * (e.g. the user's profile row) here.
   *
   * The hook itself freezes the value internally (communityOffsetFrozenRef)
   * so it is never recalculated on subsequent renders (Q2-A) — this callback
   * is purely for the CALLER's own persistence; the hook's own behavior does
   * not depend on the callback actually succeeding.
   */
  onCommunityOffsetComputed?: (
    offsetMinutes: number,
    meta: { sign: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'; referenceIso: string | null; referenceKind: string | null; syncedAtIso: string },
  ) => void,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  const stableStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string | null } | null>(null);
  // Track the last reconciled start separately so re-renders don't clobber it
  const reconciledStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string } | null>(null);
  const prevOffsetRef = useRef<number>(offsetMinutes);

  // ── TMMS V2 — Rule 4/5 offset freeze (Q2-A: compute once, never recompute) ─
  // Keyed by resyncPoint.syncedAtIso so a NEW report/confirmation (different
  // syncedAtIso) gets its own fresh computation, while re-renders for the SAME
  // resync point always reuse the frozen value rather than re-deriving it from
  // (potentially drifted) live Growatt data.
  const communityOffsetFrozenRef = useRef<{ syncedAtIso: string; offsetMinutes: number } | null>(null);
  if (!resyncPoint && communityOffsetFrozenRef.current) {
    communityOffsetFrozenRef.current = null; // resync cleared — reset for next time
  }

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
        // TMMS V2: pass the frozen offset (if this exact resync was already
        // processed) so computeCommunityTransition reuses it verbatim instead
        // of recomputing from (possibly drifted) live Growatt data (Q2-A).
        const frozenOffset =
          resyncPoint && communityOffsetFrozenRef.current?.syncedAtIso === resyncPoint.syncedAtIso
            ? communityOffsetFrozenRef.current.offsetMinutes
            : null;

        const pred = applyOffsetToPrediction(
          rawPrediction, offsetMinutes, resyncPoint, null, transitionMode, heldCycleStartIso ?? null,
          frozenOffset,
          undefined, // onOffsetCalculated — freezing handled directly below instead
        );

        // ── TMMS V2: freeze the offset the moment it's freshly computed ──────
        // isFreshOffsetComputation is true only on the render where Rule 4/5
        // actually ran (frozenOffset was null going in). From this point on,
        // every subsequent render for the SAME resync.syncedAtIso will read
        // the frozen value above instead of recomputing (Q2-A: never again).
        if (
          resyncPoint &&
          pred.communityTransitionMeta?.isFreshOffsetComputation &&
          communityOffsetFrozenRef.current?.syncedAtIso !== resyncPoint.syncedAtIso
        ) {
          communityOffsetFrozenRef.current = {
            syncedAtIso: resyncPoint.syncedAtIso,
            offsetMinutes: pred.communityTransitionMeta.offsetMinutes,
          };
          onCommunityOffsetComputed?.(pred.communityTransitionMeta.offsetMinutes, {
            sign: pred.communityTransitionMeta.offsetSign,
            referenceIso: pred.communityTransitionMeta.offsetReferenceIso,
            referenceKind: pred.communityTransitionMeta.offsetReferenceKind,
            syncedAtIso: resyncPoint.syncedAtIso,
          });
        }

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
