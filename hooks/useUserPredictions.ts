/**
 * useUserPredictions — ATC (Adaptive Timing Controller) hook
 *
 * Transforms raw APPPE v4 prediction data into a user-specific prediction
 * by applying the user's DSD offset and any active community resync point.
 *
 * ATC Modes (ScheduleStateMode):
 *   NORMAL              — Growatt matches schedule; no offset tension
 *   PREDICTION_RANGE    — Currently within the predicted transition window
 *   UNCERTAIN_ZONE      — Negative-offset user: Growatt has NOT yet confirmed
 *                         expected transition; duration is accumulating
 *   COMMUNITY_SYNCED    — User confirmed a community resync; schedule overridden
 *   WAITING_FOR_GROWATT — Post-range; waiting for Growatt to confirm transition
 *   GRACE_MODE          — Transition window passed with no Growatt confirmation
 *   POSITIVE_OFFSET_PENDING — Growatt already transitioned but user's scheduled
 *                             time is still in the future (hold the old state)
 *
 * Exports:
 *   useUserPredictions(offset, resyncPoint, transitionMode?, anchorStartIso?) → { userPrediction, loading }
 *   applyOffsetToPrediction(prediction, offsetMinutes, resyncPoint?) → UserPrediction
 */

import { useMemo } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';
import type { ResyncPoint } from '../contexts/ResyncContext';
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
  isResynced?: boolean;
  /** ISO of computed shifted start */
  shiftedStartIso?: string;
  /** ISO of computed shifted end */
  shiftedEndIso?: string | null;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  reportedState: 'ON' | 'OFF';
}

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  statusLine: string;
  transitionMode: TransitionMode;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  /** ISO timestamp of scheduled auto-transition (POSITIVE_OFFSET_PENDING only) */
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction {
  // Core state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  offsetMinutes: number;
  isHoldingState: boolean;
  isUnstable: boolean;
  isResynced: boolean;
  resyncedAtIso: string | null;

  // Prediction metadata
  confidence: number;
  confidenceLabel: string;
  stabilityScore: number;
  stabilityLabel: string;
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string;
  reasoning: string[];

  // APPPE crisis
  crisisMode: boolean;
  crisisReason: string | null;

  // Typical durations
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

  // Next transition (offset-shifted)
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

  // ATC controller state
  atc: ATCState;

  // Community sync metadata (if COMMUNITY_SYNCED)
  communitySyncMeta: CommunitySyncMeta | null;

  // User's personal day schedule (offset-shifted)
  daySchedule: ShiftedScheduleSlot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatTimeAr(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'Asia/Aden',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).replace('AM', 'ص').replace('PM', 'م');
  } catch {
    return '';
  }
}

