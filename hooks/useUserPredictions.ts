/**
 * useUserPredictions — ATC (Adaptive Transition Controller)
 *
 * Applies user DSD offset + community resync point to the raw APPPE v4
 * prediction and computes the seven-mode state machine for the current user.
 *
 * Exported types consumed by:
 *   - app/(user)/index.tsx
 *   - app/(user)/schedule.tsx
 *   - app/(admin)/predictions.tsx  (applyOffsetToPrediction, ScheduleStateMode)
 *   - hooks/useNearbyUsers.ts      (applyOffsetToPrediction, UserPrediction)
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import type { Prediction, ScheduleSlot } from './usePredictions';
import { usePredictions } from './usePredictions';
import type { ResyncPoint } from '../contexts/ResyncContext';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seven operational modes for the ATC state machine.
 *
 * NORMAL               — standard schedule display, no special state
 * PREDICTION_RANGE     — currently inside the predicted transition window
 * UNCERTAIN_ZONE       — elapsed > P75, state hasn't changed yet
 * COMMUNITY_SYNCED     — state is locked to a community report
 * WAITING_FOR_GROWATT  — post-range, waiting for Growatt confirmation
 * GRACE_MODE           — late post-range with widened tolerance
 * POSITIVE_OFFSET_PENDING — Growatt already flipped, waiting for user's scheduled time
 */
export type ScheduleStateMode =
  | 'NORMAL'
  | 'PREDICTION_RANGE'
  | 'UNCERTAIN_ZONE'
  | 'COMMUNITY_SYNCED'
  | 'WAITING_FOR_GROWATT'
  | 'GRACE_MODE'
  | 'POSITIVE_OFFSET_PENDING';

export interface ShiftedScheduleSlot extends ScheduleSlot {
  /** ISO with offset applied (may differ from startIso) */
  shiftedStartIso?: string;
  shiftedEndIso?: string;
  shiftedStartFormatted?: string;
  shiftedEndFormatted?: string;
  /** True when this slot was injected/modified by the community resync */
  isResynced?: boolean;
  /** True when this slot is the synthetic lingering slot for held states */
  isSynthetic?: boolean;
}

export interface CommunitySyncMeta {
  reporterName: string | null;
  reporterReliability: number | null;
  syncedAtIso: string | null;
}

export interface ATCState {
  mode: ScheduleStateMode;
  transitionMode: 'AUTO' | 'MANUAL';
  overrunMinutes: number;
  inValidationWindow: boolean;
  validationWindowRemainingMin: number;
  communityElevated: boolean;
  statusLine: string;
  /** ISO of the scheduled auto-transition time (POSITIVE_OFFSET_PENDING only) */
  scheduledAutoTransitionIso: string | null;
}

export interface UserPrediction {
  /** PERSONAL current state (may differ from Growatt if offset/resynced) */
  currentState: 'ON' | 'OFF';
  currentStateStartIso: string | null;
  /** Time elapsed label for the current state (Arabic) */
  currentStateDurationLabel: string;
  offsetMinutes: number;

  /** Whether this user's schedule has been community-resynced */
  isResynced: boolean;
  resyncedAtIso: string | null;

  /** Whether the state is being held (ATC is in a non-NORMAL, non-COMMUNITY_SYNCED mode) */
  isHoldingState: boolean;

  /** The next expected transition with user offset applied */
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

  /** Confidence and stability from APPPE */
  confidence: number;
  confidenceLabel: string;
  stabilityScore: number;
  stabilityLabel: string;
  isUnstable: boolean;

  /** Crisis info from APPPE v4 */
  crisisMode: boolean;
  crisisReason: string | null;

  /** Expected duration labels for display */
  expectedOffDurationLabel: string | null;
  expectedOnDurationLabel: string | null;

  /** Reasoning lines from APPPE */
  reasoning: string[];
  learningMode: 'prior_only' | 'hybrid' | 'learned';
  computedAt: string | null;

  /** ATC state machine output */
  atc: ATCState;

  /** Community sync metadata (for COMMUNITY_SYNCED mode display) */
  communitySyncMeta: CommunitySyncMeta | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const VALIDATION_WINDOW_MS   = 20 * 60 * 1000;  // 20 min
const GRACE_EXTENSION_MS     = 30 * 60 * 1000;  // 30 min
const YEMEN_TZ               = 'Asia/Aden';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function fmtYemen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: YEMEN_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).replace('AM', ' ص').replace('PM', ' م');
}

