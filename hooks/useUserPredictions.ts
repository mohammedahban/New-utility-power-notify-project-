/**
 * useUserPredictions — ATC (Adaptive Transition Controller)
 *
 * Applies the user's personal DSD offset and community resync point to the
 * raw APPPE v4 prediction, producing a user-specific schedule and state.
 *
 * ATC Modes (ScheduleStateMode):
 *   NORMAL               — schedule matches Growatt with offset applied
 *   PREDICTION_RANGE     — current time is inside the predicted transition window
 *   UNCERTAIN_ZONE       — Growatt has NOT confirmed expected transition yet (neg offset)
 *   COMMUNITY_SYNCED     — state overridden by community resync
 *   WAITING_FOR_GROWATT  — schedule window passed, waiting for Growatt confirmation
 *   GRACE_MODE           — state still running well beyond expected duration
 *   POSITIVE_OFFSET_PENDING — Growatt already flipped, user's scheduled time is future
 */

import { useEffect, useState, useCallback } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';
import type { ResyncPoint } from '../contexts/ResyncContext';
import type { TransitionMode } from './useTransitionMode';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted: string | null;
  shiftedEndFormatted: string | null;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced: boolean;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
}

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  statusLine: string;
  scheduledAutoTransitionIso: string | null;
  transitionMode: TransitionMode;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
}

export interface UserPrediction {
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  offsetMinutes: number;

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

  daySchedule: ShiftedScheduleSlot[];
  confidence: number;
  confidenceLabel: string;
  stabilityScore: number;
  stabilityLabel: string;
  isUnstable: boolean;
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  reasoning: string[];
  computedAt: string | null;

  // ATC
  atc: ATCState;
  isHoldingState: boolean;

  // Community sync
  isResynced: boolean;
  resyncedAtIso: string | null;
  communitySyncMeta: CommunitySyncMeta | null;

  // Crisis
  crisisMode: boolean;
  crisisReason: string | null;

