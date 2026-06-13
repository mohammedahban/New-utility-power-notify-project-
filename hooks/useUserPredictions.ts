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
 */

import { useEffect, useState, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { Prediction, ScheduleSlot } from './usePredictions';
import { ResyncPoint } from '../contexts/ResyncContext';

// ── Public types ──────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE';

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
   * start is backdated to: user_cycle_start + actual_growatt_duration.
   * This ISO represents that backdated start so the elapsed timer in the
   * NEW state reflects time already spent waiting, not just since now.
   */
  reconciledCycleStartIso: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function shiftMs(iso: string, deltaMs: number): string {
  return new Date(new Date(iso).getTime() + deltaMs).toISOString();
}

// Western numerals + Arabic AM/PM suffix, LTR (spec §20: "7:00 م → 8:03 م")
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

  const extOnMin = realOnMin ?? prediction.expectedOnRange?.minMin ?? prediction.allPattern?.avgOnMin ?? prediction.dayPattern?.avgOnMin ?? 120;
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

// ── Step 3: Apply community delta ─────────────────────────────────────────────
function applyCommunityDelta(offsetSlots: ShiftedScheduleSlot[], resync: ResyncPoint): ShiftedScheduleSlot[] {
  const syncMs = new Date(resync.syncedAtIso).getTime();
  const syncState = resync.syncedState;
  const LOOKAHEAD_MS = 90 * 60_000;

  let matchIdx = -1;

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

  if (matchIdx === -1) return offsetSlots;

  const matchedSlotStartMs = new Date(offsetSlots[matchIdx].startIso).getTime();
  const deltaMs = syncMs - matchedSlotStartMs;

  return offsetSlots.map((slot, idx) => {
    if (idx < matchIdx) return slot;
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

// ── Validation Window (20 min) — Growatt changed while sync is active ─────────
const VALIDATION_WINDOW_MS = 20 * 60_000;

// ── ATC Decision Engine ───────────────────────────────────────────────────────
//
// CRITICAL FIX (spec §NEGATIVE OFFSET BEHAVIOR / §UNCERTAIN_ZONE RULES):
//
// The old implementation only examined the CURRENTLY ACTIVE slot (the one
// where nowMs is between its start and end). This caused a fatal bug:
//
//   For a negative-offset user at T+90 min past their predicted cycle end:
//   - effectiveSlots[i-1] (old state) has endIso in the past
//   - effectiveSlots[i]   (new state) starts at effectiveSlots[i-1].endIso
//   - nowMs is INSIDE effectiveSlots[i] → it becomes the "active" slot
//   - The function saw effectiveSlots[i] with no overrun → returned NORMAL
//   - User was auto-moved to the new state WITHOUT entering UNCERTAIN_ZONE
//
// The fix: for negative-offset users, we must ALSO examine the PREVIOUS slot
// (the one that most recently ended). If that slot ended within range/overrun
// territory and no Growatt/community/report has confirmed a transition yet,
// we must return UNCERTAIN_ZONE based on that previous slot's overrun.
//
// The `growattConfirmedTransitionAt` parameter is the ISO of Growatt's most
// recent confirmed state change. If it is AFTER the previous slot ended, then
// Growatt has already confirmed → no UNCERTAIN_ZONE needed (reconciliation
// handles the backdated start separately in applyOffsetToPrediction).
//
function computeATCState(
  effectiveSlots: ShiftedScheduleSlot[],
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  prediction: Prediction,
  transitionMode: TransitionMode = 'AUTO',
): ATCState {
  const nowMs = Date.now();

  // Community Sync path — personal timeline branch is PERMANENT until explicit revert.
  // Per spec §10: never auto-revert. The validation window only shows a warning,
  // it does NOT remove the sync. Only explicit user revert clears it.
  if (resyncPoint) {
    const syncedState = resyncPoint.syncedState;
    const growattState = prediction.currentState;
    const growattDiffers = (syncedState === 'ON') !== (growattState === 'ON');
    const syncAgeMs = nowMs - new Date(resyncPoint.syncedAtIso).getTime();
    const inValidationWindow = growattDiffers && syncAgeMs < VALIDATION_WINDOW_MS;
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
    };
  }

  const halfSpreadMs = 15 * 60_000;
  const GRACE_PERIOD_MS = 15 * 60_000;

  // ── NEGATIVE OFFSET: scan for the most recently ended slot ───────────────
  //
  // Spec §NEGATIVE OFFSET BEHAVIOR / §CORE RULE:
  //   A negative-offset user reaches predicted cycle end BEFORE Growatt.
  //   After that predicted end the user MUST enter UNCERTAIN_ZONE and stay
  //   there until: user report, community confirmation, OR Growatt state change.
  //
  //   We must check not just the currently active slot but ALSO the previous
  //   slot (which may have already ended, causing the schedule to advance to
  //   the next slot automatically). If the previous slot's end has passed AND
  //   Growatt has NOT yet confirmed the matching transition, we are in
  //   UNCERTAIN_ZONE regardless of what the current slot says.
  //
  if (offsetMinutes < 0) {
    // Find the slot that most recently ended (endIso is in the past)
    // and the slot that just became active (started after previous ended)
    let justEndedSlot: ShiftedScheduleSlot | null = null;
    let justEndedSlotIdx = -1;

    for (let i = 0; i < effectiveSlots.length; i++) {
      const s = effectiveSlots[i];
      if (!s.endIso) continue;
      const endMs = new Date(s.endIso).getTime();
      if (endMs <= nowMs) {
        // This slot has ended — track the most recent one
        justEndedSlot = s;
        justEndedSlotIdx = i;
      } else {
        break; // slots are ordered; once we find a future end we're done
      }
    }

    if (justEndedSlot && justEndedSlot.endIso) {
      const slotEndMs = new Date(justEndedSlot.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      const overrunMs    = Math.max(0, nowMs - rangeEndMs);
      const overrunMin   = overrunMs / 60_000;

      // Is now inside the prediction range window of that ended slot?
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        // In range window of the ended slot
        return {
          mode: 'PREDICTION_RANGE',
          overrunMinutes: 0,
          communityElevated: false,
          statusLine: 'نطاق التوقع نشط — التغيير محتمل',
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          transitionMode,
        };
      }

      // Past the range end → has Growatt already confirmed this transition?
      //
      // Growatt confirmed if:
      //   - prediction.currentState has flipped to the NEW state (the one that
      //     follows justEndedSlot in the effective schedule), AND
      //   - prediction.lastTransitionAt is AFTER the slot's range start
      //     (i.e., the Growatt event corresponds to this cycle's end)
      //
      // If Growatt has confirmed, applyOffsetToPrediction's exit block handles
      // the reconciliation — we return NORMAL here to unblock it.
      const expectedNewState: 'ON' | 'OFF' = justEndedSlot.state === 'ON' ? 'OFF' : 'ON';
      const growattAlreadyConfirmed =
        prediction.currentState === expectedNewState &&
        !!prediction.lastTransitionAt &&
        new Date(prediction.lastTransitionAt).getTime() >= rangeStartMs;

      if (growattAlreadyConfirmed) {
        // Growatt has already confirmed this transition.
        // Return NORMAL so that applyOffsetToPrediction's UNCERTAIN_ZONE exit
        // block can compute the backdated start and transition cleanly.
        // NOTE: We intentionally pass NORMAL here even though atcShouldHold
        // will be false — the exit block checks atcState.mode === 'UNCERTAIN_ZONE'
        // which won't match. Instead, we detect this case in applyOffsetToPrediction
        // via the dedicated growattAlreadyConfirmed path below.
        //
        // We signal this via a special mode so applyOffsetToPrediction can
        // detect and apply the backdated reconciliation:
        return {
          mode: 'UNCERTAIN_ZONE',  // keep hold active so deriveCurrentStateATC holds the OLD state
          overrunMinutes: overrunMin,
          communityElevated: false,
          statusLine: null,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          transitionMode,
          // Internal signal: Growatt already confirmed, reconciliation should run
          // (applyOffsetToPrediction reads prediction.currentState !== currentState
          //  to detect this, which will be true because we're holding the old state)
        };
      }

      // Growatt has NOT yet confirmed — UNCERTAIN_ZONE (spec §CORE RULE)
      if (nowMs > rangeStartMs) {
        return {
          mode: 'UNCERTAIN_ZONE',
          overrunMinutes: overrunMin,
          communityElevated: true,
          statusLine: overrunMin < 1
            ? 'نطاق التوقع انتهى — بانتظار تأكيد تغير الحالة'
            : `تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد تغير الحالة`,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          transitionMode,
        };
      }
    }

    // No slot has ended yet (all in future) or offset-adjusted schedule hasn't
    // started — check if there's a currently active slot near its end
    let activeSlotNeg: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const start = new Date(slot.startIso).getTime();
      const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      if (nowMs >= start && nowMs < end) {
        activeSlotNeg = slot;
        break;
      }
    }
    if (activeSlotNeg && activeSlotNeg.endIso) {
      const slotEndMs = new Date(activeSlotNeg.endIso).getTime();
      const rangeStartMs = slotEndMs - halfSpreadMs;
      const rangeEndMs   = slotEndMs + halfSpreadMs;
      if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
        return {
          mode: 'PREDICTION_RANGE',
          overrunMinutes: 0,
          communityElevated: false,
          statusLine: 'نطاق التوقع نشط — التغيير محتمل',
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          transitionMode,
        };
      }
    }
    // Still within current active slot, well before end → NORMAL
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null, inValidationWindow: false, validationWindowRemainingMin: 0, transitionMode };
  }

  // ── POSITIVE / NEUTRAL OFFSET: standard active-slot check ─────────────────
  //
  // Positive-offset users are BEHIND Growatt. By the time their shifted
  // transition time arrives Growatt has already confirmed the duration.
  // Neutral-offset users align exactly with Growatt.
  // Both use the straightforward active-slot + overrun approach.
  //
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
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null, inValidationWindow: false, validationWindowRemainingMin: 0, transitionMode };
  }

  const slotEndMs = new Date(activeSlot.endIso).getTime();
  const rangeStartMs = slotEndMs - halfSpreadMs;
  const rangeEndMs = slotEndMs + halfSpreadMs;
  const overrunMs = Math.max(0, nowMs - rangeEndMs);
  const overrunMin = overrunMs / 60_000;

  if (nowMs < rangeStartMs) {
    return { mode: 'NORMAL', overrunMinutes: 0, communityElevated: false, statusLine: null, inValidationWindow: false, validationWindowRemainingMin: 0, transitionMode };
  }

  if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
    return {
      mode: 'PREDICTION_RANGE',
      overrunMinutes: 0,
      communityElevated: false,
      statusLine: 'نطاق التوقع نشط — التغيير محتمل',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      transitionMode,
    };
  }

  // Post-range: positive offset → WAITING_FOR_GROWATT
  // (spec §POSITIVE OFFSET BEHAVIOR)
  if (offsetMinutes > 0) {
    return {
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMin,
      communityElevated: transitionMode === 'MANUAL',
      statusLine: transitionMode === 'MANUAL'
        ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي'
        : 'بانتظار تأكيد الحساس الرئيسي أو بلاغ مجتمعي',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      transitionMode,
    };
  }

  // Neutral DSD (= 0): GRACE_MODE for 15 minutes then WAITING_FOR_GROWATT
  // (spec §NEUTRAL OFFSET BEHAVIOR)
  if (overrunMs <= GRACE_PERIOD_MS) {
    return {
      mode: 'GRACE_MODE',
      overrunMinutes: overrunMin,
      communityElevated: false,
      statusLine: 'تأخر غير معتاد — لا يزال التشغيل مستمراً خارج النطاق المتوقع',
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      transitionMode,
    };
  }

  return {
    mode: 'WAITING_FOR_GROWATT',
    overrunMinutes: overrunMin,
    communityElevated: true,
    statusLine: transitionMode === 'MANUAL'
      ? 'وضع يدوي — بانتظار بلاغك أو تأكيد مجتمعي لإنهاء الدورة'
      : 'النمط الحالي ممتد بشكل غير معتاد — بانتظار تأكيد تغير الحالة',
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    transitionMode,
  };
}

