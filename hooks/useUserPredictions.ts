/**
 * useUserPredictions — ATC (Adaptive Transition Controller) state machine.
 *
 * Applies user offset + community resync to the raw Growatt prediction,
 * producing a personalised UserPrediction with a ScheduleStateMode that
 * drives the Home screen, Schedule screen, and Nearby Users map.
 *
 * State machine priority (highest → lowest):
 *   COMMUNITY_SYNCED        — active resync point overrides everything
 *   POSITIVE_OFFSET_PENDING — Growatt flipped, user hold window active
 *   UNCERTAIN_ZONE          — negative offset, Growatt hasn't confirmed yet
 *   PREDICTION_RANGE        — within the predicted transition window
 *   GRACE_MODE              — past prediction window, short grace period
 *   WAITING_FOR_GROWATT     — past grace, waiting for hardware confirmation
 *   NORMAL                  — schedule-derived, no special condition
 */

import { useEffect, useState } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';
import type { TransitionMode } from './useTransitionMode';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ShiftedScheduleSlot extends ScheduleSlot {
  /** Shifted start ISO (= original + offsetMs) */
  shiftedStartIso: string;
  /** Shifted end ISO */
  shiftedEndIso: string | null;
  /** Formatted shifted start for display */
  shiftedStartFormatted: string | null;
  /** Formatted shifted end for display */
  shiftedEndFormatted: string | null;
  /** Whether this slot was modified by a community resync */
  isResynced: boolean;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string | null;
}

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  statusLine: string;
  transitionMode: TransitionMode;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  /** ISO time of the scheduled auto-transition (POSITIVE_OFFSET_PENDING only) */
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction {
  // Current state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  isHoldingState: boolean;

  // Stability
  isUnstable: boolean;
  crisisMode: boolean;
  crisisReason: string | null;
  stabilityScore: number;
  stabilityLabel: string;
  confidence: number;
  confidenceLabel: string;

  // Community sync
  isResynced: boolean;
  resyncedAtIso: string | null;
  communitySyncMeta: CommunitySyncMeta | null;

  // Next transition (personalised, offset-shifted)
  nextTransition: {
    type: 'UTILITY_ON' | 'UTILITY_OFF';
    rangeStartIso: string;
    rangeEndIso: string;
    rangeLabel: string;
    minFromNowMin: number;
    maxFromNowMin: number;
    waitLabel: string;
    inRangeWindow: boolean;
  } | null;

  // Schedule
  daySchedule: ShiftedScheduleSlot[];

  // Duration labels
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

  // Metadata
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string;
  offsetMinutes: number;

  // ATC state
  atc: ATCState;
}

