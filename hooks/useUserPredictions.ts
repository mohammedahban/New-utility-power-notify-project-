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
      // Elevate community priority during validation window
      communityElevated: inValidationWindow,
      statusLine: inValidationWindow
        ? `نافذة التحقق نشطة — الحساس يُشير لتغيير · ${Math.ceil(validationRemainingMin)} د`
        : null,
      inValidationWindow,
      validationWindowRemainingMin: validationRemainingMin,
      transitionMode,
    };
  }

  // ── Find the active slot ──────────────────────────────────────────────────
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
  const halfSpreadMs = 15 * 60_000;
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

  // ── Post-range ATC logic per DSD sign (spec §14 / §6) ──────────────────────
  const GRACE_PERIOD_MS = 15 * 60_000;

  // ── TMMS: In MANUAL mode, Growatt transitions cannot trigger state changes.
  // For negative DSD, we always enter UNCERTAIN_ZONE regardless of mode.
  // For positive DSD in AUTO mode, we can trust Growatt has already confirmed
  // (spec §POSITIVE OFFSET BEHAVIOR: "rarely wait because Growatt already knows").
  // For positive DSD in MANUAL mode, community/user report required.
  // Negative DSD: user is ahead of Growatt → always UNCERTAIN_ZONE
  // (spec §14.1 / §6.1 / §NEGATIVE OFFSET BEHAVIOR: do not auto-transition)
  if (offsetMinutes < 0) {
    return {
      mode: 'UNCERTAIN_ZONE',
      overrunMinutes: overrunMin,
      communityElevated: true,
      statusLine: `استمرار غير معتاد — تجاوزت المدة المتوقعة بـ ${Math.ceil(overrunMin)} دقيقة — بانتظار تأكيد تغير الحالة`,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      transitionMode,
    };
  }

  // Positive DSD: user is behind Growatt → WAITING_FOR_GROWATT
  // (spec §14.2 / §6.3: Growatt has likely already confirmed — short wait)
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

  // Neutral DSD (≈ 0): enter GRACE_MODE for 15 minutes first
  // (spec §14.3 / §6.2: GRACE_MODE before WAITING_FOR_GROWATT)
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

  // Grace period expired → WAITING_FOR_GROWATT
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
// TMMS spec §MANUAL MODE:
//   In MANUAL mode, Growatt state changes (masterCurrentState) do NOT update
//   the user's current state. Only community/user resync can change it.
//   Growatt continues to feed APPPE learning only.
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
  const holding = atcShouldHold(atcMode);

  if (holding) {
    // TMMS §MANUAL MODE: in MANUAL mode, even if not holding due to ATC,
    // we keep the last known slot state — Growatt cannot force a transition.
    let bestSlot: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const startMs = new Date(slot.startIso).getTime();
      if (startMs <= nowMs) bestSlot = slot;
      else break;
    }
    if (bestSlot) return { state: bestSlot.state, startIso: bestSlot.startIso };
  }

  // TMMS §MANUAL MODE: Growatt's current state is ignored for user-facing display.
  // We derive state only from the effective schedule slots (which are offset-shifted
  // APPPE slots, not live Growatt state) so the user's personal timeline is respected.
  if (transitionMode === 'MANUAL') {
    // In MANUAL mode: find last slot before now in effective schedule.
    // This ignores masterCurrentState entirely.
    let bestSlot: ShiftedScheduleSlot | null = null;
    for (const slot of effectiveSlots) {
      const startMs = new Date(slot.startIso).getTime();
      if (startMs <= nowMs) bestSlot = slot;
      else break;
    }
    if (bestSlot) return { state: bestSlot.state, startIso: bestSlot.startIso };
    return { state: effectiveSlots[0]?.state ?? masterCurrentState, startIso: null };
  }

  // AUTO mode: use schedule slots (which already reflect Growatt timing + offset)
  for (let i = effectiveSlots.length - 1; i >= 0; i--) {
    const slot = effectiveSlots[i];
    if (new Date(slot.startIso).getTime() <= nowMs) {
      return { state: slot.state, startIso: slot.startIso };
    }
  }

  return { state: masterCurrentState, startIso: null };
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
// When exiting UNCERTAIN_ZONE via Growatt confirmation:
//   next cycle start = user cycle start + actual Growatt duration
// This prevents artificial gaps and correctly shows elapsed time in new state.
//
// Parameters:
//   userCycleStartIso: when the user's current (held) cycle began
//   growattActualDurationMin: the actual ON/OFF duration Growatt measured
//   heldState: the state that was being held during UNCERTAIN_ZONE
//   effectiveSlots: the shifted schedule to find the next slot
// Returns: the corrected start ISO for the next cycle (backdated start)
function computeReconciledCycleStart(
  userCycleStartIso: string | null,
  growattActualDurationMin: number | null,
  heldState: 'ON' | 'OFF',
  effectiveSlots: ShiftedScheduleSlot[],
  masterCurrentState: 'ON' | 'OFF',
): string | null {
  // Only applies when Growatt has confirmed a transition (state changed)
  if (heldState === masterCurrentState) return null;
  if (!userCycleStartIso || !growattActualDurationMin || growattActualDurationMin <= 0) return null;

  // Corrected user cycle end = user cycle start + actual Growatt duration
  // (spec: offset shifts timestamps only, never duration)
  const reconciledEndMs =
    new Date(userCycleStartIso).getTime() + growattActualDurationMin * 60_000;

  // Verify this is in the past (the cycle has already ended)
  if (reconciledEndMs >= Date.now()) return null;

  return new Date(reconciledEndMs).toISOString();
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

  const { state: currentState, startIso: currentStateStartIso } =
    deriveCurrentStateATC(effectiveSlots, atcState.mode, prediction.currentState, resyncPoint ?? null, transitionMode);

  const nextTransition = prediction.isUnstable
    ? null
    : deriveNextTransition(effectiveSlots, currentState, prediction);

  const isHolding = atcShouldHold(atcState.mode);

  // ── Lost-Time Reconciliation (spec §CYCLE CONTINUITY RULE) ─────────────────
  // When the system was holding in UNCERTAIN_ZONE and Growatt has now confirmed
  // the transition (masterCurrentState differs from held state), compute the
  // backdated start for the new cycle so elapsed time is correct and no gap
  // is created in the timeline.
  //
  // Growatt's actual duration = from its last transition to now (approximated
  // by the APPPE currentStateDurationMin which tracks the master cycle duration).
  const heldStateForReconciliation: 'ON' | 'OFF' | null =
    (atcState.mode === 'UNCERTAIN_ZONE' || isHolding) ? currentState : null;

  let reconciledCycleStartIso: string | null = null;
  if (
    heldStateForReconciliation !== null &&
    heldStateForReconciliation !== prediction.currentState &&
    heldCycleStartIso
  ) {
    // Growatt has confirmed the transition — compute reconciled start
    reconciledCycleStartIso = computeReconciledCycleStart(
      heldCycleStartIso,
      prediction.currentStateDurationMin, // Growatt's actual cycle duration
      heldStateForReconciliation,
      effectiveSlots,
      prediction.currentState,
    );
  }

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
    atc: atcState,
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
  /** Passed from useStateAnchor — the start of the currently anchored state */
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

        // ── Stabilize currentStateStartIso ────────────────────────────────────
        // Only update the anchor when the actual utility state changes (ON↔OFF).
        // If the state is the same as before, reuse the original startIso so
        // the "منذ" elapsed timer and schedule slot start time don't jump every
        // time the DB prediction refreshes.
        if (
          stableStartRef.current &&
          stableStartRef.current.state === pred.currentState
        ) {
          pred.currentStateStartIso = stableStartRef.current.startIso;
        } else {
          stableStartRef.current = {
            state: pred.currentState,
            startIso: pred.currentStateStartIso,
          };
        }

        return pred;
      })()
    : null;

  return { userPrediction, rawPrediction, loading };
}
