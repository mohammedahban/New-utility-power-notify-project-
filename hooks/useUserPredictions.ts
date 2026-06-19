/**
 * useUserPredictions — ATC (Adaptive Transition Controller) layer.
 *
 * Wraps the raw admin prediction with per-user offset logic, producing a
 * UserPrediction that the home screen and schedule screen consume directly.
 *
 * ATC state machine modes:
 *  NORMAL               — offset-shifted schedule, state matches Growatt
 *  PREDICTION_RANGE     — currently inside the prediction range window
 *  UNCERTAIN_ZONE       — Growatt already changed but user's offset says "not yet"
 *                          (negative offset) — shows overrun accumulation
 *  POSITIVE_OFFSET_PENDING — Growatt changed but user's scheduled time is future
 *                          (positive offset) — holds current state, shows countdown
 *  COMMUNITY_SYNCED     — a community report has overridden the ATC state
 *  WAITING_FOR_GROWATT  — we're past the range window, waiting for Growatt to confirm
 *  GRACE_MODE           — extended overrun after WAITING_FOR_GROWATT
 */

import { useEffect, useState, useCallback } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'POSITIVE_OFFSET_PENDING'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE';

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
}

export interface CommunitySyncMeta {
  reportId: number | null;
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string | null;
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF' | null;
}