function formatDuration(minutes: number): string {
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.round(Math.abs(minutes) % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

/**
 * Shift a schedule slot by offsetMs milliseconds.
 * Returns new ISO strings and formatted labels.
 */
function shiftSlot(slot: ScheduleSlot, offsetMs: number): ShiftedScheduleSlot {
  const shiftedStartIso = new Date(new Date(slot.startIso).getTime() + offsetMs).toISOString();
  const shiftedEndIso = slot.endIso
    ? new Date(new Date(slot.endIso).getTime() + offsetMs).toISOString()
    : null;

  return {
    state: slot.state,
    startIso: shiftedStartIso,
    endIso: shiftedEndIso,
    startFormatted: slot.startFormatted,
    endFormatted: slot.endFormatted,
    shiftedStartFormatted: formatTimeAr(shiftedStartIso),
    shiftedEndFormatted: shiftedEndIso ? formatTimeAr(shiftedEndIso) : null,
    durationLabel: slot.durationLabel,
    zone: slot.zone,
    isEstimated: slot.isEstimated,
    shiftedStartIso,
    shiftedEndIso,
  };
}

// Validation window for community sync (20 minutes)
const VALIDATION_WINDOW_MS = 20 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Core transform function — pure, no hooks
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

  // ── Community resync branch ────────────────────────────────────────────────
  if (resyncPoint) {
    const syncedAtMs = new Date(resyncPoint.syncedAtIso).getTime();
    const appliedAtMs = new Date(resyncPoint.appliedAtIso).getTime();
    const validationAge = nowMs - appliedAtMs;
    const inValidationWindow = validationAge < VALIDATION_WINDOW_MS;
    const validationWindowRemainingMin = inValidationWindow
      ? Math.ceil((VALIDATION_WINDOW_MS - validationAge) / 60_000)
      : 0;

    // Shift schedule for display
    const shiftedSchedule: ShiftedScheduleSlot[] = prediction.daySchedule.map(slot =>
      shiftSlot(slot, offsetMs)
    );

    // Mark slots as resynced if they overlap with sync time
    const markedSchedule = shiftedSchedule.map(slot => {
      const slotStart = new Date(slot.startIso).getTime();
      const slotEnd = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
      const isResynced = syncedAtMs >= slotStart && syncedAtMs < slotEnd;
      return { ...slot, isResynced };
    });

    const syncedState: 'ON' | 'OFF' = resyncPoint.syncedState === 'ON' ? 'ON' : 'OFF';

    return {
      currentState: syncedState,
      currentStateStartIso: resyncPoint.syncedAtIso,
      offsetMinutes,
      isHoldingState: false,
      isUnstable: prediction.isUnstable,
      isResynced: true,
      resyncedAtIso: resyncPoint.syncedAtIso,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      reasoning: prediction.reasoning,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: prediction.dayPattern?.avgOnMin != null
        ? formatDuration(prediction.dayPattern.avgOnMin) : null,
      expectedOffDurationLabel: prediction.dayPattern?.avgOffMin != null
        ? formatDuration(prediction.dayPattern.avgOffMin) : null,
      nextTransition: buildNextTransition(prediction, offsetMs),
      atc: {
        mode: 'COMMUNITY_SYNCED',
        overrunMinutes: 0,
        statusLine: 'حالتك مزامَنة مجتمعياً',
        transitionMode,
        communityElevated: true,
        inValidationWindow,
        validationWindowRemainingMin,
        scheduledAutoTransitionIso: null,
      },
      communitySyncMeta: {
        reporterName: resyncPoint.reporterName ?? null,
        reporterReliability: resyncPoint.reporterReliability ?? null,
        syncedAtIso: resyncPoint.syncedAtIso,
        reportedState: syncedState,
      },
      daySchedule: markedSchedule,
    };
  }

  // ── Standard ATC branch ───────────────────────────────────────────────────

  // Shift schedule
  const shiftedSchedule: ShiftedScheduleSlot[] = prediction.daySchedule.map(slot =>
    shiftSlot(slot, offsetMs)
  );

  // Find user's current slot (based on shifted times)
  const currentSlot = shiftedSchedule.find(slot => {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // User's personal current state (from shifted schedule)
  const userCurrentState: 'ON' | 'OFF' = currentSlot?.state ?? prediction.currentState;

  // Growatt state
  const growattState: 'ON' | 'OFF' = prediction.currentState;

  // ── POSITIVE_OFFSET_PENDING detection ─────────────────────────────────────
  // Condition: Growatt has already transitioned to the opposite state,
  // but the user's shifted schedule says they should still be in the old state.
  // i.e. offsetMinutes > 0 AND growattState !== userCurrentState
  //
  // In this case: hold the user's current state until the shifted slot starts.
  const isPositiveOffset = offsetMinutes > 0;
  const growattFlippedAhead = growattState !== userCurrentState && isPositiveOffset;

  if (growattFlippedAhead) {
    // Find the next slot that matches growatt's new state (i.e. the user's upcoming slot)
    const upcomingSlot = shiftedSchedule.find(slot => {
      const start = new Date(slot.startIso).getTime();
      return start > nowMs && slot.state === growattState;
    }) ?? null;

    const scheduledAutoTransitionIso = upcomingSlot?.startIso ?? null;

    // Inject synthetic lingering slot at front of schedule representing the held state
    const syntheticSlot: ShiftedScheduleSlot = {
      state: userCurrentState,
      startIso: anchorStartIso ?? (prediction.lastTransitionAt
        ? new Date(new Date(prediction.lastTransitionAt).getTime() + offsetMs).toISOString()
        : new Date(nowMs - 3600_000).toISOString()),
      endIso: scheduledAutoTransitionIso,
      startFormatted: '',
      endFormatted: scheduledAutoTransitionIso ? formatTimeAr(scheduledAutoTransitionIso) : null,
      shiftedStartFormatted: anchorStartIso ? formatTimeAr(anchorStartIso) : null,
      shiftedEndFormatted: scheduledAutoTransitionIso ? formatTimeAr(scheduledAutoTransitionIso) : null,
      durationLabel: null,
      zone: currentSlot?.zone ?? 'day',
      isEstimated: false,
      shiftedStartIso: anchorStartIso ?? undefined,
      shiftedEndIso: scheduledAutoTransitionIso,
    };

    // Build schedule with synthetic slot at front, then remaining future slots
    const futureSlots = shiftedSchedule.filter(s => {
      const start = new Date(s.startIso).getTime();
      return start > (scheduledAutoTransitionIso
        ? new Date(scheduledAutoTransitionIso).getTime()
        : nowMs);
    });
    const displaySchedule = [syntheticSlot, ...futureSlots];

    return {
      currentState: userCurrentState,
      currentStateStartIso: syntheticSlot.startIso,
      offsetMinutes,
      isHoldingState: true,
      isUnstable: prediction.isUnstable,
      isResynced: false,
      resyncedAtIso: null,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      reasoning: prediction.reasoning,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      expectedOnDurationLabel: prediction.dayPattern?.avgOnMin != null
        ? formatDuration(prediction.dayPattern.avgOnMin) : null,
      expectedOffDurationLabel: prediction.dayPattern?.avgOffMin != null
        ? formatDuration(prediction.dayPattern.avgOffMin) : null,
      nextTransition: scheduledAutoTransitionIso ? {
        type: growattState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
        rangeStartIso: scheduledAutoTransitionIso,
        rangeEndIso: scheduledAutoTransitionIso,
        rangeLabel: formatTimeAr(scheduledAutoTransitionIso),
        minFromNowMin: Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
        maxFromNowMin: Math.max(0, (new Date(scheduledAutoTransitionIso).getTime() - nowMs) / 60_000),
        waitLabel: '',
        inRangeWindow: false,
      } : null,
      atc: {
        mode: 'POSITIVE_OFFSET_PENDING',
        overrunMinutes: 0,
        statusLine: scheduledAutoTransitionIso
          ? `سيتم التحديث في ${formatTimeAr(scheduledAutoTransitionIso)}`
          : 'الحساس الرئيسي حوّل حالته — في انتظار وقتك المجدول',
        transitionMode,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso,
      },
      communitySyncMeta: null,
      daySchedule: displaySchedule,
    };
  }

  // ── Compute ATC mode for normal/negative-offset users ────────────────────
  const atcResult = computeATCState(prediction, shiftedSchedule, offsetMinutes, transitionMode, nowMs);

  // ── Build next transition ──────────────────────────────────────────────────
  const nextTransition = !prediction.isUnstable ? buildNextTransition(prediction, offsetMs) : null;

  // ── Current state start ISO ───────────────────────────────────────────────
  const currentStateStartIso = (() => {
    if (anchorStartIso) return anchorStartIso;
    if (currentSlot) return currentSlot.startIso;
    if (prediction.lastTransitionAt) {
      return new Date(new Date(prediction.lastTransitionAt).getTime() + offsetMs).toISOString();
    }
    return null;
  })();

  return {
    currentState: userCurrentState,
    currentStateStartIso,
    offsetMinutes,
    isHoldingState: atcResult.isHolding,
    isUnstable: prediction.isUnstable,
    isResynced: false,
    resyncedAtIso: null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    learningMode: prediction.learningMode,
    computedAt: prediction.computedAt,
    reasoning: prediction.reasoning,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    expectedOnDurationLabel: prediction.dayPattern?.avgOnMin != null
      ? formatDuration(prediction.dayPattern.avgOnMin) : null,
    expectedOffDurationLabel: prediction.dayPattern?.avgOffMin != null
      ? formatDuration(prediction.dayPattern.avgOffMin) : null,
    nextTransition,
    atc: atcResult.atc,
    communitySyncMeta: null,
    daySchedule: shiftedSchedule,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build next transition from raw prediction with offset applied
// ─────────────────────────────────────────────────────────────────────────────

function buildNextTransition(prediction: Prediction, offsetMs: number) {
  if (!prediction.nextTransition) return null;
  const nt = prediction.nextTransition;
  const nowMs = Date.now();

  const rangeStartMs = new Date(nt.earliestTime).getTime() + offsetMs;
  const rangeEndMs   = new Date(nt.latestTime).getTime() + offsetMs;
  const rangeStartIso = new Date(rangeStartMs).toISOString();
  const rangeEndIso   = new Date(rangeEndMs).toISOString();
  const minFromNowMin = Math.max(0, (rangeStartMs - nowMs) / 60_000);
  const maxFromNowMin = Math.max(0, (rangeEndMs - nowMs) / 60_000);
  const inRangeWindow = nowMs >= rangeStartMs && nowMs <= rangeEndMs;

  const h = Math.floor(minFromNowMin / 60);
  const m = Math.round(minFromNowMin % 60);
  const waitLabel = h > 0 ? `${h}س ${m}د` : `${m} دقيقة`;

  return {
    type: nt.type,
    rangeStartIso,
    rangeEndIso,
    rangeLabel: `${formatTimeAr(rangeStartIso)} — ${formatTimeAr(rangeEndIso)}`,
    minFromNowMin,
    maxFromNowMin,
    waitLabel,
    inRangeWindow,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute ATC state for normal/negative-offset users
// ─────────────────────────────────────────────────────────────────────────────

function computeATCState(
  prediction: Prediction,
  shiftedSchedule: ShiftedScheduleSlot[],
  offsetMinutes: number,
  transitionMode: TransitionMode,
  nowMs: number,
): { atc: ATCState; isHolding: boolean } {
  const offsetMs = offsetMinutes * 60_000;

  // Find the slot that should currently be active (based on shifted schedule)
  const currentSlot = shiftedSchedule.find(slot => {
    const start = new Date(slot.startIso).getTime();
    const end = slot.endIso ? new Date(slot.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  }) ?? null;

  // Shifted next transition times
  const nt = prediction.nextTransition;
  const rangeStartMs = nt ? new Date(nt.earliestTime).getTime() + offsetMs : null;
  const rangeEndMs   = nt ? new Date(nt.latestTime).getTime() + offsetMs : null;

  const inRange = rangeStartMs !== null && rangeEndMs !== null
    && nowMs >= rangeStartMs && nowMs <= rangeEndMs;

  // Overrun = how many minutes past the end of the predicted window
  const overrunMinutes = rangeEndMs !== null && nowMs > rangeEndMs
    ? (nowMs - rangeEndMs) / 60_000
    : 0;

  // ── UNCERTAIN_ZONE (negative offset) ──────────────────────────────────────
  // Negative offset: user is ahead of Growatt. Expected transition may have
  // already passed by user time but Growatt hasn't confirmed yet.
  if (offsetMinutes < 0 && overrunMinutes > 0) {
    return {
      atc: {
        mode: 'UNCERTAIN_ZONE',
        overrunMinutes,
        statusLine: `تجاوزنا نطاق التوقع بـ ${Math.ceil(overrunMinutes)} دقيقة`,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHolding: true,
    };
  }

  // ── PREDICTION_RANGE ──────────────────────────────────────────────────────
  if (inRange) {
    return {
      atc: {
        mode: 'PREDICTION_RANGE',
        overrunMinutes: 0,
        statusLine: 'نطاق التوقع نشط الآن',
        transitionMode,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHolding: true,
    };
  }

  // ── WAITING_FOR_GROWATT ───────────────────────────────────────────────────
  if (rangeEndMs !== null && nowMs > rangeEndMs && overrunMinutes > 0 && overrunMinutes <= 30) {
    return {
      atc: {
        mode: 'WAITING_FOR_GROWATT',
        overrunMinutes,
        statusLine: 'بانتظار تأكيد الحساس الرئيسي',
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHolding: true,
    };
  }

  // ── GRACE_MODE ────────────────────────────────────────────────────────────
  if (rangeEndMs !== null && nowMs > rangeEndMs && overrunMinutes > 30) {
    return {
      atc: {
        mode: 'GRACE_MODE',
        overrunMinutes,
        statusLine: `تأخر ${Math.ceil(overrunMinutes)} دقيقة — مهلة المزامنة نشطة`,
        transitionMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      },
      isHolding: true,
    };
  }

  // ── NORMAL ────────────────────────────────────────────────────────────────
  return {
    atc: {
      mode: 'NORMAL',
      overrunMinutes: 0,
      statusLine: 'متزامن مع Growatt',
      transitionMode,
      communityElevated: false,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    },
    isHolding: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: TransitionMode = 'AUTO',
  anchorStartIso?: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();

  const userPrediction = useMemo(() => {
    if (!prediction) return null;
    return applyOffsetToPrediction(prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  return { userPrediction, loading };
}
