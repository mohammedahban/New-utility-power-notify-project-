/**
 * useUserPredictions — ATC (Adaptive Transition Controller) state machine.
 *
 * Transforms raw APPPE v4 prediction data into a user-personalised prediction
 * by applying the user's DSD offset, community resync point, and TMMS mode.
 *
 * Exported:
 *   - ScheduleStateMode     (ATC mode type)
 *   - ShiftedScheduleSlot   (offset-shifted schedule slot)
 *   - CommunitySyncMeta     (community sync metadata)
 *   - ATCState              (full ATC controller state)
 *   - UserPrediction        (personalised prediction)
 *   - applyOffsetToPrediction (pure function — used by admin views)
 *   - useUserPredictions    (React hook)
 */

import { useEffect, useState } from 'react';
import { usePredictions, Prediction, ScheduleSlot } from './usePredictions';

// ── ATC Mode ──────────────────────────────────────────────────────────────────
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

// ── Interfaces ────────────────────────────────────────────────────────────────
export interface ShiftedScheduleSlot {
  state: 'ON' | 'OFF';
  startIso: string;
  endIso: string | null;
  startFormatted: string;
  endFormatted: string | null;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string;
  durationLabel: string | null;
  zone: string;
  isEstimated: boolean;
  isResynced?: boolean;
}

export interface CommunitySyncMeta {
  reporterName: string;
  reporterReliability: number | null;
  syncedAtIso: string;
  reportedState: 'ON' | 'OFF';
}

export interface ATCState {
  mode: ScheduleStateMode;
  overrunMinutes: number;
  statusLine: string;
  transitionMode: 'AUTO' | 'MANUAL';
  communityElevated: boolean;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  scheduledAutoTransitionIso: string | null;
}

export interface ResyncPoint {
  syncedAtIso: string;
  reportedState: 'UTILITY_ON' | 'UTILITY_OFF';
  reporterName: string;
  reporterReliability: number | null;
  reporterId?: string;
  estimatedTransitionAt?: string;
}

export interface UserPrediction {
  // Core state
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  isHoldingState: boolean;
  isUnstable: boolean;
  crisisMode: boolean;
  crisisReason: string | null;

  // Quality metrics
  confidence: number;
  confidenceLabel: string;
  stabilityScore: number;
  stabilityLabel: string;

  // Schedule
  daySchedule: ShiftedScheduleSlot[];
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

  // Duration labels
  expectedOnDurationLabel: string | null;
  expectedOffDurationLabel: string | null;

  // Metadata
  reasoning: string[];
  computedAt: string;
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  offsetMinutes: number;
  resyncedAtIso: string | null;
  isResynced: boolean;
  communitySyncMeta: CommunitySyncMeta | null;

  // ATC controller state
  atc: ATCState;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTimeLocal(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'Asia/Aden',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function fmtDurationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m} دقيقة`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h} ساعات`;
  return `${h}س ${m}د`;
}

function shiftIso(iso: string, offsetMinutes: number): string {
  return new Date(new Date(iso).getTime() + offsetMinutes * 60_000).toISOString();
}

/**
 * Build the ATC state machine for given parameters.
 * Used by both the hook (with full context) and the pure applyOffsetToPrediction.
 */