export interface ATCState {
  mode: ScheduleStateMode;
  statusLine: string;
  overrunMinutes: number;
  transitionMode: 'AUTO' | 'MANUAL';
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  communityElevated: boolean;
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction {
  // Current state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  isHoldingState: boolean;
  isResynced: boolean;
  resyncedAtIso: string | null;

  // Next transition
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

  // Day schedule (offset-shifted)
  daySchedule: ShiftedScheduleSlot[];

  // ATC control state
  atc: ATCState;

  // Passthrough from admin prediction
  confidence: number;
  confidenceLabel: string;
  stabilityScore: number;
  stabilityLabel: string;
  isUnstable: boolean;
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string;
  offsetMinutes: number;
  crisisMode: boolean;
  crisisReason: string | null;

  // Typical durations
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

  // Community sync metadata
  communitySyncMeta: CommunitySyncMeta | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ResyncPoint (mirrors what ResyncContext provides)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResyncPoint {
  state: 'ON' | 'OFF';
  syncedAtIso: string;
  reportId: number | null;
  reporterName: string | null;
  reporterReliability: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtTimeAr(iso: string): string {
  const raw = new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return raw.replace('AM', ' ص').replace('PM', ' م');
}

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyOffsetToPrediction — pure function used by admin screen & nearby-users
// ─────────────────────────────────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
): UserPrediction {
  const offsetMs = offsetMinutes * 60_000;
  const nowMs = Date.now();

  // ── Shift day schedule ────────────────────────────────────────────────────
  const shiftedSchedule: ShiftedScheduleSlot[] = (prediction.daySchedule ?? []).map(
    (slot: ScheduleSlot): ShiftedScheduleSlot => {
      const shiftedStartMs = new Date(slot.startIso).getTime() + offsetMs;
      const shiftedEndMs = slot.endIso
        ? new Date(slot.endIso).getTime() + offsetMs
        : null;

      const shiftedStartIso = new Date(shiftedStartMs).toISOString();
      const shiftedEndIso = shiftedEndMs ? new Date(shiftedEndMs).toISOString() : null;

      return {
        state: slot.state,
        startIso: shiftedStartIso,
        endIso: shiftedEndIso,
        startFormatted: slot.startFormatted,
        endFormatted: slot.endFormatted,
        shiftedStartFormatted: fmtTimeAr(shiftedStartIso),
        shiftedEndFormatted: shiftedEndIso ? fmtTimeAr(shiftedEndIso) : null,
        durationLabel: slot.durationLabel,
        zone: slot.zone,
        isEstimated: slot.isEstimated,
        isResynced: false,
      };
    },
  );

  // ── Determine current state from shifted schedule ─────────────────────────
  const activeSlot = shiftedSchedule.find((s) => {
    const start = new Date(s.startIso).getTime();
    const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
    return nowMs >= start && nowMs < end;
  });

  // Growatt current state (raw, no offset)
  const growattState: 'ON' | 'OFF' = prediction.currentState;

  // ── ATC state machine ─────────────────────────────────────────────────────
  let atcMode: ScheduleStateMode = 'NORMAL';
  let isHoldingState = false;
  let overrunMinutes = 0;
  let statusLine = '';
  let scheduledAutoTransitionIso: string | null = null;
  let currentStateStartIso: string | null = activeSlot?.startIso ?? null;

  if (offsetMinutes > 0) {
    // Positive offset: user's schedule lags behind Growatt
    // Check if Growatt has already transitioned to a state that the user
    // hasn't reached yet in their shifted schedule
    const shiftedActiveState = activeSlot?.state ?? growattState;

    if (growattState !== shiftedActiveState) {
      // Growatt has changed but user's scheduled time hasn't arrived yet
      atcMode = 'POSITIVE_OFFSET_PENDING';
      isHoldingState = true;

      // The scheduled auto-transition time is when the shifted schedule
      // shows the next state change that matches Growatt's current state
      const nextMatchingSlot = shiftedSchedule.find((s) => {
        return s.state === growattState && new Date(s.startIso).getTime() > nowMs;
      });

      scheduledAutoTransitionIso = nextMatchingSlot?.startIso ?? null;

      // If no next matching slot found, estimate from offset
      if (!scheduledAutoTransitionIso && prediction.lastTransitionAt) {
        const growattTransitionMs = new Date(prediction.lastTransitionAt).getTime();
        scheduledAutoTransitionIso = new Date(growattTransitionMs + offsetMs).toISOString();
      }

      statusLine = scheduledAutoTransitionIso
        ? `سيتم التحديث تلقائياً في ${fmtTimeAr(scheduledAutoTransitionIso)}`
        : 'تغيير تلقائي مجدول';

      // The held state is the PREVIOUS state (what user still sees)
      // currentStateStartIso: use the start of the slot that is currently active
      // for the user (which lags behind Growatt)
      const heldSlot = shiftedSchedule.find((s) => s.state === shiftedActiveState);
      currentStateStartIso = heldSlot?.startIso ?? null;
    }
  } else if (offsetMinutes < 0) {
    // Negative offset: user's schedule is ahead of Growatt
    // If Growatt hasn't changed yet but user's schedule says it should have,
    // user is in UNCERTAIN_ZONE
    const shiftedActiveState = activeSlot?.state ?? growattState;

    if (growattState !== shiftedActiveState) {
      // User's schedule says one thing, Growatt says another
      atcMode = 'UNCERTAIN_ZONE';
      isHoldingState = true;

      // Overrun: how long since user's scheduled transition was supposed to happen
      if (activeSlot) {
        overrunMinutes = Math.max(0, (nowMs - new Date(activeSlot.startIso).getTime()) / 60_000);
      }

      statusLine = `استمرار غير معتاد — تجاوز ${Math.round(overrunMinutes)} دقيقة`;
      currentStateStartIso = activeSlot?.startIso ?? null;
    }
  }

  // ── Check prediction range window ─────────────────────────────────────────
  if (atcMode === 'NORMAL' && prediction.nextTransition) {
    const nt = prediction.nextTransition;
    const rangeStartMs = new Date(nt.earliestTime).getTime() + offsetMs;
    const rangeEndMs = new Date(nt.latestTime).getTime() + offsetMs;

    if (nowMs >= rangeStartMs && nowMs <= rangeEndMs) {
      atcMode = 'PREDICTION_RANGE';
      statusLine = 'التغيير محتمل الآن';
    } else if (nowMs > rangeEndMs) {
      // Past the range window
      const minsOverRange = (nowMs - rangeEndMs) / 60_000;
      if (minsOverRange < 45) {
        atcMode = 'WAITING_FOR_GROWATT';
        statusLine = 'تجاوزنا نطاق التوقع — بانتظار التأكيد';
        overrunMinutes = minsOverRange;
      } else {
        atcMode = 'GRACE_MODE';
        statusLine = 'تأخر غير معتاد — مهلة المزامنة';
        overrunMinutes = minsOverRange;
      }
    }
  }

  // ── Community resync override ──────────────────────────────────────────────
  let isResynced = false;
  let resyncedAtIso: string | null = null;
  let communitySyncMeta: CommunitySyncMeta | null = null;
  let communityElevated = false;

  if (resyncPoint) {
    const resyncState: 'ON' | 'OFF' =
      resyncPoint.state === 'ON' ? 'ON' : 'OFF';
    isResynced = true;
    resyncedAtIso = resyncPoint.syncedAtIso;
    atcMode = 'COMMUNITY_SYNCED';
    isHoldingState = false;
    communityElevated = true;
    statusLine = 'تمت مزامنة الحالة عبر المجتمع';
    currentStateStartIso = resyncPoint.syncedAtIso;

    // Mark resynced slots in schedule
    shiftedSchedule.forEach((s) => {
      const slotStartMs = new Date(s.startIso).getTime();
      const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
      if (Math.abs(slotStartMs - syncMs) < 30 * 60_000) {
        s.isResynced = true;
      }
    });

    communitySyncMeta = {
      reportId: resyncPoint.reportId,
      reporterName: resyncPoint.reporterName,
      reporterReliability: resyncPoint.reporterReliability,
      syncedAtIso: resyncPoint.syncedAtIso,
      reportedState:
        resyncPoint.state === 'ON' ? 'UTILITY_ON' : 'UTILITY_OFF',
    };
  }

  // ── Resolve current display state ─────────────────────────────────────────
  let displayState: 'ON' | 'OFF' = growattState;

  if (atcMode === 'COMMUNITY_SYNCED' && resyncPoint) {
    displayState = resyncPoint.state === 'ON' ? 'ON' : 'OFF';
  } else if (atcMode === 'POSITIVE_OFFSET_PENDING') {
    // Keep showing pre-Growatt state
    displayState = activeSlot?.state ?? (growattState === 'ON' ? 'OFF' : 'ON');
  } else if (atcMode === 'UNCERTAIN_ZONE') {
    // User's schedule says this state, Growatt hasn't confirmed yet
    displayState = activeSlot?.state ?? growattState;
  } else if (activeSlot) {
    displayState = activeSlot.state;
  }

  // ── Build nextTransition from shifted schedule ─────────────────────────────
  let nextTransition: UserPrediction['nextTransition'] = null;

  if (!prediction.isUnstable && prediction.nextTransition && atcMode !== 'COMMUNITY_SYNCED') {
    const nt = prediction.nextTransition;
    const shiftedStartMs = new Date(nt.earliestTime).getTime() + offsetMs;
    const shiftedEndMs = new Date(nt.latestTime).getTime() + offsetMs;
    const shiftedStartIso = new Date(shiftedStartMs).toISOString();
    const shiftedEndIso = new Date(shiftedEndMs).toISOString();

    const minFromNow = Math.max(0, (shiftedStartMs - nowMs) / 60_000);
    const maxFromNow = Math.max(0, (shiftedEndMs - nowMs) / 60_000);
    const inWindow = nowMs >= shiftedStartMs && nowMs <= shiftedEndMs;

    nextTransition = {
      type: nt.type,
      rangeStartIso: shiftedStartIso,
      rangeEndIso: shiftedEndIso,
      rangeLabel: `${fmtTimeAr(shiftedStartIso)} — ${fmtTimeAr(shiftedEndIso)}`,
      minFromNowMin: minFromNow,
      maxFromNowMin: maxFromNow,
      waitLabel: minFromNow < 60
        ? `${Math.round(minFromNow)} دقيقة`
        : `${Math.round(minFromNow / 60)} ساعة`,
      inRangeWindow: inWindow,
    };
  }

  // ── Inject synthetic "lingering" slot for POSITIVE_OFFSET_PENDING ──────────
  // The held state (pre-Growatt-flip) must appear at the front of the day
  // schedule so "الآن" is shown correctly on the schedule screen.
  let finalSchedule = shiftedSchedule;

  if (atcMode === 'POSITIVE_OFFSET_PENDING' && scheduledAutoTransitionIso) {
    const heldState = displayState;
    const syntheticSlot: ShiftedScheduleSlot = {
      state: heldState,
      startIso: currentStateStartIso ?? new Date(Date.now() - 60 * 60_000).toISOString(),
      endIso: scheduledAutoTransitionIso,
      startFormatted: currentStateStartIso ? fmtTimeAr(currentStateStartIso) : '',
      endFormatted: fmtTimeAr(scheduledAutoTransitionIso),
      shiftedStartFormatted: currentStateStartIso ? fmtTimeAr(currentStateStartIso) : '',
      shiftedEndFormatted: fmtTimeAr(scheduledAutoTransitionIso),
      durationLabel: (() => {
        if (!currentStateStartIso) return null;
        const durMin = (new Date(scheduledAutoTransitionIso).getTime() - new Date(currentStateStartIso).getTime()) / 60_000;
        return durMin > 0 ? fmtDuration(Math.round(durMin)) : null;
      })(),
      zone: 'day',
      isEstimated: false,
      isResynced: false,
    };

    // Prepend the synthetic slot, filtering out any slot that overlaps it
    finalSchedule = [
      syntheticSlot,
      ...shiftedSchedule.filter((s) => {
        if (!scheduledAutoTransitionIso) return true;
        return new Date(s.startIso).getTime() >= new Date(scheduledAutoTransitionIso).getTime();
      }),
    ];
  }

  // ── Validation window (community synced) ──────────────────────────────────
  const VALIDATION_WINDOW_MIN = 15;
  let inValidationWindow = false;
  let validationWindowRemainingMin = 0;

  if (atcMode === 'COMMUNITY_SYNCED' && resyncedAtIso) {
    const syncMs = new Date(resyncedAtIso).getTime();
    const elapsedMin = (nowMs - syncMs) / 60_000;
    if (elapsedMin < VALIDATION_WINDOW_MIN) {
      inValidationWindow = true;
      validationWindowRemainingMin = VALIDATION_WINDOW_MIN - elapsedMin;
    }
  }

  // ── Typical duration labels ───────────────────────────────────────────────
  const expectedOnDurationLabel =
    prediction.dayPattern?.avgOnMin != null
      ? fmtDuration(Math.round(prediction.dayPattern.avgOnMin))
      : prediction.nightPattern?.avgOnMin != null
      ? fmtDuration(Math.round(prediction.nightPattern.avgOnMin))
      : null;

  const expectedOffDurationLabel =
    prediction.dayPattern?.avgOffMin != null
      ? fmtDuration(Math.round(prediction.dayPattern.avgOffMin))
      : prediction.nightPattern?.avgOffMin != null
      ? fmtDuration(Math.round(prediction.nightPattern.avgOffMin))
      : null;

  return {
    currentState: displayState,
    currentStateStartIso,
    isHoldingState,
    isResynced,
    resyncedAtIso,

    nextTransition,
    daySchedule: finalSchedule,

    atc: {
      mode: atcMode,
      statusLine,
      overrunMinutes,
      transitionMode: 'AUTO',
      inValidationWindow,
      validationWindowRemainingMin,
      communityElevated,
      scheduledAutoTransitionIso,
    },

    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    isUnstable: prediction.isUnstable,
    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode,
    computedAt: prediction.computedAt,
    offsetMinutes,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,

    expectedOnDurationLabel,
    expectedOffDurationLabel,

    communitySyncMeta,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useUserPredictions hook
// ─────────────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode?: 'AUTO' | 'MANUAL',
  anchorStartIso?: string | null,
) {
  const { prediction, loading: predLoading } = usePredictions();
  const { user } = useAuth();

  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);
  const [loading, setLoading] = useState(true);

  const compute = useCallback(() => {
    if (!prediction) {
      setUserPrediction(null);
      setLoading(false);
      return;
    }

    const result = applyOffsetToPrediction(prediction, offsetMinutes, resyncPoint);

    // Apply TMMS MANUAL mode: override ATC transitionMode field
    if (transitionMode === 'MANUAL') {
      result.atc = {
        ...result.atc,
        transitionMode: 'MANUAL',
      };
    }

    // Apply anchor override for currentStateStartIso if provided
    if (anchorStartIso && result.atc.mode === 'NORMAL') {
      result.currentStateStartIso = anchorStartIso;
    }

    setUserPrediction(result);
    setLoading(false);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  useEffect(() => {
    compute();
  }, [compute]);

  return { userPrediction, loading: loading || predLoading };
}