// ResyncPoint shape (mirrors ResyncContext)
interface ResyncPoint {
  syncedAtIso: string;
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
  reporterName?: string | null;
  reporterReliability?: number | null;
  expiresAtIso?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION_WINDOW_MIN = 10; // minutes after resync where Growatt divergence is ignored
const GRACE_WINDOW_MIN = 20;      // minutes past prediction range before WAITING_FOR_GROWATT

function fmtTimeYemen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function fmtMin(min: number): string {
  const h = Math.floor(Math.abs(min) / 60);
  const m = Math.round(Math.abs(min) % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h} س و ${m} د`;
}

/** Shift a ScheduleSlot by offsetMs, returning a ShiftedScheduleSlot */
function shiftSlot(slot: ScheduleSlot, offsetMs: number): ShiftedScheduleSlot {
  const shiftedStartIso = new Date(new Date(slot.startIso).getTime() + offsetMs).toISOString();
  const shiftedEndIso = slot.endIso
    ? new Date(new Date(slot.endIso).getTime() + offsetMs).toISOString()
    : null;

  return {
    ...slot,
    shiftedStartIso,
    shiftedEndIso,
    shiftedStartFormatted: fmtTimeYemen(shiftedStartIso),
    shiftedEndFormatted: shiftedEndIso ? fmtTimeYemen(shiftedEndIso) : null,
    isResynced: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// applyOffsetToPrediction — pure function, exported for admin/nearby-users use
// ─────────────────────────────────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso?: string | null,
): UserPrediction {
  const nowMs = Date.now();
  const offsetMs = offsetMinutes * 60_000;

  // ── Shift schedule ────────────────────────────────────────────────────────
  const shiftedSlots: ShiftedScheduleSlot[] = (prediction.daySchedule ?? []).map(s =>
    shiftSlot(s, offsetMs)
  );

  // ── Community sync check ──────────────────────────────────────────────────
  const resyncActive = (() => {
    if (!resyncPoint) return false;
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    if (nowMs < syncMs) return false; // future sync not yet active
    if (resyncPoint.expiresAtIso && nowMs > new Date(resyncPoint.expiresAtIso).getTime()) return false;
    return true;
  })();

  if (resyncActive && resyncPoint) {
    // Derive current state from resync
    const resyncState: 'ON' | 'OFF' = resyncPoint.reportedState === 'UTILITY_ON' ? 'ON' : 'OFF';
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const sinceResyncMin = (nowMs - syncMs) / 60_000;
    const inValidationWindow = sinceResyncMin < VALIDATION_WINDOW_MIN;
    const validationWindowRemainingMin = Math.max(0, VALIDATION_WINDOW_MIN - sinceResyncMin);

    // Build next transition from shifted schedule (first slot that changes state after resync)
    const futureSlot = shiftedSlots.find(s => {
      const start = new Date(s.shiftedStartIso).getTime();
      return start > nowMs && s.state !== resyncState;
    }) ?? null;

    const nt = futureSlot
      ? buildNextTransition(futureSlot, nowMs)
      : (prediction.nextTransition
        ? buildNextTransitionFromRaw(prediction.nextTransition, offsetMs, nowMs)
        : null);

    // Mark resynced slot
    const scheduleWithResync = shiftedSlots.map(s => {
      const slotStart = new Date(s.shiftedStartIso).getTime();
      const slotEnd = s.shiftedEndIso ? new Date(s.shiftedEndIso).getTime() : Infinity;
      if (nowMs >= slotStart && nowMs < slotEnd) return { ...s, isResynced: true };
      return s;
    });

    return {
      currentState: resyncState,
      currentStateStartIso: resyncPoint.syncedAtIso,
      isHoldingState: false,
      isUnstable: prediction.isUnstable,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      isResynced: true,
      resyncedAtIso: resyncPoint.syncedAtIso,
      communitySyncMeta: {
        reporterName: resyncPoint.reporterName ?? null,
        reporterReliability: resyncPoint.reporterReliability ?? null,
        syncedAtIso: resyncPoint.syncedAtIso,
      },
      nextTransition: nt,
      daySchedule: scheduleWithResync,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
      reasoning: prediction.reasoning,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      offsetMinutes,
      atc: {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        statusLine: 'الحالة مزامَنة مجتمعياً',
        transitionMode,
        communityElevated: false,
        inValidationWindow,
        validationWindowRemainingMin,
        scheduledAutoTransitionIso: null,
      },
    };
  }

  // ── Find current shifted slot ─────────────────────────────────────────────
  const currentShiftedSlot = shiftedSlots.find(s => {
    const start = new Date(s.shiftedStartIso).getTime();
    const end = s.shiftedEndIso ? new Date(s.shiftedEndIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // Growatt's actual current state
  const growattState = prediction.currentState;

  // The user's personalised current state from shifted schedule
  const userCurrentState: 'ON' | 'OFF' = currentShiftedSlot?.state ?? growattState;

  // ── POSITIVE_OFFSET_PENDING detection ────────────────────────────────────
  // Growatt has already transitioned to a new state, but the user's shifted
  // schedule still has them in the OLD state. The pending window is active.
  //
  // Find the next shifted slot that differs from growattState and hasn't started yet.
  const growattCurrentState = prediction.currentState;
  const pendingTransitionSlot = (() => {
    if (offsetMinutes <= 0) return null;
    // The user's schedule is shifted FORWARD. Find the upcoming shift boundary.
    return shiftedSlots.find(s => {
      const start = new Date(s.shiftedStartIso).getTime();
      return start > nowMs && s.state !== growattCurrentState;
    }) ?? null;
  })();

  // POSITIVE_OFFSET_PENDING: Growatt is already in different state than user's schedule slot
  const isPositiveOffsetPending = (() => {
    if (offsetMinutes <= 0) return false;
    if (!currentShiftedSlot) return false;
    // The current shifted slot state differs from Growatt's state AND Growatt has moved on
    return currentShiftedSlot.state !== growattCurrentState;
  })();

  if (isPositiveOffsetPending && currentShiftedSlot) {
    const scheduledEndIso = currentShiftedSlot.shiftedEndIso;
    const scheduledEndMs = scheduledEndIso ? new Date(scheduledEndIso).getTime() : nowMs + offsetMs;
    const scheduledAutoTransitionIso = scheduledEndIso;

    // Inject a synthetic slot at the front representing the held state
    const syntheticSlot: ShiftedScheduleSlot = {
      ...currentShiftedSlot,
      shiftedEndIso: scheduledAutoTransitionIso,
      shiftedEndFormatted: scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : null,
      endIso: scheduledAutoTransitionIso,
      endFormatted: scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : null,
    };

    const futureSlots = shiftedSlots.filter(s => {
      const start = new Date(s.shiftedStartIso).getTime();
      return start >= scheduledEndMs;
    });

    const dayScheduleWithSynthetic = [syntheticSlot, ...futureSlots];

    const minFromNow = Math.max(0, (scheduledEndMs - nowMs) / 60_000);
    const nextType: 'UTILITY_ON' | 'UTILITY_OFF' = growattCurrentState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON';
    const nt = scheduledAutoTransitionIso ? {
      type: nextType,
      rangeStartIso: scheduledAutoTransitionIso,
      rangeEndIso: scheduledAutoTransitionIso,
      rangeLabel: fmtTimeYemen(scheduledAutoTransitionIso),
      minFromNowMin: minFromNow,
      maxFromNowMin: minFromNow,
      waitLabel: fmtMin(minFromNow),
      inRangeWindow: minFromNow <= 0,
    } : null;

    return {
      currentState: currentShiftedSlot.state,
      currentStateStartIso: anchorStartIso ?? currentShiftedSlot.shiftedStartIso,
      isHoldingState: true,
      isUnstable: prediction.isUnstable,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      isResynced: false,
      resyncedAtIso: null,
      communitySyncMeta: null,
      nextTransition: nt,
      daySchedule: dayScheduleWithSynthetic,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
      reasoning: prediction.reasoning,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      offsetMinutes,
      atc: {
        mode: 'POSITIVE_OFFSET_PENDING',
        overrunMinutes: 0,
        statusLine: `سيتم التحديث تلقائياً في ${scheduledAutoTransitionIso ? fmtTimeYemen(scheduledAutoTransitionIso) : '…'}`,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso,
      },
    };
  }

  // ── UNCERTAIN_ZONE detection ──────────────────────────────────────────────
  // User's shifted schedule says they should be in a NEW state, but Growatt
  // hasn't confirmed the transition yet (negative offset — user is ahead).
  const isUncertainZone = (() => {
    if (offsetMinutes >= 0) return false;
    if (!currentShiftedSlot) return false;
    // The user's schedule says different state than Growatt's actual state
    return currentShiftedSlot.state !== growattState;
  })();

  if (isUncertainZone && currentShiftedSlot) {
    // How far past the expected transition?
    const shiftedStartMs = new Date(currentShiftedSlot.shiftedStartIso).getTime();
    const overrunMs = nowMs - shiftedStartMs;
    const overrunMinutes = Math.max(0, overrunMs / 60_000);

    // Next transition from shifted schedule
    const futureSlot = shiftedSlots.find(s => {
      const start = new Date(s.shiftedStartIso).getTime();
      return start > nowMs && s.state !== currentShiftedSlot.state;
    }) ?? null;
    const nt = futureSlot
      ? buildNextTransition(futureSlot, nowMs)
      : (prediction.nextTransition
        ? buildNextTransitionFromRaw(prediction.nextTransition, offsetMs, nowMs)
        : null);

    return {
      currentState: currentShiftedSlot.state,
      currentStateStartIso: currentShiftedSlot.shiftedStartIso,
      isHoldingState: true,
      isUnstable: prediction.isUnstable,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      isResynced: false,
      resyncedAtIso: null,
      communitySyncMeta: null,
      nextTransition: nt,
      daySchedule: shiftedSlots,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
      reasoning: prediction.reasoning,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      offsetMinutes,
      atc: {
        mode: 'UNCERTAIN_ZONE',
        overrunMinutes,
        statusLine: `بانتظار تأكيد التغيير من Growatt — تجاوز ${Math.round(overrunMinutes)} دقيقة`,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
    };
  }

  // ── Normal schedule-driven state ─────────────────────────────────────────
  const currentStateStartIso = currentShiftedSlot?.shiftedStartIso
    ?? anchorStartIso
    ?? prediction.lastTransitionAt;

  // Determine ATC mode from prediction range and grace window
  const rawNt = prediction.nextTransition;
  let atcMode: ScheduleStateMode = 'NORMAL';
  let overrunMinutes = 0;
  let communityElevated = false;

  if (rawNt) {
    const rangeStartMs = new Date(rawNt.earliestTime).getTime() + offsetMs;
    const rangeEndMs   = new Date(rawNt.latestTime).getTime()   + offsetMs;
    const graceEndMs   = rangeEndMs + GRACE_WINDOW_MIN * 60_000;

    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
      atcMode = 'PREDICTION_RANGE';
      communityElevated = true;
    } else if (nowMs > rangeEndMs && nowMs <= graceEndMs) {
      atcMode = 'GRACE_MODE';
      overrunMinutes = (nowMs - rangeEndMs) / 60_000;
      communityElevated = true;
    } else if (nowMs > graceEndMs) {
      atcMode = 'WAITING_FOR_GROWATT';
      overrunMinutes = (nowMs - rangeEndMs) / 60_000;
      communityElevated = true;
    }
  }

  // Build next transition for normal mode
  const nt = rawNt
    ? buildNextTransitionFromRaw(rawNt, offsetMs, nowMs)
    : null;

  const statusLineMap: Record<ScheduleStateMode, string> = {
    NORMAL: 'الحالة طبيعية',
    PREDICTION_RANGE: 'نطاق التوقع نشط — التغيير محتمل الآن',
    UNCERTAIN_ZONE: 'بانتظار تأكيد التغيير',
    COMMUNITY_SYNCED: 'الحالة مزامَنة مجتمعياً',
    WAITING_FOR_GROWATT: 'تجاوزنا نطاق التوقع — بانتظار Growatt',
    GRACE_MODE: 'تأخر غير معتاد — مهلة المزامنة',
    POSITIVE_OFFSET_PENDING: 'تغيير تلقائي مجدول',
  };

  return {
    currentState: userCurrentState,
    currentStateStartIso,
    isHoldingState: false,
    isUnstable: prediction.isUnstable,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isResynced: false,
    resyncedAtIso: null,
    communitySyncMeta: null,
    nextTransition: nt,
    daySchedule: shiftedSlots,
    expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
    expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode,
    computedAt: prediction.computedAt,
    offsetMinutes,
    atc: {
      mode: atcMode,
      overrunMinutes,
      statusLine: statusLineMap[atcMode],
      transitionMode,
      communityElevated,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Next transition builders
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(slot: ShiftedScheduleSlot, nowMs: number) {
  const startMs = new Date(slot.shiftedStartIso).getTime();
  const endMs = slot.shiftedEndIso ? new Date(slot.shiftedEndIso).getTime() : startMs + 60 * 60_000;
  const midMs = (startMs + endMs) / 2;
  const minFromNow = Math.max(0, (midMs - nowMs) / 60_000);
  const inRangeWindow = nowMs >= startMs && nowMs <= endMs;
  return {
    type: (slot.state === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF') as 'UTILITY_ON' | 'UTILITY_OFF',
    rangeStartIso: slot.shiftedStartIso,
    rangeEndIso: slot.shiftedEndIso ?? slot.shiftedStartIso,
    rangeLabel: `${fmtTimeYemen(slot.shiftedStartIso)}${slot.shiftedEndIso ? ' — ' + fmtTimeYemen(slot.shiftedEndIso) : ''}`,
    minFromNowMin: Math.max(0, (startMs - nowMs) / 60_000),
    maxFromNowMin: Math.max(0, (endMs - nowMs) / 60_000),
    waitLabel: minFromNow > 0 ? fmtMin(minFromNow) : 'الآن',
    inRangeWindow,
  };
}

function buildNextTransitionFromRaw(
  rawNt: NonNullable<Prediction['nextTransition']>,
  offsetMs: number,
  nowMs: number,
) {
  const startMs = new Date(rawNt.earliestTime).getTime() + offsetMs;
  const endMs   = new Date(rawNt.latestTime).getTime()   + offsetMs;
  const midMs   = (startMs + endMs) / 2;
  const minFromNow = Math.max(0, (midMs - nowMs) / 60_000);
  const rangeStartIso = new Date(startMs).toISOString();
  const rangeEndIso   = new Date(endMs).toISOString();
  const inRangeWindow = nowMs >= startMs && nowMs <= endMs;
  return {
    type: rawNt.type,
    rangeStartIso,
    rangeEndIso,
    rangeLabel: `${fmtTimeYemen(rangeStartIso)} — ${fmtTimeYemen(rangeEndIso)}`,
    minFromNowMin: rawNt.minFromNowMin,
    maxFromNowMin: rawNt.maxFromNowMin,
    waitLabel: minFromNow > 0 ? fmtMin(minFromNow) : 'الآن',
    inRangeWindow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Duration label helper
// ─────────────────────────────────────────────────────────────────────────────

function buildDurationLabel(prediction: Prediction, type: 'ON' | 'OFF'): string | null {
  const pattern = prediction.currentPeriod === 'day'
    ? prediction.dayPattern
    : prediction.nightPattern;
  if (!pattern) return null;

  if (type === 'ON') {
    if (pattern.avgOnMin == null) return null;
    return `~${fmtMin(pattern.avgOnMin)}`;
  } else {
    return `~${fmtMin(pattern.avgOffMin)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// useUserPredictions — React hook
// ─────────────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number = 0,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso?: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);

  useEffect(() => {
    if (!prediction) {
      setUserPrediction(null);
      return;
    }
    const result = applyOffsetToPrediction(
      prediction,
      offsetMinutes,
      resyncPoint,
      transitionMode,
      anchorStartIso,
    );
    setUserPrediction(result);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  return { userPrediction, loading };
}