function buildATCState(params: {
  prediction: Prediction;
  offsetMinutes: number;
  resyncPoint: ResyncPoint | null;
  transitionMode: 'AUTO' | 'MANUAL';
  nowMs: number;
}): ATCState {
  const { prediction, offsetMinutes, resyncPoint, transitionMode, nowMs } = params;

  // ── COMMUNITY_SYNCED ──────────────────────────────────────────────────────
  if (resyncPoint) {
    const syncMs = new Date(resyncPoint.syncedAtIso).getTime();
    const validationWindowMs = 30 * 60_000; // 30 min validation window
    const inWindow = nowMs < syncMs + validationWindowMs;
    const remainingMin = inWindow
      ? Math.max(0, (syncMs + validationWindowMs - nowMs) / 60_000)
      : 0;
    return {
      mode: 'COMMUNITY_SYNCED',
      overrunMinutes: 0,
      statusLine: 'الحالة مزامَنة مجتمعياً',
      transitionMode,
      communityElevated: true,
      inValidationWindow: inWindow,
      validationWindowRemainingMin: remainingMin,
      scheduledAutoTransitionIso: null,
    };
  }

  const nt = prediction.nextTransition;
  const currentState = prediction.currentState;

  // ── POSITIVE_OFFSET_PENDING ───────────────────────────────────────────────
  // Growatt has already transitioned but user's scheduled time is in the future.
  if (offsetMinutes > 0 && nt) {
    const growattTransitionMs = new Date(nt.earliestTime).getTime();
    // Find the most recent past Growatt transition relative to now
    // When current state changed, that time + offset = user's scheduled transition
    const slots = prediction.daySchedule;
    const currentSlot = slots.find(s => {
      const start = new Date(s.startIso).getTime();
      const end = s.endIso ? new Date(s.endIso).getTime() : Infinity;
      return nowMs >= start && nowMs < end;
    });

    // Check if we are in the holding zone: Growatt changed but user's offset time hasn't arrived
    // This means the PREVIOUS Growatt slot has ended (Growatt switched) and user's +offset window is pending
    if (currentSlot) {
      const userScheduledTransitionMs = new Date(currentSlot.endIso ?? currentSlot.startIso).getTime();
      if (userScheduledTransitionMs > nowMs) {
        // We're within the holding period — check if Growatt already flipped
        const growattNextMs = nt
          ? (new Date(nt.earliestTime).getTime() + new Date(nt.latestTime).getTime()) / 2
          : null;
        if (growattNextMs && growattNextMs < nowMs) {
          return {
            mode: 'POSITIVE_OFFSET_PENDING',
            overrunMinutes: 0,
            statusLine: `الحساس الرئيسي حوّل حالته — سيتم التحديث تلقائياً في ${fmtTimeLocal(currentSlot.endIso ?? currentSlot.startIso)}`,
            transitionMode,
            communityElevated: true,
            inValidationWindow: false,
            validationWindowRemainingMin: 0,
            scheduledAutoTransitionIso: currentSlot.endIso ?? null,
          };
        }
      }
    }
  }

  if (!nt) {
    return {
      mode: 'NORMAL',
      overrunMinutes: 0,
      statusLine: 'النظام في وضع التزامن',
      transitionMode,
      communityElevated: false,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  const earliestMs = new Date(nt.earliestTime).getTime();
  const latestMs = new Date(nt.latestTime).getTime();
  const midMs = (earliestMs + latestMs) / 2;

  // Apply offset to transition times
  const shiftedEarliestMs = earliestMs + offsetMinutes * 60_000;
  const shiftedLatestMs = latestMs + offsetMinutes * 60_000;
  const shiftedMidMs = midMs + offsetMinutes * 60_000;

  // ── UNCERTAIN_ZONE ────────────────────────────────────────────────────────
  // Negative offset: user is ahead of Growatt.
  // Once we pass the shifted transition window, we enter UNCERTAIN_ZONE.
  if (offsetMinutes < 0) {
    const absOffset = Math.abs(offsetMinutes);
    // User's predicted window
    if (nowMs > shiftedLatestMs) {
      const overrunMs = nowMs - shiftedLatestMs;
      const overrunMinutes = overrunMs / 60_000;
      return {
        mode: 'UNCERTAIN_ZONE',
        overrunMinutes,
        statusLine: `تجاوزنا نطاق التوقع بـ ${Math.round(overrunMinutes)} دقيقة`,
        transitionMode,
        communityElevated: overrunMinutes > 30,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      };
    }
    if (nowMs >= shiftedEarliestMs) {
      return {
        mode: 'PREDICTION_RANGE',
        overrunMinutes: 0,
        statusLine: 'نطاق التوقع نشط — التغيير محتمل الآن',
        transitionMode,
        communityElevated: false,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        scheduledAutoTransitionIso: null,
      };
    }
  }

  // ── GRACE_MODE ────────────────────────────────────────────────────────────
  // Past the expected latest transition + 30 min grace with neutral offset
  const GRACE_WINDOW_MS = 30 * 60_000;
  if (offsetMinutes === 0 && nowMs > latestMs + GRACE_WINDOW_MS) {
    const overrunMs = nowMs - latestMs;
    return {
      mode: 'GRACE_MODE',
      overrunMinutes: overrunMs / 60_000,
      statusLine: 'تأخر غير معتاد — مهلة المزامنة نشطة',
      transitionMode,
      communityElevated: true,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  // ── WAITING_FOR_GROWATT ───────────────────────────────────────────────────
  // We've passed the expected range end (but within grace window)
  if (nowMs > latestMs + offsetMinutes * 60_000) {
    const overrunMs = nowMs - (latestMs + offsetMinutes * 60_000);
    return {
      mode: 'WAITING_FOR_GROWATT',
      overrunMinutes: overrunMs / 60_000,
      statusLine: 'تجاوزنا نطاق التوقع. بانتظار تأكيد',
      transitionMode,
      communityElevated: overrunMs > 20 * 60_000,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  // ── PREDICTION_RANGE ──────────────────────────────────────────────────────
  if (nowMs >= shiftedEarliestMs && nowMs <= shiftedLatestMs) {
    return {
      mode: 'PREDICTION_RANGE',
      overrunMinutes: 0,
      statusLine: 'نطاق التوقع نشط — التغيير محتمل الآن',
      transitionMode,
      communityElevated: false,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      scheduledAutoTransitionIso: null,
    };
  }

  // ── NORMAL ────────────────────────────────────────────────────────────────
  return {
    mode: 'NORMAL',
    overrunMinutes: 0,
    statusLine: 'النظام في وضع التزامن',
    transitionMode,
    communityElevated: false,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    scheduledAutoTransitionIso: null,
  };
}

/**
 * Pure function: apply offset + optional resync to a raw Prediction.
 * Used by admin views (ATCSystemIndicator) and useNearbyUsers.
 */
export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
): UserPrediction {
  const nowMs = Date.now();

  // ── Build shifted schedule ────────────────────────────────────────────────
  const daySchedule: ShiftedScheduleSlot[] = prediction.daySchedule.map((slot) => {
    const shiftedStartIso = shiftIso(slot.startIso, offsetMinutes);
    const shiftedEndIso = slot.endIso ? shiftIso(slot.endIso, offsetMinutes) : null;
    return {
      ...slot,
      shiftedStartFormatted: fmtTimeLocal(shiftedStartIso),
      shiftedEndFormatted: shiftedEndIso ? fmtTimeLocal(shiftedEndIso) : null,
      isResynced: false,
    };
  });

  // ── Community resync handling ─────────────────────────────────────────────
  let currentState = prediction.currentState;
  let currentStateStartIso: string | null = prediction.lastTransitionAt;
  let isResynced = false;
  let communitySyncMeta: CommunitySyncMeta | null = null;

  if (resyncPoint) {
    const reportedState: 'ON' | 'OFF' =
      resyncPoint.reportedState === 'UTILITY_ON' ? 'ON' : 'OFF';
    currentState = reportedState;
    currentStateStartIso = resyncPoint.syncedAtIso;
    isResynced = true;
    communitySyncMeta = {
      reporterName: resyncPoint.reporterName,
      reporterReliability: resyncPoint.reporterReliability,
      syncedAtIso: resyncPoint.syncedAtIso,
      reportedState,
    };
  }

  // ── ATC state ─────────────────────────────────────────────────────────────
  const atc = buildATCState({
    prediction,
    offsetMinutes,
    resyncPoint: resyncPoint ?? null,
    transitionMode: 'AUTO',
    nowMs,
  });

  // ── POSITIVE_OFFSET_PENDING: inject synthetic lingering slot ─────────────
  let finalDaySchedule = daySchedule;
  let isHoldingState = false;

  if (atc.mode === 'POSITIVE_OFFSET_PENDING' && atc.scheduledAutoTransitionIso) {
    isHoldingState = true;
    // Inject synthetic slot at index 0 representing current held state
    const syntheticSlot: ShiftedScheduleSlot = {
      state: currentState,
      startIso: prediction.lastTransitionAt ?? new Date(nowMs - 3600_000).toISOString(),
      endIso: atc.scheduledAutoTransitionIso,
      startFormatted: fmtTimeLocal(prediction.lastTransitionAt ?? new Date(nowMs - 3600_000).toISOString()),
      endFormatted: fmtTimeLocal(atc.scheduledAutoTransitionIso),
      shiftedStartFormatted: fmtTimeLocal(prediction.lastTransitionAt ?? new Date(nowMs - 3600_000).toISOString()),
      shiftedEndFormatted: fmtTimeLocal(atc.scheduledAutoTransitionIso),
      durationLabel: fmtDurationLabel(offsetMinutes),
      zone: 'holding',
      isEstimated: false,
      isResynced: false,
    };
    finalDaySchedule = [syntheticSlot, ...daySchedule.filter(s => new Date(s.startIso).getTime() >= new Date(atc.scheduledAutoTransitionIso!).getTime())];
  }

  // Determine isHoldingState for other modes
  if (atc.mode === 'UNCERTAIN_ZONE' || atc.mode === 'WAITING_FOR_GROWATT' || atc.mode === 'GRACE_MODE') {
    isHoldingState = true;
  }

  // ── Next transition (shifted) ─────────────────────────────────────────────
  let nextTransition: UserPrediction['nextTransition'] = null;
  if (prediction.nextTransition && !prediction.isUnstable) {
    const nt = prediction.nextTransition;
    const shiftedStartMs = new Date(nt.earliestTime).getTime() + offsetMinutes * 60_000;
    const shiftedEndMs = new Date(nt.latestTime).getTime() + offsetMinutes * 60_000;
    const shiftedStartIso = new Date(shiftedStartMs).toISOString();
    const shiftedEndIso = new Date(shiftedEndMs).toISOString();
    const minFromNow = Math.max(0, (shiftedStartMs - nowMs) / 60_000);
    const maxFromNow = Math.max(0, (shiftedEndMs - nowMs) / 60_000);
    const inRangeWindow = nowMs >= shiftedStartMs && nowMs <= shiftedEndMs;

    nextTransition = {
      type: nt.type,
      rangeStartIso: shiftedStartIso,
      rangeEndIso: shiftedEndIso,
      rangeLabel: `${fmtTimeLocal(shiftedStartIso)} — ${fmtTimeLocal(shiftedEndIso)}`,
      minFromNowMin: minFromNow,
      maxFromNowMin: maxFromNow,
      waitLabel: minFromNow < 1 ? 'الآن' : fmtDurationLabel(minFromNow),
      inRangeWindow,
    };
  }

  // ── Duration labels ───────────────────────────────────────────────────────
  const dayPat = prediction.dayPattern;
  const nightPat = prediction.nightPattern;
  const pat = prediction.currentPeriod === 'day' ? dayPat : nightPat;

  const expectedOnDurationLabel = pat?.avgOnMin
    ? fmtDurationLabel(pat.avgOnMin * (1 + (prediction.apppe?.biasRatio ?? 1) - 1))
    : null;
  const expectedOffDurationLabel = pat?.avgOffMin
    ? fmtDurationLabel(pat.avgOffMin * (prediction.apppe?.biasRatio ?? 1))
    : null;

  return {
    currentState,
    currentStateStartIso,
    isHoldingState,
    isUnstable: prediction.isUnstable,
    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,
    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    daySchedule: finalDaySchedule,
    nextTransition,
    expectedOnDurationLabel,
    expectedOffDurationLabel,
    reasoning: prediction.reasoning,
    computedAt: prediction.computedAt,
    learningMode: prediction.learningMode,
    offsetMinutes,
    resyncedAtIso: isResynced ? (resyncPoint?.syncedAtIso ?? null) : null,
    isResynced,
    communitySyncMeta,
    atc,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────
export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode?: 'AUTO' | 'MANUAL',
  anchorStartIso?: string | null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);

  useEffect(() => {
    if (!prediction) {
      setUserPrediction(null);
      return;
    }

    const nowMs = Date.now();
    const mode = transitionMode ?? 'AUTO';

    // ── Build shifted schedule ──────────────────────────────────────────────
    const daySchedule: ShiftedScheduleSlot[] = prediction.daySchedule.map((slot) => {
      const shiftedStartIso = shiftIso(slot.startIso, offsetMinutes);
      const shiftedEndIso = slot.endIso ? shiftIso(slot.endIso, offsetMinutes) : null;
      return {
        ...slot,
        shiftedStartFormatted: fmtTimeLocal(shiftedStartIso),
        shiftedEndFormatted: shiftedEndIso ? fmtTimeLocal(shiftedEndIso) : null,
        isResynced: false,
      };
    });

    // ── Community resync handling ───────────────────────────────────────────
    let currentState = prediction.currentState;
    let currentStateStartIso: string | null = prediction.lastTransitionAt;
    let isResynced = false;
    let communitySyncMeta: CommunitySyncMeta | null = null;

    if (resyncPoint) {
      const reportedState: 'ON' | 'OFF' =
        resyncPoint.reportedState === 'UTILITY_ON' ? 'ON' : 'OFF';
      currentState = reportedState;
      currentStateStartIso = resyncPoint.syncedAtIso;
      isResynced = true;
      communitySyncMeta = {
        reporterName: resyncPoint.reporterName,
        reporterReliability: resyncPoint.reporterReliability,
        syncedAtIso: resyncPoint.syncedAtIso,
        reportedState,
      };
    }

    // ── ATC state ───────────────────────────────────────────────────────────
    const atc = buildATCState({
      prediction,
      offsetMinutes,
      resyncPoint: resyncPoint ?? null,
      transitionMode: mode,
      nowMs,
    });

    // Override transitionMode in atc
    (atc as any).transitionMode = mode;

    // ── POSITIVE_OFFSET_PENDING: determine held state ───────────────────────
    let finalDaySchedule = daySchedule;
    let isHoldingState = false;

    if (atc.mode === 'POSITIVE_OFFSET_PENDING' && atc.scheduledAutoTransitionIso) {
      isHoldingState = true;
      // Find the schedule slot ending at scheduledAutoTransitionIso
      const holdEndIso = atc.scheduledAutoTransitionIso;

      // Use anchorStartIso if provided for the slot start
      const holdStartIso = anchorStartIso ?? prediction.lastTransitionAt ?? new Date(nowMs - 3600_000).toISOString();
      currentStateStartIso = holdStartIso;

      const syntheticSlot: ShiftedScheduleSlot = {
        state: currentState,
        startIso: holdStartIso,
        endIso: holdEndIso,
        startFormatted: fmtTimeLocal(holdStartIso),
        endFormatted: fmtTimeLocal(holdEndIso),
        shiftedStartFormatted: fmtTimeLocal(holdStartIso),
        shiftedEndFormatted: fmtTimeLocal(holdEndIso),
        durationLabel: fmtDurationLabel(Math.abs(offsetMinutes)),
        zone: 'holding',
        isEstimated: false,
        isResynced: false,
      };
      finalDaySchedule = [
        syntheticSlot,
        ...daySchedule.filter(s => new Date(s.startIso).getTime() >= new Date(holdEndIso).getTime()),
      ];
    }

    if (atc.mode === 'UNCERTAIN_ZONE' || atc.mode === 'WAITING_FOR_GROWATT' || atc.mode === 'GRACE_MODE') {
      isHoldingState = true;
    }

    // ── Next transition (shifted) ───────────────────────────────────────────
    let nextTransition: UserPrediction['nextTransition'] = null;
    if (prediction.nextTransition && !prediction.isUnstable) {
      const nt = prediction.nextTransition;
      const shiftedStartMs = new Date(nt.earliestTime).getTime() + offsetMinutes * 60_000;
      const shiftedEndMs = new Date(nt.latestTime).getTime() + offsetMinutes * 60_000;
      const shiftedStartIso = new Date(shiftedStartMs).toISOString();
      const shiftedEndIso = new Date(shiftedEndMs).toISOString();
      const minFromNow = Math.max(0, (shiftedStartMs - nowMs) / 60_000);
      const maxFromNow = Math.max(0, (shiftedEndMs - nowMs) / 60_000);
      const inRangeWindow = nowMs >= shiftedStartMs && nowMs <= shiftedEndMs;

      nextTransition = {
        type: nt.type,
        rangeStartIso: shiftedStartIso,
        rangeEndIso: shiftedEndIso,
        rangeLabel: `${fmtTimeLocal(shiftedStartIso)} — ${fmtTimeLocal(shiftedEndIso)}`,
        minFromNowMin: minFromNow,
        maxFromNowMin: maxFromNow,
        waitLabel: minFromNow < 1 ? 'الآن' : fmtDurationLabel(minFromNow),
        inRangeWindow,
      };
    }

    // ── Duration labels ─────────────────────────────────────────────────────
    const pat = prediction.currentPeriod === 'day' ? prediction.dayPattern : prediction.nightPattern;
    const biasRatio = prediction.apppe?.biasRatio ?? 1;

    const expectedOnDurationLabel = pat?.avgOnMin
      ? fmtDurationLabel(pat.avgOnMin * biasRatio)
      : null;
    const expectedOffDurationLabel = pat?.avgOffMin
      ? fmtDurationLabel(pat.avgOffMin * biasRatio)
      : null;

    setUserPrediction({
      currentState,
      currentStateStartIso,
      isHoldingState,
      isUnstable: prediction.isUnstable,
      crisisMode: prediction.apppe?.crisisActive ?? false,
      crisisReason: prediction.apppe?.crisisReason ?? null,
      confidence: prediction.confidence,
      confidenceLabel: prediction.confidenceLabel,
      stabilityScore: prediction.stabilityScore,
      stabilityLabel: prediction.stabilityLabel,
      daySchedule: finalDaySchedule,
      nextTransition,
      expectedOnDurationLabel,
      expectedOffDurationLabel,
      reasoning: prediction.reasoning,
      computedAt: prediction.computedAt,
      learningMode: prediction.learningMode,
      offsetMinutes,
      resyncedAtIso: isResynced ? (resyncPoint?.syncedAtIso ?? null) : null,
      isResynced,
      communitySyncMeta,
      atc,
    });
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso]);

  return { userPrediction, loading };
}