function fmtDurAr(min: number): string {
  if (min <= 0) return '0د';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}د`;
  if (m === 0) return h === 1 ? 'ساعة' : h === 2 ? 'ساعتان' : `${h}س`;
  return `${h}س ${m}د`;
}

function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// computeATCState — determines the current ATC operational mode
// ─────────────────────────────────────────────────────────────────────────────

function computeATCState(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: 'AUTO' | 'MANUAL',
  now: Date,
): ATCState {
  const offsetMs = offsetMinutes * 60_000;
  const nowMs    = now.getTime();

  // ── Community synced — highest priority ────────────────────────────────────
  if (resyncPoint) {
    const syncedMs   = new Date(resyncPoint.syncedAtIso).getTime();
    const appliedMs  = new Date(resyncPoint.appliedAtIso).getTime();
    const inWindow   = (nowMs - appliedMs) < VALIDATION_WINDOW_MS;
    const remaining  = Math.max(0, (appliedMs + VALIDATION_WINDOW_MS - nowMs) / 60_000);

    return {
      mode: 'COMMUNITY_SYNCED',
      transitionMode,
      overrunMinutes: 0,
      inValidationWindow: inWindow,
      validationWindowRemainingMin: remaining,
      communityElevated: true,
      statusLine: 'تمت المزامنة مع المجتمع',
      scheduledAutoTransitionIso: null,
    };
  }

  // ── Positive offset: Growatt already flipped, user waits ──────────────────
  // When offsetMinutes > 0, the user's transition is LATER than Growatt.
  // If Growatt has already transitioned (lastTransitionAt is newer than
  // the previous schedule slot end), we enter POSITIVE_OFFSET_PENDING.
  if (offsetMinutes > 0 && prediction.lastTransitionAt) {
    const growattFlippedMs = new Date(prediction.lastTransitionAt).getTime();
    const scheduledMs      = growattFlippedMs + offsetMs;
    if (nowMs < scheduledMs) {
      return {
        mode: 'POSITIVE_OFFSET_PENDING',
        transitionMode,
        overrunMinutes: 0,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        communityElevated: false,
        statusLine: `سيتم التحديث في ${fmtYemen(new Date(scheduledMs).toISOString())}`,
        scheduledAutoTransitionIso: new Date(scheduledMs).toISOString(),
      };
    }
  }

  // ── Derive user-adjusted next transition ──────────────────────────────────
  const nt = prediction.nextTransition;
  if (!nt) {
    return {
      mode: 'NORMAL',
      transitionMode,
      overrunMinutes: 0,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: false,
      statusLine: '',
      scheduledAutoTransitionIso: null,
    };
  }

  const adjustedMin = new Date(nt.earliestTime).getTime() + offsetMs;
  const adjustedMax = new Date(nt.latestTime).getTime() + offsetMs;

  // ── PREDICTION_RANGE: within the transition window ────────────────────────
  if (nowMs >= adjustedMin && nowMs <= adjustedMax) {
    return {
      mode: 'PREDICTION_RANGE',
      transitionMode,
      overrunMinutes: 0,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: true,
      statusLine: 'التغيير محتمل الآن — نطاق التوقع نشط',
      scheduledAutoTransitionIso: null,
    };
  }

  // ── Post-range modes ───────────────────────────────────────────────────────
  if (nowMs > adjustedMax) {
    const overrunMs  = nowMs - adjustedMax;
    const overrunMin = overrunMs / 60_000;

    if (overrunMs < GRACE_EXTENSION_MS) {
      const isUnstable = prediction.isUnstable;
      const mode: ScheduleStateMode = isUnstable ? 'UNCERTAIN_ZONE' : 'WAITING_FOR_GROWATT';
      return {
        mode,
        transitionMode,
        overrunMinutes: overrunMin,
        inValidationWindow: false,
        validationWindowRemainingMin: 0,
        communityElevated: true,
        statusLine: mode === 'UNCERTAIN_ZONE'
          ? `تجاوزت المدة المتوقعة بـ ${Math.round(overrunMin)} دقيقة`
          : 'بانتظار تأكيد الحساس الرئيسي',
        scheduledAutoTransitionIso: null,
      };
    }

    // Grace mode — far past the window
    return {
      mode: 'GRACE_MODE',
      transitionMode,
      overrunMinutes: overrunMin,
      inValidationWindow: false,
      validationWindowRemainingMin: 0,
      communityElevated: true,
      statusLine: 'تأخر غير معتاد — مهلة المزامنة',
      scheduledAutoTransitionIso: null,
    };
  }

  // ── NORMAL: before the prediction window ──────────────────────────────────
  return {
    mode: 'NORMAL',
    transitionMode,
    overrunMinutes: 0,
    inValidationWindow: false,
    validationWindowRemainingMin: 0,
    communityElevated: false,
    statusLine: '',
    scheduledAutoTransitionIso: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// applyOffsetToPrediction — pure function used by admin predictions page
// and useNearbyUsers for displaying per-user adjusted state.
// ─────────────────────────────────────────────────────────────────────────────

export function applyOffsetToPrediction(
  prediction: Prediction,
  offsetMinutes: number,
  resyncPoint?: ResyncPoint | null,
  transitionMode: 'AUTO' | 'MANUAL' = 'AUTO',
  anchorStartIso: string | null = null,
): UserPrediction {
  const now = new Date();
  const offsetMs = offsetMinutes * 60_000;
  const rp = resyncPoint ?? null;

  // ── Determine personal current state ─────────────────────────────────────
  let currentState: 'ON' | 'OFF' = prediction.currentState;
  let currentStateStartIso: string | null = prediction.lastTransitionAt ?? null;

  if (rp) {
    currentState      = rp.syncedState;
    currentStateStartIso = rp.syncedAtIso;
  } else if (offsetMinutes > 0 && prediction.lastTransitionAt) {
    // Positive offset: user state is opposite of Growatt until scheduled time
    const growattFlippedMs  = new Date(prediction.lastTransitionAt).getTime();
    const scheduledMs       = growattFlippedMs + offsetMs;
    if (now.getTime() < scheduledMs) {
      // State is still the PREVIOUS state (opposite of Growatt current)
      currentState     = prediction.currentState === 'ON' ? 'OFF' : 'ON';
      currentStateStartIso = prediction.lastTransitionAt;
    }
  } else if (offsetMinutes < 0 && prediction.lastTransitionAt) {
    // Negative offset: reconciledCycleStartIso is backdated
    const reconciledMs = new Date(prediction.lastTransitionAt).getTime() + offsetMs; // offset is negative
    currentStateStartIso = new Date(reconciledMs).toISOString();
  }

  // Use provided anchorStartIso if present (more accurate)
  if (anchorStartIso) {
    currentStateStartIso = anchorStartIso;
  }

  // ── Build shifted day schedule ─────────────────────────────────────────────
  const shiftedSchedule: ShiftedScheduleSlot[] = prediction.daySchedule.map(slot => {
    const shiftedStartIso = offsetMs !== 0 ? shiftIso(slot.startIso, offsetMs) : slot.startIso;
    const shiftedEndIso   = slot.endIso && offsetMs !== 0 ? shiftIso(slot.endIso, offsetMs) : slot.endIso ?? undefined;
    return {
      ...slot,
      shiftedStartIso,
      shiftedEndIso,
      shiftedStartFormatted: offsetMs !== 0 ? fmtYemen(shiftedStartIso) : undefined,
      shiftedEndFormatted: shiftedEndIso && offsetMs !== 0 ? fmtYemen(shiftedEndIso) : undefined,
      isResynced: false,
    };
  });

  // ── Inject synthetic slot for POSITIVE_OFFSET_PENDING / COMMUNITY_SYNCED ──
  if (rp) {
    // Find the slot matching the synced state and inject it at front
    const syncedStateSlot: ShiftedScheduleSlot = {
      state: rp.syncedState,
      startIso: rp.syncedAtIso,
      endIso: null,
      startFormatted: fmtYemen(rp.syncedAtIso),
      endFormatted: null,
      durationLabel: null,
      zone: 'Community',
      isEstimated: false,
      shiftedStartIso: rp.syncedAtIso,
      shiftedStartFormatted: fmtYemen(rp.syncedAtIso),
      isResynced: true,
      isSynthetic: true,
    };
    shiftedSchedule.unshift(syncedStateSlot);
  } else if (offsetMinutes > 0 && prediction.lastTransitionAt) {
    const growattFlippedMs  = new Date(prediction.lastTransitionAt).getTime();
    const scheduledMs       = growattFlippedMs + offsetMs;
    if (now.getTime() < scheduledMs) {
      // Inject synthetic lingering slot at front (held state until scheduledMs)
      const syntheticSlot: ShiftedScheduleSlot = {
        state: currentState,
        startIso: currentStateStartIso ?? prediction.lastTransitionAt,
        endIso: new Date(scheduledMs).toISOString(),
        startFormatted: fmtYemen(currentStateStartIso ?? prediction.lastTransitionAt),
        endFormatted: fmtYemen(new Date(scheduledMs).toISOString()),
        durationLabel: fmtDurAr(offsetMinutes),
        zone: 'Hold',
        isEstimated: false,
        shiftedStartIso: currentStateStartIso ?? prediction.lastTransitionAt,
        shiftedStartFormatted: fmtYemen(currentStateStartIso ?? prediction.lastTransitionAt),
        shiftedEndIso: new Date(scheduledMs).toISOString(),
        shiftedEndFormatted: fmtYemen(new Date(scheduledMs).toISOString()),
        isSynthetic: true,
      };
      shiftedSchedule.unshift(syntheticSlot);
    }
  }

  // ── Compute ATC state ─────────────────────────────────────────────────────
  const atc = computeATCState(prediction, offsetMinutes, rp, transitionMode, now);

  // ── Build next transition with offset ─────────────────────────────────────
  const nt = prediction.nextTransition;
  let userNextTransition: UserPrediction['nextTransition'] = null;

  if (nt && atc.mode !== 'COMMUNITY_SYNCED' && atc.mode !== 'POSITIVE_OFFSET_PENDING') {
    const rangeStartIso = shiftIso(nt.earliestTime, offsetMs);
    const rangeEndIso   = shiftIso(nt.latestTime, offsetMs);
    const nowMs         = now.getTime();
    const startMs       = new Date(rangeStartIso).getTime();
    const endMs         = new Date(rangeEndIso).getTime();
    const minFromNow    = Math.max(0, (startMs - nowMs) / 60_000);
    const maxFromNow    = Math.max(0, (endMs - nowMs) / 60_000);
    userNextTransition = {
      type: nt.type,
      rangeStartIso,
      rangeEndIso,
      rangeLabel: `${fmtYemen(rangeStartIso)} → ${fmtYemen(rangeEndIso)}`,
      minFromNowMin: minFromNow,
      maxFromNowMin: maxFromNow,
      waitLabel: fmtDurAr(minFromNow),
      inRangeWindow: nowMs >= startMs && nowMs <= endMs,
    };
  }

  // ── Expected duration labels ───────────────────────────────────────────────
  const offRange = prediction.expectedOffRange;
  const onRange  = prediction.expectedOnRange;
  const expectedOffDurationLabel = offRange
    ? `${fmtDurAr(offRange.minMin)} – ${fmtDurAr(offRange.maxMin)}`
    : null;
  const expectedOnDurationLabel = onRange
    ? `${fmtDurAr(onRange.minMin)} – ${fmtDurAr(onRange.maxMin)}`
    : null;

  // ── isHoldingState: ATC has taken over, state is not advancing normally ────
  const holdingModes: ScheduleStateMode[] = [
    'POSITIVE_OFFSET_PENDING', 'UNCERTAIN_ZONE', 'WAITING_FOR_GROWATT',
    'GRACE_MODE', 'PREDICTION_RANGE', 'COMMUNITY_SYNCED',
  ];
  const isHoldingState = holdingModes.includes(atc.mode);

  // ── Community sync metadata ────────────────────────────────────────────────
  const communitySyncMeta: CommunitySyncMeta | null = rp ? {
    reporterName: rp.reporterName ?? null,
    reporterReliability: rp.reporterReliability ?? null,
    syncedAtIso: rp.syncedAtIso,
  } : null;

  return {
    currentState,
    currentStateStartIso,
    currentStateDurationLabel: currentStateStartIso
      ? fmtDurAr(Math.max(0, (now.getTime() - new Date(currentStateStartIso).getTime()) / 60_000))
      : '—',
    offsetMinutes,

    isResynced: !!rp,
    resyncedAtIso: rp?.syncedAtIso ?? null,
    isHoldingState,

    nextTransition: userNextTransition,
    daySchedule: shiftedSchedule,

    confidence: prediction.confidence,
    confidenceLabel: prediction.confidenceLabel,
    stabilityScore: prediction.stabilityScore,
    stabilityLabel: prediction.stabilityLabel,
    isUnstable: prediction.isUnstable,

    crisisMode: prediction.apppe?.crisisActive ?? false,
    crisisReason: prediction.apppe?.crisisReason ?? null,

    expectedOffDurationLabel,
    expectedOnDurationLabel,

    reasoning: prediction.reasoning,
    learningMode: prediction.learningMode,
    computedAt: prediction.computedAt,

    atc,
    communitySyncMeta,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// useUserPredictions hook
// ─────────────────────────────────────────────────────────────────────────────

export function useUserPredictions(
  offsetMinutes: number,
  resyncPoint: ResyncPoint | null,
  transitionMode: 'AUTO' | 'MANUAL' = 'AUTO',
  anchorStartIso: string | null = null,
): { userPrediction: UserPrediction | null; loading: boolean } {
  const { prediction, loading } = usePredictions();
  const [userPrediction, setUserPrediction] = useState<UserPrediction | null>(null);

  // Tick every 30 seconds to re-derive ATC mode as time passes
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Recompute whenever prediction, offset, resync, mode, anchor or time changes
  useEffect(() => {
    if (!prediction) {
      setUserPrediction(null);
      return;
    }
    const up = applyOffsetToPrediction(
      prediction,
      offsetMinutes,
      resyncPoint,
      transitionMode,
      anchorStartIso,
    );
    setUserPrediction(up);
  }, [prediction, offsetMinutes, resyncPoint, transitionMode, anchorStartIso, tick]);

  return { userPrediction, loading };
}