  // Typical durations (human-readable)
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTimeYemen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

const VALIDATION_WINDOW_MS = 20 * 60 * 1000; // 20 min
const GRACE_THRESHOLD_MS   = 30 * 60 * 1000; // 30 min overrun before GRACE_MODE
const PREDICTION_RANGE_MARGIN_MS = 5 * 60 * 1000; // 5 min before window start

// ── applyOffsetToPrediction (pure function, used by admin predictions page) ──

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso: string | null = null,
): UserPrediction {
  const nowMs = Date.now();
  const offsetMs = offsetMinutes * 60_000;

  // ── Community synced branch ───────────────────────────────────────────────
  if (resyncPoint) {
    const syncedMs = new Date(resyncPoint.syncedAtIso).getTime();
    const appliedMs = new Date(resyncPoint.appliedAtIso).getTime();
    const ageMs = nowMs - appliedMs;
    const inValidationWindow = ageMs < VALIDATION_WINDOW_MS;
    const validationWindowRemainingMin = inValidationWindow
      ? Math.ceil((VALIDATION_WINDOW_MS - ageMs) / 60_000)
      : 0;

    const shiftedSlots = buildShiftedSlots(prediction.daySchedule, offsetMs, resyncPoint);

    return {
      currentState: resyncPoint.syncedState,
      currentStateStartIso: resyncPoint.syncedAtIso,
      offsetMinutes,
      nextTransition: buildNextTransition(shiftedSlots, resyncPoint.syncedState, nowMs),
      daySchedule: shiftedSlots,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      isUnstable: prediction.isUnstable,
      learningMode: prediction.learningMode,
      reasoning: prediction.reasoning,
      computedAt: prediction.computedAt,
      atc: {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        statusLine: 'تمت المزامنة المجتمعية',
        scheduledAutoTransitionIso: null,
        transitionMode,
        communityElevated: false,
        inValidationWindow,
        validationWindowRemainingMin,
      },
      isHoldingState: false,
      isResynced: true,
      resyncedAtIso: resyncPoint.syncedAtIso,
      communitySyncMeta: {
        reporterName: resyncPoint.reporterName ?? null,
        reporterReliability: resyncPoint.reporterReliability ?? null,
        syncedAtIso: resyncPoint.syncedAtIso,
      },
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
    };
  }

  // ── Build user-shifted schedule ───────────────────────────────────────────
  const shiftedSlots = buildShiftedSlots(prediction.daySchedule, offsetMs, null);

  // Find the slot that "should" currently be active per user schedule
  const userCurrentSlot = shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime() + offsetMs;
    const end = s.endIso ? new Date(s.endIso).getTime() + offsetMs : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? shiftedSlots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  // Growatt current state
  const growattState = prediction.currentState;
  const userExpectedState = userCurrentSlot?.state ?? growattState;

  // ── Positive offset path ──────────────────────────────────────────────────
  // Growatt has already flipped, but user's scheduled time is still in the future.
  if (offsetMinutes > 0 && growattState !== userExpectedState) {
    // Find the user's scheduled transition time
    const nextUserSlot = shiftedSlots.find(s => {
      const start = new Date(s.startIso).getTime() + offsetMs;
      return start > nowMs && s.state === growattState;
    });
    const scheduledAutoTransitionIso = nextUserSlot
      ? new Date(new Date(nextUserSlot.startIso).getTime() + offsetMs).toISOString()
      : null;

    // Find the slot that's currently active from user perspective (pre-Growatt-flip)
    const heldSlot = shiftedSlots.find(s => {
      const start = new Date(s.startIso).getTime() + offsetMs;
      return start <= nowMs && s.state === userExpectedState;
    });

    const heldStartIso = heldSlot
      ? new Date(new Date(heldSlot.startIso).getTime() + offsetMs).toISOString()
      : anchorStartIso ?? prediction.lastTransitionAt;

    // Inject synthetic lingering slot at front representing held state
    const syntheticSlots = buildPositiveOffsetSchedule(
      shiftedSlots, userExpectedState, heldStartIso, scheduledAutoTransitionIso, offsetMs,
    );

    return {
      currentState: userExpectedState,
      currentStateStartIso: heldStartIso,
      offsetMinutes,
      nextTransition: scheduledAutoTransitionIso ? {
        type: (userExpectedState === 'ON' ? 'UTILITY_OFF' : 'UTILITY_ON') as 'UTILITY_ON' | 'UTILITY_OFF',
        rangeStartIso: scheduledAutoTransitionIso,
        rangeEndIso: scheduledAutoTransitionIso,
        rangeLabel: fmtTimeYemen(scheduledAutoTransitionIso),
        minFromNowMin: Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
        maxFromNowMin: Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
        waitLabel: '',
        inRangeWindow: false,
      } : null,
      daySchedule: syntheticSlots,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      isUnstable: prediction.isUnstable,
      learningMode: prediction.learningMode,
      reasoning: prediction.reasoning,
      computedAt: prediction.computedAt,
      atc: {
        mode: 'POSITIVE_OFFSET_PENDING',
        overrunMinutes: 0,
        statusLine: scheduledAutoTransitionIso
          ? `التغيير مجدول في ${fmtTimeYemen(scheduledAutoTransitionIso)}`
          : 'تغيير تلقائي مجدول',
        scheduledAutoTransitionIso,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
      },
      isHoldingState: true,
      isResynced: false,
      resyncedAtIso: null,
      communitySyncMeta: null,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
    };
  }

  // ── Negative offset path ──────────────────────────────────────────────────
  // User thinks transition happened before Growatt confirmed it.
  if (offsetMinutes < 0 && growattState !== userExpectedState) {
    // User is in UNCERTAIN_ZONE — waiting for Growatt to confirm
    const reconciledStartMs = nowMs + offsetMs; // backdated start
    const reconciledStartIso = new Date(reconciledStartMs).toISOString();

    // Overrun: how long has Growatt NOT confirmed yet
    const overrunMs = Math.max(0, nowMs - (new Date(anchorStartIso ?? prediction.lastTransitionAt ?? nowMs).getTime() + Math.abs(offsetMs)));
    const overrunMinutes = overrunMs / 60_000;

    return {
      currentState: userExpectedState,
      currentStateStartIso: reconciledStartIso,
      offsetMinutes,
      nextTransition: buildNextTransition(shiftedSlots, userExpectedState, nowMs),
      daySchedule: shiftedSlots,
      confidence: Math.max(0, prediction.confidence - 20),
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      isUnstable: prediction.isUnstable,
      learningMode: prediction.learningMode,
      reasoning: prediction.reasoning,
      computedAt: prediction.computedAt,
      atc: {
        mode: 'UNCERTAIN_ZONE',
        overrunMinutes,
        statusLine: `بانتظار تأكيد Growatt — تجاوز ${Math.ceil(overrunMinutes)} دقيقة`,
        scheduledAutoTransitionIso: null,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
      },
      isHoldingState: true,
      isResynced: false,
      resyncedAtIso: null,
      communitySyncMeta: null,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
    };
  }

  // ── Normal / ATC state machine ────────────────────────────────────────────
  const atcState = computeATCState(prediction, shiftedSlots, offsetMs, nowMs, transitionMode);

  // Determine current state start ISO
  const currentStateStartIso = (() => {
    if (anchorStartIso) {
      return new Date(new Date(anchorStartIso).getTime() + offsetMs).toISOString();
    }
    const activeSlot = shiftedSlots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    });
    return activeSlot ? new Date(new Date(activeSlot.startIso).getTime() + offsetMs).toISOString()
      : prediction.lastTransitionAt;
  })();

  return {
    currentState: growattState,
    currentStateStartIso,
    offsetMinutes,
    nextTransition: prediction.isUnstable ? null : buildNextTransition(shiftedSlots, growattState, nowMs),
    daySchedule: shiftedSlots,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    isUnstable: prediction.isUnstable,
    learningMode: prediction.learningMode,
    reasoning: prediction.reasoning,
    computedAt: prediction.computedAt,
    atc: atcState,
    isHoldingState: atcState.mode !== 'NORMAL' && atcState.mode !== 'PREDICTION_RANGE',
    isResynced: false,
    resyncedAtIso: null,
    communitySyncMeta: null,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    expectedOnDurationLabel: buildDurationLabel(prediction, 'ON'),
    expectedOffDurationLabel: buildDurationLabel(prediction, 'OFF'),
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildShiftedSlots(
  slots: ScheduleSlot[],
  offsetMs: number,
  resyncPoint: ResyncPoint | null,
): ShiftedScheduleSlot[] {
  return slots.map(slot => {
    const shiftedStartMs = new Date(slot.startIso).getTime() + offsetMs;
    const shiftedEndMs = slot.endIso ? new Date(slot.endIso).getTime() + offsetMs : null;

    const shiftedStartIso = new Date(shiftedStartMs).toISOString();
    const shiftedEndIso = shiftedEndMs ? new Date(shiftedEndMs).toISOString() : null;

    const shiftedStartFormatted = offsetMs !== 0 ? fmtTimeYemen(shiftedStartIso) : null;
    const shiftedEndFormatted = (offsetMs !== 0 && shiftedEndIso) ? fmtTimeYemen(shiftedEndIso) : null;

    const isResynced = resyncPoint
      ? Math.abs(new Date(slot.startIso).getTime() - new Date(resyncPoint.syncedAtIso).getTime()) < 60_000
      : false;

    return {
      state: slot.state,
      startIso: shiftedStartIso,
      endIso: shiftedEndIso,
      startFormatted: slot.startFormatted,
      endFormatted: slot.endFormatted,
      shiftedStartFormatted,
      shiftedEndFormatted,
      durationLabel: slot.durationLabel,
      zone: slot.zone,
      isEstimated: slot.isEstimated,
      isResynced,
    };
  });
}

function buildPositiveOffsetSchedule(
  shiftedSlots: ShiftedScheduleSlot[],
  heldState: 'ON' | 'OFF',
  heldStartIso: string | null,
  scheduledTransitionIso: string | null,
  offsetMs: number,
): ShiftedScheduleSlot[] {
  // Synthetic slot: the held current state ending at scheduledTransitionIso
  const syntheticSlot: ShiftedScheduleSlot = {
    state: heldState,
    startIso: heldStartIso ?? new Date().toISOString(),
    endIso: scheduledTransitionIso,
    startFormatted: heldStartIso ? fmtTimeYemen(heldStartIso) : '',
    endFormatted: scheduledTransitionIso ? fmtTimeYemen(scheduledTransitionIso) : null,
    shiftedStartFormatted: heldStartIso ? fmtTimeYemen(heldStartIso) : null,
    shiftedEndFormatted: scheduledTransitionIso ? fmtTimeYemen(scheduledTransitionIso) : null,
    durationLabel: null,
    zone: 'user_offset',
    isEstimated: false,
    isResynced: false,
  };

  // Then the remaining slots starting from the scheduled transition
  const remainingSlots = scheduledTransitionIso
    ? shiftedSlots.filter(s => new Date(s.startIso).getTime() >= new Date(scheduledTransitionIso).getTime())
    : shiftedSlots;

  return [syntheticSlot, ...remainingSlots];
}

function buildNextTransition(
  slots: ShiftedScheduleSlot[],
  currentState: 'ON' | 'OFF',
  nowMs: number,
): UserPrediction['nextTransition'] {
  const nextSlot = slots.find(s => {
    return s.state !== currentState && new Date(s.startIso).getTime() > nowMs;
  });
  if (!nextSlot) return null;

  const startMs = new Date(nextSlot.startIso).getTime();
  const endMs = nextSlot.endIso ? new Date(nextSlot.endIso).getTime() : startMs;
  const minFromNow = Math.max(0, (startMs - nowMs) / 60_000);
  const maxFromNow = Math.max(0, (endMs - nowMs) / 60_000);
  const inRangeWindow = nowMs >= startMs - PREDICTION_RANGE_MARGIN_MS && nowMs <= endMs;

  return {
    type: (nextSlot.state === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF') as 'UTILITY_ON' | 'UTILITY_OFF',
    rangeStartIso: nextSlot.startIso,
    rangeEndIso: nextSlot.endIso ?? nextSlot.startIso,
    rangeLabel: `${fmtTimeYemen(nextSlot.startIso)}${nextSlot.endIso ? ` — ${fmtTimeYemen(nextSlot.endIso)}` : ''}`,
    minFromNowMin: minFromNow,
    maxFromNowMin: maxFromNow,
    waitLabel: minFromNow < 1 ? 'الآن' : `بعد ${fmtDuration(minFromNow)}`,
    inRangeWindow,
  };
}

function computeATCState(
  prediction: Prediction,
  slots: ShiftedScheduleSlot[],
  offsetMs: number,
  nowMs: number,
  transitionMode: TransitionMode,
): ATCState {
  const base: ATCState = {
    mode: 'NORMAL',
    overrunMinutes: 0,
    statusLine: 'الوضع الطبيعي',
    scheduledAutoTransitionIso: null,
    transitionMode,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
  };

  if (!slots.length) return base;

  // Find current active slot
  const activeSlot = slots.find(s => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  if (!activeSlot) return base;

  // Check if we're in the prediction range window
  const nextSlot = slots.find(s => new Date(s.startIso).getTime() > nowMs && s.state !== activeSlot.state);
  if (nextSlot) {
    const nextStartMs = new Date(nextSlot.startIso).getTime();
    const nextEndMs = nextSlot.endIso ? new Date(nextSlot.endIso).getTime() : nextStartMs;
    const isInRange = nowMs >= nextStartMs - PREDICTION_RANGE_MARGIN_MS && nowMs <= nextEndMs;

    if (isInRange) {
      return {
        ...base,
        mode: 'PREDICTION_RANGE',
        statusLine: 'نطاق التوقع نشط — التغيير محتمل الآن',
        communityElevated: true,
      };
    }

    // Check if overrun (past the expected end with no transition)
    if (activeSlot.endIso) {
      const expectedEndMs = new Date(activeSlot.endIso).getTime();
      if (nowMs > expectedEndMs) {
        const overrunMs = nowMs - expectedEndMs;
        const overrunMinutes = overrunMs / 60_000;

        if (overrunMs > GRACE_THRESHOLD_MS) {
          return {
            ...base,
            mode: 'GRACE_MODE',
            overrunMinutes,
            statusLine: `تأخر ${Math.ceil(overrunMinutes)} دقيقة — بانتظار Growatt`,
            communityElevated: true,
          };
        }

        return {
          ...base,
          mode: 'WAITING_FOR_GROWATT',
          overrunMinutes,
          statusLine: `تجاوز المدة المتوقعة بـ ${Math.ceil(overrunMinutes)} دقيقة`,
          communityElevated: true,
        };
      }
    }
  }

  return base;
}

function buildDurationLabel(prediction: Prediction, state: 'ON' | 'OFF'): string | null {
  const pattern = prediction.currentPeriod === 'day' ? prediction.dayPattern : prediction.nightPattern;
  if (!pattern) return null;
  if (state === 'ON' && pattern.avgOnMin !== null) return fmtDuration(pattern.avgOnMin);
  if (state === 'OFF') return fmtDuration(pattern.avgOffMin);
  return null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso: string | null = null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);

  const compute = useCallback(() => {
    if (!prediction) { setUserPrediction(null); return; }
    const up = applyOffsetToPrediction(prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso);
    setUserPrediction(up);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  useEffect(() => { compute(); }, [compute]);

  // Recompute every minute so timers and ATC states stay current
  useEffect(() => {
    if (!prediction) return;
    const id = setInterval(() => compute(), 60_000);
    return () => clearInterval(id);
  }, [prediction, compute]);

  return { userPrediction, loading };
}
