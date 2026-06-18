/**
 * useUserPredictions — ATC (Adaptive Transition Controller) hook.
 *
 * Transforms raw APPPE v4 predictions from usePredictions into a user-personalized
 * prediction view, applying:
 *   1. DSD offset shifting (positive/negative/neutral)
 *   2. POSITIVE_OFFSET_PENDING state machine (Growatt already flipped, user not yet)
 *   3. UNCERTAIN_ZONE state machine (negative offset users awaiting Growatt confirmation)
 *   4. Community resync override (COMMUNITY_SYNCED mode)
 *   5. Schedule slot injection for synthetic lingering state (POSITIVE_OFFSET_PENDING)
 *
 * Exports:
 *   - useUserPredictions() — main hook
 *   - applyOffsetToPrediction() — pure function for previewing offset effects
 *   - ScheduleStateMode — union type of all ATC modes
 *   - UserPrediction — extended Prediction interface with ATC data
 *   - ShiftedScheduleSlot — schedule slot with shifted times
 */

import { useEffect, useState, useCallback } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';
import type { ResyncPoint } from '../contexts/ResyncContext';
import type { TransitionMode } from './useTransitionMode';

// ── ATC state modes ──────────────────────────────────────────────────────────
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

// ── Shifted schedule slot (adds formatted shifted times) ─────────────────────
export interface ShiftedScheduleSlot extends ScheduleSlot {
  shiftedStartIso: string;
  shiftedEndIso: string | null;
  shiftedStartFormatted: string;
  shiftedEndFormatted: string | null;
  isResynced?: boolean;
}

// ── ATC state block ──────────────────────────────────────────────────────────
export interface ATCState {
  mode: ScheduleStateMode;
  statusLine: string;
  overrunMinutes: number;
  transitionMode: TransitionMode;
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  /** For POSITIVE_OFFSET_PENDING: when the user's auto-transition will occur */
  scheduledAutoTransitionIso: string | null;
}

// ── Community sync meta ───────────────────────────────────────────────────────
export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string;
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
}

// ── Full user prediction ──────────────────────────────────────────────────────
export interface UserPrediction {
  // Core state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  offsetMinutes: number;

  // Next transition (shifted by offset)
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

  // Schedule (shifted)
  daySchedule: ShiftedScheduleSlot[];

  // Prediction metadata
  confidence: number;
  confidenceLabel: string;
  isUnstable: boolean;
  stabilityScore: number;
  stabilityLabel: string;
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string;