function atcShouldHold(mode: ScheduleStateMode): boolean {
  // During any of these modes ATC prevents automatic state transition.
  // GRACE_MODE also holds — the cycle continues until confirmation arrives.
  return (
    mode === 'UNCERTAIN_ZONE' ||
    mode === 'WAITING_FOR_GROWATT' ||
    mode === 'PREDICTION_RANGE' ||
    mode === 'GRACE_MODE'
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

    const minMin = Math.max(0, minFromNow - halfSpread);
    const maxMin = Math.max(0, minFromNow + halfSpread);
    const earliestIso = shiftMs(slot.startIso, -halfSpread * 60_000);
    const latestIso = shiftMs(slot.startIso, halfSpread * 60_000);

    // Check if current time is already inside the range window
    const rangeStartMs = new Date(earliestIso).getTime();
    const rangeEndMs = new Date(latestIso).getTime();
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
// Spec §3 / TMMS §PRINCIPLE 3: Home Screen must ALWAYS reflect the USER's
// personal schedule, never Growatt's live state directly.
//
// CRITICAL: For negative-offset users in UNCERTAIN_ZONE, the schedule may
// have already advanced to the NEXT slot (state flipped automatically by time).
// deriveCurrentStateATC must HOLD the PREVIOUS slot's state — the one that
// was active BEFORE the uncertain zone began. Selecting `findBestSlot()`
// (last slot that started before now) would return the NEW slot and incorrectly
// advance the user's state. Instead, we find the last slot that ended before now
// (i.e., the justEndedSlot) and return ITS state as the held state.
function deriveCurrentStateATC(
  effectiveSlots: ShiftedScheduleSlot[],
  atcMode: ScheduleStateMode,
  masterCurrentState: 'ON' | 'OFF',
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
): { state: 'ON' | 'OFF'; startIso: string | null } {
  if (resyncPoint) {
    return { state: resyncPoint.syncedState, startIso: resyncPoint.syncedAtIso };
  }

  const nowMs = Date.now();

  // ── Helper: derive state when no slot has started yet ─────────────────────
  const derivePreScheduleState = (): { state: 'ON' | 'OFF'; startIso: string | null } => {
    if (effectiveSlots.length > 0) {
      const preState: 'ON' | 'OFF' = effectiveSlots[0].state === 'ON' ? 'OFF' : 'ON';
      return { state: preState, startIso: null };
    }
    return { state: masterCurrentState, startIso: null };
  };

  // ── ATC hold path ──────────────────────────────────────────────────────────
  if (atcShouldHold(atcMode)) {
    // For UNCERTAIN_ZONE (negative offset): the schedule may have advanced past
    // the slot boundary. We need to find the slot that was active just BEFORE
    // the uncertain zone started — i.e., the slot whose endIso is most recently
    // in the past (the "justEndedSlot"). Its state is what we hold.
    //
    // For WAITING_FOR_GROWATT / GRACE_MODE / PREDICTION_RANGE (positive/neutral):
    // The currently active slot is still the right one; we find the last slot
    // that started before now (which is still the same slot we're extending).
    //
    // Strategy: find the last slot that STARTED before now.
    // For negative-offset UNCERTAIN_ZONE: this will be the NEW slot (wrong).
    // Fix: for UNCERTAIN_ZONE, find the slot BEFORE the one that just started.
    if (atcMode === 'UNCERTAIN_ZONE') {
      // Find the most recently ENDED slot (its endIso is in the past)
      // This is the slot whose predicted end triggered UNCERTAIN_ZONE.
      let heldSlot: ShiftedScheduleSlot | null = null;
      for (let i = 0; i < effectiveSlots.length; i++) {
        const s = effectiveSlots[i];
        if (!s.endIso) continue;
        const endMs = new Date(s.endIso).getTime();
        if (endMs <= nowMs) {
          heldSlot = s; // keep updating — we want the most recent ended slot
        } else {
          break;
        }
      }
      // heldSlot is the last slot that ended. Its state is what we hold.
      // (The next slot may have already started in the schedule, but we ignore it
      //  until a valid exit condition fires.)
      if (heldSlot) return { state: heldSlot.state, startIso: heldSlot.startIso };
      return derivePreScheduleState();
    }

    // For WAITING_FOR_GROWATT / GRACE_MODE / PREDICTION_RANGE:
    // find the last slot that started at or before now
    let best: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
      else break;
    }
    if (best) return { state: best.state, startIso: best.startIso };
    return derivePreScheduleState();
  }

  // ── Normal schedule-driven path ───────────────────────────────────────────
  let best: ShiftedScheduleSlot | null = null;
  for (const slot of effectiveSlots) {
    if (new Date(slot.startIso).getTime() <= nowMs) best = slot;
    else break;
  }
  if (best) return { state: best.state, startIso: best.startIso };
  return derivePreScheduleState();
}

// ── Human-friendly Arabic duration range label (spec §23) ──────────────────────
// Converts RangeLabel min/max to Arabic like:
//   "من ساعتين إلى ساعتين و15 دقيقة"  (ON)
//   "من 8 ساعات إلى 9 ساعات و12 دقيقة" (OFF)
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
// FORMULA (spec §NEGATIVE OFFSET BEHAVIOR / §FINAL IMPLEMENTATION REQUIREMENT):
//
//   UserCycleStartTime = GrowattTransitionTime + UserOffset
//
// Since offset is negative for ahead-of-Growatt users:
//   GrowattTransitionTime = 04:00, Offset = -60 min
//   → UserCycleStartTime = 03:00  (60 minutes in the past)
//
// For positive offset (behind-Growatt users):
//   GrowattTransitionTime = 12:00, Offset = +60 min
//   → UserCycleStartTime = 13:00  (60 minutes in the future — user hasn't
//     transitioned yet, so we return null and let the schedule drive it)
//
// For neutral offset:
//   UserCycleStartTime = GrowattTransitionTime (no shift)
//
// ELAPSED TIME after reconciliation:
//   elapsed = now - UserCycleStartTime
//   Example: now=04:00, UserCycleStart=03:00 → elapsed = 60 min → "منذ ساعة"
//
// This must NEVER show "للتو" (just now) when the offset-adjusted start
// was in the past — that would violate the offset model.
function computeReconciledCycleStart(
  growattLastTransitionAt: string | null,
  offsetMs: number,
  heldState: 'ON' | 'OFF',
  masterCurrentState: 'ON' | 'OFF',
): string | null {
  // Only applies when Growatt has confirmed a transition (state flipped)
  if (heldState === masterCurrentState) return null;
  if (!growattLastTransitionAt) return null;

  // UserCycleStartTime = GrowattTransitionTime + Offset
  // For negative offset (ahead of Growatt): result is in the PAST → valid
  // For positive offset (behind Growatt):   result is in the FUTURE → null
  //   (positive-offset users: the schedule's shifted slot will naturally
  //    become the active slot once GrowattTransitionTime + offset passes)
  const reconciledStartMs = new Date(growattLastTransitionAt).getTime() + offsetMs;

  // Only return if the reconciled start is already in the past.
  // Future-dated reconciliations for positive-offset users are handled by
  // the schedule slot becoming active at the correct shifted time.
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
  /** ISO of the start of the current HELD state (for lost-time reconciliation) */
  heldCycleStartIso?: string | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;

  const extended = extendScheduleTo48h(prediction.daySchedule ?? [], prediction);
  let effectiveSlots = applyOffsetToSlots(extended, offsetMs);

  const hasResync = !!resyncPoint;
  if (resyncPoint) {
    effectiveSlots = applyCommunityDelta(effectiveSlots, resyncPoint);
  }

  const atcState = computeATCState(effectiveSlots, offsetMinutes, resyncPoint ?? null, prediction, transitionMode);

  let { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(effectiveSlots, atcState.mode, prediction.currentState, resyncPoint ?? null, transitionMode);

  let isHolding = atcShouldHold(atcState.mode);
  let finalAtcState = atcState;
  let reconciledCycleStartIso: string | null = null;

  // ── UNCERTAIN_ZONE EXIT via Growatt confirmation ──────────────────────────
  //
  // Spec §NEGATIVE OFFSET BEHAVIOR / §VALID EXIT CONDITIONS:
  //
  // A negative-offset user in UNCERTAIN_ZONE may exit ONLY via:
  //   Priority 1: User report           (handled by resyncPoint / report flow)
  //   Priority 2: Community confirmation (handled by resyncPoint)
  //   Priority 3: Growatt state change   ← handled here (AUTO mode only)
  //
  // When Growatt transitions (prediction.currentState flips relative to our
  // held state), we IMMEDIATELY exit UNCERTAIN_ZONE and backdate the new
  // cycle start using the formula:
  //
  //   UserCycleStartTime = GrowattTransitionTime + Offset
  //
  // Example (spec §EXAMPLE 1):
  //   Growatt transitions OFF at 12:00, user offset = -60 min
  //   → UserCycleStartTime = 11:00
  //   → At 12:00, display: "OFF — منذ ساعة"
  //   → NEVER show "منذ للتو"
  //
  // In MANUAL mode: Growatt transition does NOT exit UNCERTAIN_ZONE.
  //   Only community/user reports can exit it.
  if (
    atcState.mode === 'UNCERTAIN_ZONE' &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState // Growatt confirmed a state flip
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      offsetMs,
      currentState,            // heldState  = old state we're leaving
      prediction.currentState, // newState   = Growatt's confirmed new state
    );

    if (backdatedStart) {
      // backdatedStart = GrowattTransitionTime + offsetMs (always in the past
      // for negative-offset users since offsetMs < 0)
      reconciledCycleStartIso = backdatedStart;
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = backdatedStart;
      isHolding = false;
      finalAtcState = {
        ...atcState,
        mode: 'NORMAL',
        overrunMinutes: 0,
        statusLine: null,
        communityElevated: false,
      };
    }
    // If backdatedStart is null it means computeReconciledCycleStart returned
    // null — this should not happen for negative offsets (offset < 0 means
    // GrowattTime + offsetMs < GrowattTime < now), but as a safety fallback
    // we still exit the hold and use Growatt's transition time directly.
    else if (prediction.lastTransitionAt) {
      // Fallback: use raw Growatt transition time (offset = 0 case)
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = prediction.lastTransitionAt;
      isHolding = false;
      finalAtcState = {
        ...atcState,
        mode: 'NORMAL',
        overrunMinutes: 0,
        statusLine: null,
        communityElevated: false,
      };
    }
  }

  // ── WAITING_FOR_GROWATT / GRACE_MODE EXIT (positive / neutral offset, AUTO) ─
  //
  // Spec §POSITIVE OFFSET BEHAVIOR:
  //   Positive-offset users are BEHIND Growatt. By the time their shifted
  //   transition time arrives, Growatt has already confirmed the state change.
  //   We exit WAITING_FOR_GROWATT when:
  //     a) Growatt has confirmed AND the shifted schedule slot is now active, OR
  //     b) reconciledCycleStart (= GrowattTransitionTime + positiveOffset) has
  //        already passed (meaning the user's time has come)
  //
  // Spec §NEUTRAL OFFSET BEHAVIOR:
  //   Same as positive but offset = 0 → UserCycleStart = GrowattTransitionTime
  if (
    (atcState.mode === 'WAITING_FOR_GROWATT' || atcState.mode === 'GRACE_MODE') &&
    transitionMode === 'AUTO' &&
    prediction.currentState !== currentState // Growatt confirmed a flip
  ) {
    const backdatedStart = computeReconciledCycleStart(
      prediction.lastTransitionAt,
      offsetMs,
      currentState,
      prediction.currentState,
    );

    if (backdatedStart) {
      // For neutral/small-positive offset: GrowattTime + 0 = GrowattTime (past) → exits immediately
      // For large positive offset: GrowattTime + positiveMs may still be future → computeReconciledCycleStart returns null
      //   In that case the hold continues until the shifted schedule slot becomes active naturally.
      reconciledCycleStartIso = backdatedStart;
      currentState = prediction.currentState as 'ON' | 'OFF';
      currentStateStartIso = backdatedStart;
      isHolding = false;
      finalAtcState = {
        ...atcState,
        mode: 'NORMAL',
        overrunMinutes: 0,
        statusLine: null,
        communityElevated: false,
      };
    }
    // For positive offset where reconciledStart is still in the future:
    // Keep holding. The shifted schedule slot will become active once
    // GrowattTransitionTime + positiveOffset passes, and deriveCurrentStateATC
    // (non-hold path) will naturally pick it up on the next re-render.
  }

  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction);

  const durLabel = elapsedLabel(reconciledCycleStartIso ?? currentStateStartIso);

  return {
    nextTransition,
    // Spec §23: human-friendly Arabic range labels
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
    daySchedule: effectiveSlots,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode ?? 'prior_only',
    computedAt: prediction.computedAt ?? null,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisMode ?? false,
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
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  /** Passed from useStateAnchor — start of currently anchored state (for lost-time reconciliation) */
  heldCycleStartIso?: string | null,
) {
  const [rawPrediction, setRawPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(true);

  // Stable startIso anchor — only reset when the utility state actually flips
  // OR when offsetMinutes changes (new report shifted the schedule).
  // Prevents prediction DB refreshes from resetting the "منذ" elapsed counter.
  const stableStartRef = useRef<{ state: 'ON' | 'OFF'; startIso: string | null } | null>(null);
  const prevOffsetRef  = useRef<number>(offsetMinutes);

  // Fetch (or re-fetch) the latest prediction row from Supabase.
  // Extracted so it can be called both on mount and on AppState foreground resume.
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

    // Initial fetch
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

    // Re-fetch every time the app returns to foreground so the schedule is
    // always fresh after the user switches back from another app.
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

  // Reset start anchor when offset changes so new slot times are adopted
  // immediately after the user submits a report that shifts their offset.
  // Also trigger a fresh DB fetch so the schedule UI reflects the latest
  // prediction row without waiting for the next real-time event or foreground resume.
  // IMPORTANT: This useEffect must be at the top level of the hook — never inside
  // a conditional or IIFE — to satisfy React's Rules of Hooks.
  useEffect(() => {
    if (prevOffsetRef.current !== offsetMinutes) {
      prevOffsetRef.current  = offsetMinutes;
      stableStartRef.current = null;
      fetchPrediction();
    }
  }, [offsetMinutes]);

  const userPrediction: UserPrediction | null = rawPrediction
    ? (() => {
        const pred = applyOffsetToPrediction(rawPrediction, offsetMinutes, resyncPoint, null, transitionMode, heldCycleStartIso ?? null);

        // ── Stabilize currentStateStartIso ─────────────────────────────────────
        //
        // Rules (in priority order):
        //
        // 1. If a reconciledCycleStartIso is present (UNCERTAIN_ZONE just exited
        //    via Growatt), it is the authoritative backdated start.  Store it in
        //    the ref and never let an older ref value override it.
        //
        // 2. If the utility state flipped (ON→OFF or OFF→ON), adopt the new
        //    startIso from the computation and update the ref.
        //
        // 3. If the state is unchanged and no reconciliation just happened, keep
        //    the ref's startIso so the elapsed timer never jumps on prediction
        //    DB refreshes.
        //
        // This ensures that after UNCERTAIN_ZONE exits with a backdated start
        // the elapsed label correctly shows "منذ ساعة" rather than "للتو".

        if (pred.reconciledCycleStartIso) {
          // Reconciliation wins — always adopt and persist the backdated start.
          stableStartRef.current = {
            state: pred.currentState,
            startIso: pred.reconciledCycleStartIso,
          };
          pred.currentStateStartIso = pred.reconciledCycleStartIso;
        } else if (
          stableStartRef.current &&
          stableStartRef.current.state === pred.currentState
        ) {
          // Same state, no reconciliation — reuse the stable anchor.
          pred.currentStateStartIso = stableStartRef.current.startIso;
        } else {
          // State changed (or first render) — adopt the computed startIso.
          stableStartRef.current = {
            state: pred.currentState,
            startIso: pred.currentStateStartIso,
          };
        }

        // Recompute duration label using the stabilised startIso
        // (applyOffsetToPrediction computed it before stableStartRef correction)
        pred.currentStateDurationLabel = elapsedLabel(pred.currentStateStartIso);

        return pred;
      })()
    : null;

  return { userPrediction, rawPrediction, loading };
}