  // Duration labels
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

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
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const GRACE_BUFFER_MIN = 30;
const VALIDATION_WINDOW_MIN = 20;

function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

function fmtTimeAr(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function minsFromNow(iso: string): number {
  return (new Date(iso).getTime() - Date.now()) / 60_000;
}

function makeDurationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h} س و ${m} د`;
}

// ── applyOffsetToPrediction (pure, exported for admin preview) ───────────────
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode?: TransitionMode,
  anchorStartIso?: string | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;
  const nowMs = Date.now();
  const tMode: TransitionMode = transitionMode ?? 'AUTO';

  // ── Community resync override ─────────────────────────────────────────────
  if (resyncPoint) {
    const resyncedState: 'ON' | 'OFF' = resyncPoint.syncedState;
    const resyncMs = new Date(resyncPoint.syncedAtIso).getTime();

    // Build shifted schedule with resync marker
    const shiftedSlots: ShiftedScheduleSlot[] = (prediction.daySchedule ?? []).map((s) => {
      const shiftedStartIso = shiftIso(s.startIso, offsetMs);
      const shiftedEndIso = s.endIso ? shiftIso(s.endIso, offsetMs) : null;
      return {
        ...s,
        shiftedStartIso,
        shiftedEndIso,
        shiftedStartFormatted: fmtTimeAr(shiftedStartIso),
        shiftedEndFormatted: shiftedEndIso ? fmtTimeAr(shiftedEndIso) : null,
        isResynced: false,
      };
    });

    // Validation window check
    const inValidationWindow = prediction.currentState !== resyncedState;
    const sinceResyncMin = (nowMs - resyncMs) / 60_000;
    const inWindow = inValidationWindow && sinceResyncMin < VALIDATION_WINDOW_MIN;
    const remainingMin = Math.max(0, VALIDATION_WINDOW_MIN - sinceResyncMin);

    return {
      currentState: resyncedState,
      currentStateStartIso: resyncPoint.syncedAtIso,
      offsetMinutes,
      nextTransition: buildNextTransition(prediction, offsetMs),
      daySchedule: shiftedSlots,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      isUnstable: prediction.isUnstable,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      reasoning: prediction.reasoning,
      learningMode: prediction.learningMode,
      computedAt: prediction.computedAt,
      expectedOnDurationLabel: buildExpectedDurationLabel(prediction, 'ON'),
      expectedOffDurationLabel: buildExpectedDurationLabel(prediction, 'OFF'),
      atc: {
        mode: 'COMMUNITY_SYNCED',
        statusLine: 'حالة مزامَنة مجتمعياً',
        overrunMinutes: 0,
        transitionMode: tMode,
        communityElevated: true,
        inValidationWindow: inWindow,
        validationWindowRemainingMin: remainingMin,
        scheduledAutoTransitionIso: null,
      },
      isHoldingState: false,
      isResynced: true,
      resyncedAtIso: resyncPoint.syncedAtIso,
      communitySyncMeta: {
        reporterName: resyncPoint.reporterName ?? 'مجهول',
        reporterReliability: resyncPoint.reporterReliability ?? null,
        syncedAtIso: resyncPoint.syncedAtIso,
        reportedState: resyncedState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
      },
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
    };
  }

  // ── Build shifted schedule ────────────────────────────────────────────────
  const shiftedSlots: ShiftedScheduleSlot[] = (prediction.daySchedule ?? []).map((s) => {
    const shiftedStartIso = shiftIso(s.startIso, offsetMs);
    const shiftedEndIso = s.endIso ? shiftIso(s.endIso, offsetMs) : null;
    return {
      ...s,
      shiftedStartIso,
      shiftedEndIso,
      shiftedStartFormatted: fmtTimeAr(shiftedStartIso),
      shiftedEndFormatted: shiftedEndIso ? fmtTimeAr(shiftedEndIso) : null,
      isResynced: false,
    };
  });

  // ── Determine the "user's current state" based on their shifted schedule ──
  // The user's schedule is shifted by offsetMs. Find the current slot.
  const currentSlot = shiftedSlots.find((s) => {
    const start = new Date(s.shiftedStartIso).getTime();
    const end = s.shiftedEndIso ? new Date(s.shiftedEndIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  // The Growatt (raw) state
  const growattState: 'ON' | 'OFF' = prediction.currentState === 'ON' ? 'ON' : 'OFF';

  // ── POSITIVE_OFFSET_PENDING detection ────────────────────────────────────
  // Triggered when:
  //   - User has a positive offset (their schedule is shifted forward)
  //   - Growatt has already transitioned to the NEXT state
  //   - But the user's shifted schedule still says the PREVIOUS state
  //
  // Example: User has +30min offset. Growatt turned OFF at 12:00.
  //   User schedule says OFF starts at 12:30.
  //   At 12:10, Growatt=OFF but user schedule still says ON → hold ON until 12:30.

  if (offsetMinutes > 0) {
    // Find what the user schedule says the current state SHOULD be
    const userScheduledState: 'ON' | 'OFF' | null = currentSlot?.state ?? null;

    if (userScheduledState !== null && userScheduledState !== growattState) {
      // Growatt and user schedule disagree — POSITIVE_OFFSET_PENDING
      // Find the next shifted slot that matches the Growatt state → that's when the user will transition
      const scheduledTransitionSlot = shiftedSlots.find((s) => {
        const start = new Date(s.shiftedStartIso).getTime();
        return s.state === growattState && start > nowMs;
      });

      // Also look at the current slot's end time (= start of next) as a fallback
      const scheduledAutoTransitionIso =
        scheduledTransitionSlot?.shiftedStartIso ??
        currentSlot?.shiftedEndIso ??
        null;

      const currentStateStartIso = (() => {
        // Use the current slot's shifted start as the start of the held state
        if (currentSlot) return currentSlot.shiftedStartIso;
        if (anchorStartIso) return shiftIso(anchorStartIso, offsetMs);
        return prediction.lastTransitionAt ?? null;
      })();

      // Inject a synthetic lingering slot at front of schedule representing the held state
      const syntheticSlot: ShiftedScheduleSlot = {
        state: userScheduledState,
        startIso: currentSlot?.startIso ?? (anchorStartIso ?? new Date().toISOString()),
        endIso: currentSlot?.endIso ?? scheduledAutoTransitionIso ?? null,
        startFormatted: currentSlot?.startFormatted ?? '',
        endFormatted: currentSlot?.endFormatted ?? null,
        durationLabel: currentSlot?.durationLabel ?? null,
        zone: currentSlot?.zone ?? 'day',
        isEstimated: false,
        shiftedStartIso: currentStateStartIso ?? currentSlot?.shiftedStartIso ?? new Date().toISOString(),
        shiftedEndIso: scheduledAutoTransitionIso,
        shiftedStartFormatted: currentStateStartIso ? fmtTimeAr(currentStateStartIso) : '',
        shiftedEndFormatted: scheduledAutoTransitionIso ? fmtTimeAr(scheduledAutoTransitionIso) : null,
        isResynced: false,
      };

      // Replace or prepend synthetic slot at the front
      const slotsWithSynthetic: ShiftedScheduleSlot[] = [
        syntheticSlot,
        ...shiftedSlots.filter((s) => new Date(s.shiftedStartIso).getTime() >= nowMs),
      ];

      return {
        currentState: userScheduledState,
        currentStateStartIso,
        offsetMinutes,
        nextTransition: scheduledAutoTransitionIso
          ? {
            type: growattState === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
            rangeStartIso: scheduledAutoTransitionIso,
            rangeEndIso: scheduledAutoTransitionIso,
            rangeLabel: fmtTimeAr(scheduledAutoTransitionIso),
            minFromNowMin: Math.max(0, minsFromNow(scheduledAutoTransitionIso)),
            maxFromNowMin: Math.max(0, minsFromNow(scheduledAutoTransitionIso)),
            waitLabel: '',
            inRangeWindow: minsFromNow(scheduledAutoTransitionIso) <= 0,
          }
          : null,
        daySchedule: slotsWithSynthetic,
        confidence: prediction.confidence,
        confidenceLabel: prediction.confidenceLabel,
        isUnstable: prediction.isUnstable,
        stabilityScore: prediction.stabilityScore,
        stabilityLabel: prediction.stabilityLabel,
        reasoning: prediction.reasoning,
        learningMode: prediction.learningMode,
        computedAt: prediction.computedAt,
        expectedOnDurationLabel: buildExpectedDurationLabel(prediction, 'ON'),
        expectedOffDurationLabel: buildExpectedDurationLabel(prediction, 'OFF'),
        atc: {
          mode: 'POSITIVE_OFFSET_PENDING',
          statusLine: scheduledAutoTransitionIso
            ? `الحساس الرئيسي حوّل حالته — تغييرك المجدول في الساعة ${fmtTimeAr(scheduledAutoTransitionIso)}`
            : 'الحساس الرئيسي حوّل حالته — بانتظار وقتك المجدول',
          overrunMinutes: 0,
          transitionMode: tMode,
          communityElevated: true,
          inValidationWindow: false,
          validationWindowRemainingMin: 0,
          scheduledAutoTransitionIso,
        },
        isHoldingState: true,
        isResynced: false,
        resyncedAtIso: null,
        communitySyncMeta: null,
        crisisMode: prediction.apppe?.crisisActive ?? false,
        crisisReason: prediction.apppe?.crisisReason ?? null,
      };
    }
  }

  // ── Normal / UNCERTAIN_ZONE / WAITING_FOR_GROWATT modes ──────────────────
  // The user's effective current state follows their shifted schedule
  const userState: 'ON' | 'OFF' = currentSlot?.state ?? growattState;
  const currentStateStartIso: string | null = (() => {
    if (currentSlot) return currentSlot.shiftedStartIso;
    if (anchorStartIso) return shiftIso(anchorStartIso, offsetMs);
    return prediction.lastTransitionAt ?? null;
  })();

  // Find next transition from shifted schedule
  const nextShiftedTransition = buildNextTransition(prediction, offsetMs);

  // Determine ATC mode based on overrun detection
  const atcMode = determineATCMode(prediction, userState, growattState, offsetMs, tMode);

  return {
    currentState: userState,
    currentStateStartIso,
    offsetMinutes,
    nextTransition: nextShiftedTransition,
    daySchedule: shiftedSlots,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    isUnstable: prediction.isUnstable,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode,
    computedAt: prediction.computedAt,
    expectedOnDurationLabel: buildExpectedDurationLabel(prediction, 'ON'),
    expectedOffDurationLabel: buildExpectedDurationLabel(prediction, 'OFF'),
    atc: atcMode,
    isHoldingState: atcMode.mode !== 'NORMAL' && atcMode.mode !== 'PREDICTION_RANGE',
    isResynced: false,
    resyncedAtIso: null,
    communitySyncMeta: null,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
  };
}

// ── Helpers for applyOffsetToPrediction ──────────────────────────────────────

function buildNextTransition(
  prediction: Prediction,
  offsetMs: number,
): UserPrediction['nextTransition'] {
  const nt = prediction.nextTransition;
  if (!nt) return null;

  const shiftedEarliest = shiftIso(nt.earliestTime, offsetMs);
  const shiftedLatest = shiftIso(nt.latestTime, offsetMs);
  const minFromNow = minsFromNow(shiftedEarliest);
  const maxFromNow = minsFromNow(shiftedLatest);

  return {
    type: nt.type,
    rangeStartIso: shiftedEarliest,
    rangeEndIso: shiftedLatest,
    rangeLabel: `${fmtTimeAr(shiftedEarliest)} — ${fmtTimeAr(shiftedLatest)}`,
    minFromNowMin: minFromNow,
    maxFromNowMin: maxFromNow,
    waitLabel: minFromNow > 0 ? makeDurationLabel(minFromNow) : 'الآن',
    inRangeWindow: minFromNow <= 0 && maxFromNow >= 0,
  };
}

function buildExpectedDurationLabel(
  prediction: Prediction,
  state: 'ON' | 'OFF',
): string | null {
  const pattern = prediction.currentPeriod === 'day'
    ? prediction.dayPattern
    : prediction.nightPattern;

  if (!pattern) return null;

  if (state === 'ON' && pattern.avgOnMin != null) {
    return makeDurationLabel(pattern.avgOnMin);
  }
  if (state === 'OFF') {
    return makeDurationLabel(pattern.avgOffMin);
  }
  return null;
}

function determineATCMode(
  prediction: Prediction,
  userState: 'ON' | 'OFF',
  growattState: 'ON' | 'OFF',
  offsetMs: number,
  tMode: TransitionMode,
): ATCState {
  const nowMs = Date.now();

  // Find next transition from shifted schedule
  const nt = prediction.nextTransition;
  if (!nt) {
    return {
      mode: 'NORMAL',
      statusLine: '',
      overrunMinutes: 0,
      transitionMode: tMode,
      communityElevated: false,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  const shiftedEarliestMs = new Date(nt.earliestTime).getTime() + offsetMs;
  const shiftedLatestMs = new Date(nt.latestTime).getTime() + offsetMs;
  const midMs = (shiftedEarliestMs + shiftedLatestMs) / 2;

  // In range window
  if (nowMs >= shiftedEarliestMs && nowMs <= shiftedLatestMs) {
    return {
      mode: 'PREDICTION_RANGE',
      statusLine: 'بدأ نطاق التوقع — التغيير محتمل الآن',
      overrunMinutes: 0,
      transitionMode: tMode,
      communityElevated: true,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  // Past the range — overrun
  if (nowMs > shiftedLatestMs) {
    const overrunMin = (nowMs - shiftedLatestMs) / 60_000;

    // Grace period
    if (overrunMin < GRACE_BUFFER_MIN) {
      return {
        mode: 'UNCERTAIN_ZONE',
        statusLine: `تجاوزنا نطاق التوقع بـ ${Math.ceil(overrunMin)} دقيقة`,
        overrunMinutes: overrunMin,
        transitionMode: tMode,
        communityElevated: true,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      };
    }

    // Well past grace — waiting for Growatt
    return {
      mode: 'WAITING_FOR_GROWATT',
      statusLine: 'تجاوزنا النطاق المتوقع — بانتظار تأكيد التغيير',
      overrunMinutes: overrunMin,
      transitionMode: tMode,
      communityElevated: true,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  // Before range — normal countdown
  return {
    mode: 'NORMAL',
    statusLine: '',
    overrunMinutes: 0,
    transitionMode: tMode,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    scheduledAutoTransitionIso: null,
  };
}

// ── Main hook ─────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode?: TransitionMode,
  anchorStartIso?: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);

  const compute = useCallback(() => {
    if (!prediction) {
      setUserPrediction(null);
      return;
    }
    const result = applyOffsetToPrediction(
      prediction,
      offsetMinutes,
      resyncPoint,
      transitionMode ?? 'AUTO',
      anchorStartIso ?? null,
    );
    setUserPrediction(result);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  useEffect(() => {
    compute();
  }, [compute]);

  // Re-compute every minute to keep countdown / mode transitions fresh
  useEffect(() => {
    const id = setInterval(() => compute(), 60_000);
    return () => clearInterval(id);
  }, [compute]);

  return { userPrediction, loading };
}
